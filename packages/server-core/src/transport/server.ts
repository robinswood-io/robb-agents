/**
 * WsRpcServer — WebSocket-based RPC server.
 *
 * Owns ALL transport concerns: connection lifecycle, handshake, heartbeat,
 * optional auth, request dispatching, and push routing.
 *
 * Same class used locally (127.0.0.1, no auth) and remotely (0.0.0.0, auth).
 */
import { WebSocketServer, type WebSocket } from "ws";
import { type Server as HttpServer } from "node:http";
import { type Server as HttpsServer } from "node:https";
import { randomUUID } from "node:crypto";
import { isErrorCode, type MessageEnvelope, type PushTarget, type ErrorCode } from "@craft-agent/shared/protocol";
import type { RpcServer, HandlerFn, RequestContext, AuthenticationResult } from "./types";
import { serializeEnvelope } from "./codec";
import type { ClientConnection, PendingInvoke, WsRpcTlsOptions, WsRpcServerOptions } from './server/shared.ts';
import * as serverConnection from './server/connection.ts';
import * as serverLifecycle from './server/lifecycle.ts';
import * as serverDelivery from './server/delivery.ts';
export type { WsRpcTlsOptions, WsRpcServerOptions } from './server/shared.ts';

// ---------------------------------------------------------------------------
// WsRpcServer
// ---------------------------------------------------------------------------
export class WsRpcServer implements RpcServer {
    /** @internal */ public wss: WebSocketServer | null = null;
    /** @internal */ public httpServer: HttpServer | null = null;
    /** @internal */ public httpsServer: HttpsServer | null = null;
    private clients = new Map<string, ClientConnection>();
    private clientByWs = new WeakMap<WebSocket, ClientConnection>();
    private handlers = new Map<string, HandlerFn>();
    private pendingInvokes = new Map<string, PendingInvoke>();
    /** @internal */ public heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private failedHandshakesByIp = new Map<string, {
        count: number;
        windowStart: number;
    }>();
    private _port = 0;
    private _protocol: 'ws' | 'wss' = 'ws';
    /** Recently disconnected clients retained for reconnect replay. */
    private disconnectedClients = new Map<string, {
        client: ClientConnection;
        timer: ReturnType<typeof setTimeout>;
    }>();
    /** @internal */ public readonly host: string;
    /** @internal */ public readonly requestedPort: number;
    /** @internal */ public readonly requireAuth: boolean;
    /** @internal */ public readonly validateToken: ((token: string) => Promise<AuthenticationResult>) | null;
    /** @internal */ public readonly validateSessionCookie: ((cookieHeader: string | null) => Promise<AuthenticationResult>) | null;
    /** @internal */ public readonly allowedSessionCookieOrigins: ReadonlySet<string>;
    private readonly authorizeRequest: WsRpcServerOptions['authorizeRequest'];
    /** @internal */ public readonly requireAuthoritativePrincipal: boolean;
    private readonly serverId: string;
    /** @internal */ public readonly tlsOptions: WsRpcTlsOptions | null;
    /** @internal */ public readonly serverVersion: string;
    /** @internal */ public readonly maxClients: number;
    /** @internal */ public readonly maxPayloadBytes: number;
    private readonly maxInFlightRequestsPerClient: number;
    /** @internal */ public readonly maxEventBufferBytes: number;
    private readonly maxFailedHandshakesPerIp: number;
    /** @internal */ public readonly onClientConnected: WsRpcServerOptions['onClientConnected'];
    /** @internal */ public readonly onClientDisconnected: WsRpcServerOptions['onClientDisconnected'];
    /** @internal */ public readonly httpHandler: WsRpcServerOptions['httpHandler'];
    constructor(opts?: WsRpcServerOptions) {
        this.host = opts?.host ?? '127.0.0.1';
        this.requestedPort = opts?.port ?? 0;
        this.requireAuth = opts?.requireAuth ?? false;
        this.validateToken = opts?.validateToken ?? null;
        this.validateSessionCookie = opts?.validateSessionCookie ?? null;
        this.allowedSessionCookieOrigins = new Set((opts?.allowedSessionCookieOrigins ?? []).map((origin) => (new URL(origin).origin)));
        this.authorizeRequest = opts?.authorizeRequest;
        this.requireAuthoritativePrincipal = opts?.requireAuthoritativePrincipal ?? false;
        this.serverId = opts?.serverId ?? 'local';
        this.serverVersion = opts?.serverVersion ?? '';
        this.tlsOptions = opts?.tls ?? null;
        this.maxClients = opts?.maxClients ?? 50;
        this.maxPayloadBytes = opts?.maxPayloadBytes ?? 8 * 1024 * 1024;
        this.maxInFlightRequestsPerClient = opts?.maxInFlightRequestsPerClient ?? 64;
        this.maxEventBufferBytes = opts?.maxEventBufferBytes ?? 8 * 1024 * 1024;
        this.maxFailedHandshakesPerIp = opts?.maxFailedHandshakesPerIp ?? 15;
        this.onClientConnected = opts?.onClientConnected;
        this.onClientDisconnected = opts?.onClientDisconnected;
        this.httpHandler = opts?.httpHandler;
    }
    /** The actual port the server is listening on (available after listen()). */
    get port(): number {
        return this._port;
    }
    /** The protocol the server is using: 'wss' when TLS is configured, 'ws' otherwise. */
    get protocol(): 'ws' | 'wss' {
        return this._protocol;
    }
    /** Number of currently connected (handshake-completed) clients. */
    getConnectedClientCount(): number {
        return this.clients.size;
    }
    // -------------------------------------------------------------------------
    // RpcServer interface
    // -------------------------------------------------------------------------
    handle<Arguments extends unknown[]>(channel: string, handler: HandlerFn<Arguments>): void {
        if (this.handlers.has(channel)) {
            throw new Error(`Handler already registered for channel: ${channel}`);
        }
        this.handlers.set(channel, handler);
    }
    push(channel: string, target: PushTarget, ...args: unknown[]): void {
        return serverDelivery.push(this, channel, target, ...args);
    }
    hasClientCapability(clientId: string, capability: string): boolean {
        const client = this.clients.get(clientId);
        return !!client && client.capabilities.has(capability);
    }
    findClientsWithCapability(capability: string, opts?: {
        workspaceId?: string;
    }): string[] {
        const results: string[] = [];
        for (const [clientId, client] of this.clients) {
            if (!client.capabilities.has(capability))
                continue;
            if (opts?.workspaceId !== undefined && client.workspaceId !== opts.workspaceId)
                continue;
            results.push(clientId);
        }
        return results;
    }
    invokeClient(clientId: string, channel: string, ...args: unknown[]): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const client = this.clients.get(clientId);
            // Check connection
            if (!client) {
                const err: Error & {
                    code?: string;
                } = new Error(`Client not connected: ${clientId}`);
                err.code = 'CLIENT_DISCONNECTED';
                reject(err);
                return;
            }
            // Check capability
            if (!client.capabilities.has(channel)) {
                const err: Error & {
                    code?: string;
                } = new Error(`Client lacks capability: ${channel}`);
                err.code = 'CAPABILITY_UNAVAILABLE';
                reject(err);
                return;
            }
            const id = randomUUID();
            const timeout = setTimeout(() => {
                this.pendingInvokes.delete(id);
                const err: Error & {
                    code?: string;
                } = new Error(`Client request timeout: ${channel} (30000ms)`);
                err.code = 'CLIENT_REQUEST_TIMEOUT';
                reject(err);
            }, 30000);
            this.pendingInvokes.set(id, { clientId, resolve, reject, timeout });
            const envelope: MessageEnvelope = {
                id,
                type: 'request',
                channel,
                args,
                serverId: this.serverId,
            };
            this.safeSend(client.ws, serializeEnvelope(envelope));
        });
    }
    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------
    /** @internal */ public configureNodeHttpTimeouts(server: HttpServer | HttpsServer): void {
        return serverLifecycle.configureNodeHttpTimeouts(this, server);
    }
    /** @internal */ public isHandshakeIpRateLimited(ip: string): boolean {
        if (this.maxFailedHandshakesPerIp <= 0)
            return false;
        const entry = this.failedHandshakesByIp.get(ip);
        if (!entry)
            return false;
        if (Date.now() - entry.windowStart > 60000) {
            this.failedHandshakesByIp.delete(ip);
            return false;
        }
        return entry.count >= this.maxFailedHandshakesPerIp;
    }
    /** @internal */ public recordFailedHandshake(ip: string): void {
        if (this.maxFailedHandshakesPerIp <= 0)
            return;
        const now = Date.now();
        const existing = this.failedHandshakesByIp.get(ip);
        if (!existing || now - existing.windowStart > 60000) {
            if (!existing && this.failedHandshakesByIp.size >= 4096) {
                const oldestKey = this.failedHandshakesByIp.keys().next().value;
                if (oldestKey !== undefined)
                    this.failedHandshakesByIp.delete(oldestKey);
            }
            this.failedHandshakesByIp.set(ip, { count: 1, windowStart: now });
            return;
        }
        existing.count += 1;
    }
    async listen(): Promise<void> {
        return serverLifecycle.listen(this);
    }
    close(): void {
        return serverLifecycle.close(this);
    }
    // -------------------------------------------------------------------------
    // Connection handling
    // -------------------------------------------------------------------------
    /** @internal */ public onConnection(ws: WebSocket, upgradeRequestCookie: string | null, upgradeRequestOrigin: string | null, upgradeRequestHost: string | null, remoteAddress = 'direct'): void {
        return serverConnection.onConnection(this, ws, upgradeRequestCookie, upgradeRequestOrigin, upgradeRequestHost, remoteAddress);
    }
    /** @internal */ public isSessionCookieOriginAllowed(origin: string | null, host: string | null): boolean {
        return serverConnection.isSessionCookieOriginAllowed(this, origin, host);
    }
    // -------------------------------------------------------------------------
    // Request dispatching
    // -------------------------------------------------------------------------
    /** Server-side timeout for RPC handler execution (ms). */
    private static readonly HANDLER_TIMEOUT_MS = 60000;
    /** @internal */ public async onRequest(client: ClientConnection, envelope: MessageEnvelope): Promise<void> {
        const { channel, id, args } = envelope;
        if (!channel) {
            this.sendResponseError(client.ws, id, undefined, 'CHANNEL_NOT_FOUND', 'Missing channel');
            return;
        }
        const handler = this.handlers.get(channel);
        if (!handler) {
            this.sendResponseError(client.ws, id, channel, 'CHANNEL_NOT_FOUND', `No handler for: ${channel}`);
            return;
        }
        if (this.maxInFlightRequestsPerClient > 0
            && client.inFlightRequests >= this.maxInFlightRequestsPerClient) {
            this.sendResponseError(client.ws, id, channel, 'HANDLER_ERROR', `Too many concurrent in-flight requests (max ${this.maxInFlightRequestsPerClient})`);
            return;
        }
        const ctx: RequestContext = {
            clientId: client.id,
            workspaceId: client.workspaceId,
            webContentsId: client.webContentsId,
            actorId: client.actorId,
            roles: client.roles,
            authorizationGeneration: client.authorizationGeneration,
            allowedWorkspaceIds: client.allowedWorkspaceIds === '*'
                ? '*'
                : [...client.allowedWorkspaceIds],
        };
        client.inFlightRequests += 1;
        try {
            if (this.authorizeRequest && !await this.authorizeRequest(ctx, channel, args ?? [])) {
                this.sendResponseError(client.ws, id, channel, 'AUTH_FAILED', `RPC channel denied: ${channel}`);
                return;
            }
            const result: unknown = await Promise.race([
                Reflect.apply(handler, undefined, [ctx, ...(args ?? [])]),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Handler timeout: ${channel} (${WsRpcServer.HANDLER_TIMEOUT_MS}ms)`)), WsRpcServer.HANDLER_TIMEOUT_MS)),
            ]);
            const response: MessageEnvelope = {
                id,
                type: 'response',
                channel,
                result,
            };
            this.safeSend(client.ws, serializeEnvelope(response));
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const rawCode = (err as {
                code?: unknown;
            } | null)?.code;
            const code: ErrorCode = isErrorCode(rawCode) ? rawCode : 'HANDLER_ERROR';
            this.sendResponseError(client.ws, id, channel, code, message);
        }
        finally {
            client.inFlightRequests = Math.max(0, client.inFlightRequests - 1);
        }
    }
    // -------------------------------------------------------------------------
    // Heartbeat
    // -------------------------------------------------------------------------
    /** @internal */ public startHeartbeat(): void {
        return serverLifecycle.startHeartbeat(this);
    }
    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------
    /** Wire up close + pong handlers for a WebSocket ↔ ClientConnection pair. */
    /** @internal */ public setupClientHandlers(ws: WebSocket, client: ClientConnection): void {
        return serverDelivery.setupClientHandlers(this, ws, client);
    }
    /** Assign a per-client seq, retain the event for replay, and optionally send it immediately. */
    /** @internal */ public bufferAndMaybeSendEvent(client: ClientConnection, channel: string, args: unknown[], timestamp: number, shouldSend: boolean): void {
        return serverDelivery.bufferAndMaybeSendEvent(this, client, channel, args, timestamp, shouldSend);
    }
    /** Evict stale/oversized entries from a client's event buffer via batch splice. */
    /** @internal */ public evictBuffer(client: ClientConnection): void {
        return serverDelivery.evictBuffer(this, client);
    }
    /** @internal */ public matchesTarget(client: ClientConnection, target: PushTarget): boolean {
        switch (target.to) {
            case 'all':
                return target.exclude ? client.id !== target.exclude : true;
            case 'workspace':
                if (target.exclude && client.id === target.exclude)
                    return false;
                return client.workspaceId === target.workspaceId;
            case 'client':
                return client.id === target.clientId;
            default:
                return false;
        }
    }
    /** Update a client's workspaceId (called after SWITCH_WORKSPACE so push routing stays correct). */
    updateClientWorkspace(clientId: string, workspaceId: string): void {
        const client = this.clients.get(clientId);
        if (client) {
            if (client.allowedWorkspaceIds !== '*' && !client.allowedWorkspaceIds.has(workspaceId)) {
                throw new Error(`Workspace access denied for \"${workspaceId}\"`);
            }
            client.workspaceId = workspaceId;
        }
    }
    /** Close every active connection for an actor whose authorization was revoked. */
    disconnectClientsByActor(actorId: string): number {
        for (const [id, entry] of this.disconnectedClients.entries()) {
            if (entry.client.actorId !== actorId)
                continue;
            clearTimeout(entry.timer);
            entry.client.eventBuffer.length = 0;
            entry.client.bufferedBytes = 0;
            this.disconnectedClients.delete(id);
        }
        let disconnected = 0;
        for (const client of this.clients.values()) {
            if (client.actorId !== actorId)
                continue;
            disconnected++;
            client.revoked = true;
            client.eventBuffer.length = 0;
            client.bufferedBytes = 0;
            this.clients.delete(client.id);
            this.clientByWs.delete(client.ws);
            this.rejectPendingInvokesForClient(client.id);
            client.ws.close(4005, 'Authorization revoked');
        }
        return disconnected;
    }
    /** @internal */ public findClientByWs(ws: WebSocket): ClientConnection | undefined {
        return serverDelivery.findClientByWs(this, ws);
    }
    /** Handler/request errors — sent as type:'response' with error field. */
    private sendResponseError(ws: WebSocket, id: string, channel: string | undefined, code: ErrorCode, message: string): void {
        const envelope: MessageEnvelope = {
            id,
            type: 'response',
            ...(channel !== undefined ? { channel: channel } : {}),
            error: { code, message },
        };
        this.safeSend(ws, serializeEnvelope(envelope));
    }
    /** Protocol-level errors only (handshake rejection, version mismatch). May close connection. */
    /** @internal */ public sendError(ws: WebSocket, id: string, code: ErrorCode, message: string): void {
        const envelope: MessageEnvelope = {
            id,
            type: 'error',
            error: { code, message },
        };
        this.safeSend(ws, serializeEnvelope(envelope));
    }
    /** @internal */ public onClientResponse(client: ClientConnection, envelope: MessageEnvelope): void {
        return serverDelivery.onClientResponse(this, client, envelope);
    }
    private rejectPendingInvokesForClient(clientId: string): void {
        for (const [id, pending] of this.pendingInvokes) {
            if (pending.clientId !== clientId)
                continue;
            clearTimeout(pending.timeout);
            const err: Error & {
                code?: string;
            } = new Error(`Client disconnected: ${clientId}`);
            err.code = 'CLIENT_DISCONNECTED';
            pending.reject(err);
            this.pendingInvokes.delete(id);
        }
    }
    private safeSend(ws: WebSocket, data: string): void {
        if (ws.readyState === ws.OPEN) {
            ws.send(data);
        }
    }
}
