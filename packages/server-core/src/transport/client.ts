import { omitUndefined } from '@craft-agent/shared/utils/json';
/**
 * WsRpcClient — WebSocket-based RPC client.
 *
 * Used in both renderer (browser WebSocket) and Node.js contexts.
 * Handles handshake, request/response correlation, event subscriptions,
 * and automatic reconnection with exponential backoff.
 *
 * Extracted to server-core so any package (subprocesses, services, bridges)
 * can act as an RPC client without depending on the Electron app layer.
 */
import { REQUEST_TIMEOUT_MS, type MessageEnvelope } from "@craft-agent/shared/protocol";
import type { AnyEventListener, CapabilityHandler, RpcClient, RpcListener } from "./types";
import { serializeEnvelope } from "./codec";
import type { PendingRequest, TransportMode, TransportConnectionErrorKind, TransportConnectionError, TransportConnectionState, WsRpcClientOptions } from './client/shared.ts';
import * as clientConnection from './client/connection.ts';
import * as clientMessages from './client/messages.ts';
export type { TransportMode, TransportConnectionStatus, TransportConnectionErrorKind, TransportConnectionError, TransportCloseInfo, TransportConnectionState, WsRpcClientOptions } from './client/shared.ts';

// ---------------------------------------------------------------------------
// WsRpcClient
// ---------------------------------------------------------------------------
export type RpcWebSocket = WebSocket | import('ws').WebSocket;

export class WsRpcClient implements RpcClient {
    private ws: RpcWebSocket | null = null;
    private pending = new Map<string, PendingRequest>();
    private listeners = new Map<string, Set<RpcListener>>();
    private capabilityHandlers = new Map<string, CapabilityHandler>();
    private connectionStateListeners = new Set<(state: TransportConnectionState) => void>();
    private anyEventListeners = new Set<AnyEventListener>();
    /** @internal */ public clientId: string | null = null;
    private _serverVersion: string | null = null;
    private connected = false;
    /** @internal */ public reconnectAttempt = 0;
    /** @internal */ public lastSeenSeq = 0;
    /** @internal */ public ackTimer: ReturnType<typeof setInterval> | null = null;
    /** @internal */ public pendingReconnect: {
        clientId: string;
        lastSeq: number;
    } | null = null;
    /** @internal */ public currentHandshakeWasReconnect = false;
    /** @internal */ public manualReconnectRequested = false;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    /** @internal */ public connectTimer: ReturnType<typeof setTimeout> | null = null;
    /** @internal */ public backoffResetTimer: ReturnType<typeof setTimeout> | null = null;
    private destroyed = false;
    /** Set when server sends shuttingDown — prevents reconnection attempts. */
    /** @internal */ public permanentlyClosed = false;
    /** @internal */ public connectStarted = false;
    private connectError: Error | null = null;
    private readyPromise: Promise<void> | null = null;
    /** @internal */ public resolveReady: (() => void) | null = null;
    private rejectReady: ((error: Error) => void) | null = null;
    private connectionState: TransportConnectionState;
    private serverChannels: Set<string> | null = null;
    private readonly url: string;
    /** @internal */ public workspaceId: string | undefined;
    /** @internal */ public readonly webContentsId: number | undefined;
    /** @internal */ public readonly token: string | undefined;
    /** @internal */ public readonly clientCapabilities: string[];
    private readonly requestTimeout: number;
    /** @internal */ public readonly maxReconnectDelay: number;
    /** @internal */ public readonly autoReconnect: boolean;
    /** @internal */ public readonly connectTimeout: number;
    private readonly mode: TransportMode;
    /** @internal */ public readonly tlsRejectUnauthorized: boolean;
    constructor(url: string, opts?: WsRpcClientOptions) {
        this.url = url;
        this.workspaceId = opts?.workspaceId;
        this.webContentsId = opts?.webContentsId;
        this.token = opts?.token;
        this.clientCapabilities = opts?.clientCapabilities ?? [];
        this.requestTimeout = opts?.requestTimeout ?? REQUEST_TIMEOUT_MS;
        this.maxReconnectDelay = opts?.maxReconnectDelay ?? 30000;
        this.autoReconnect = opts?.autoReconnect ?? true;
        this.connectTimeout = opts?.connectTimeout ?? 10000;
        this.mode = opts?.mode ?? this.inferMode(url);
        this.tlsRejectUnauthorized = opts?.tlsRejectUnauthorized ?? true;
        this.connectionState = {
            mode: this.mode,
            status: 'idle',
            url: this.url,
            attempt: 0,
            updatedAt: Date.now(),
        };
    }
    // -------------------------------------------------------------------------
    // RpcClient interface
    // -------------------------------------------------------------------------
    async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
        await this.ensureConnected(channel);
        return await new Promise((resolve, reject) => {
            if (!this.connected || !this.ws) {
                reject(new Error(`Not connected (channel: ${channel})`));
                return;
            }
            const id = crypto.randomUUID();
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Request timeout: ${channel} (${this.requestTimeout}ms)`));
            }, this.requestTimeout);
            this.pending.set(id, { resolve, reject, timeout });
            const envelope: MessageEnvelope = {
                id,
                type: 'request',
                channel,
                args,
            };
            if (!this.trySendEnvelope(this.ws, envelope)) {
                this.pending.delete(id);
                clearTimeout(timeout);
                reject(new Error(`Not connected (channel: ${channel})`));
            }
        });
    }
    on<Arguments extends unknown[]>(channel: string, callback: RpcListener<Arguments>): () => void {
        let set = this.listeners.get(channel);
        if (!set) {
            set = new Set();
            this.listeners.set(channel, set);
        }
        set.add(callback);
        return () => {
            set!.delete(callback);
            if (set!.size === 0) {
                this.listeners.delete(channel);
            }
        };
    }
    handleCapability<Arguments extends unknown[]>(channel: string, handler: CapabilityHandler<Arguments>): void {
        this.capabilityHandlers.set(channel, handler);
    }
    /**
     * Check whether the server registered a handler for a given channel.
     * Returns true if the server advertised the channel in handshake_ack,
     * or if the server didn't advertise channels at all (backwards compat).
     */
    isChannelAvailable(channel: string): boolean {
        if (!this.serverChannels)
            return true; // server didn't advertise — assume available
        return this.serverChannels.has(channel);
    }
    /** Server version from handshake_ack (null if server didn't send one / not yet connected). */
    getServerVersion(): string | null {
        return this._serverVersion;
    }
    getConnectionState(): TransportConnectionState {
        return omitUndefined<TransportConnectionState>({
            ...this.connectionState,
            lastError: this.connectionState.lastError ? { ...this.connectionState.lastError } : undefined,
            lastClose: this.connectionState.lastClose ? { ...this.connectionState.lastClose } : undefined,
        });
    }
    onConnectionStateChanged(callback: (state: TransportConnectionState) => void): () => void {
        this.connectionStateListeners.add(callback);
        callback(this.getConnectionState());
        return () => {
            this.connectionStateListeners.delete(callback);
        };
    }
    /**
     * Update the workspace included in subsequent reconnect handshakes. The
     * caller must first have the active server connection accept the same
     * workspace switch, so a failed RPC can never alter reconnect identity.
     */
    setWorkspaceId(workspaceId: string | undefined): void {
        this.workspaceId = workspaceId;
    }
    /** Subscribe to all push events regardless of channel. Used by RemoteClientBridge for event forwarding. */
    onAnyEvent<Arguments extends unknown[]>(callback: AnyEventListener<Arguments>): () => void {
        this.anyEventListeners.add(callback);
        return () => {
            this.anyEventListeners.delete(callback);
        };
    }
    /** Emit a synthetic __transport:reconnected event. Used by RoutedClient after workspace swap to trigger stale recovery. */
    emitReconnected(isStale: boolean): void {
        return clientMessages.emitReconnected(this, isStale);
    }
    reconnectNow(): void {
        return clientConnection.reconnectNow(this);
    }
    // -------------------------------------------------------------------------
    // Connection lifecycle
    // -------------------------------------------------------------------------
    /**
     * Create a WebSocket instance. In Node.js (main process), uses the `ws` library
     * to support TLS options (e.g. rejectUnauthorized for self-signed certs).
     * In the renderer (browser), falls back to the global WebSocket.
     */
    /** @internal */ public createWebSocket(url: string): RpcWebSocket {
        return clientConnection.createWebSocket(this, url);
    }
    connect(): void {
        return clientConnection.connect(this);
    }
    destroy(): void {
        return clientConnection.destroy(this);
    }
    get isConnected(): boolean {
        return this.connected;
    }
    // -------------------------------------------------------------------------
    // Message handling
    // -------------------------------------------------------------------------
    /** @internal */ public onMessage(raw: string): void {
        return clientMessages.onMessage(this, raw);
    }
    /** @internal */ public async onServerRequest(envelope: MessageEnvelope): Promise<void> {
        return clientMessages.onServerRequest(this, envelope);
    }
    // -------------------------------------------------------------------------
    // Reconnection
    // -------------------------------------------------------------------------
    /** @internal */ public onDisconnect(closeEvent?: {
        code?: number;
        reason?: string;
        wasClean?: boolean;
    }): void {
        return clientConnection.onDisconnect(this, closeEvent);
    }
    /** @internal */ public scheduleReconnect(): void {
        return clientConnection.scheduleReconnect(this);
    }
    /** @internal */ public scheduleBackoffReset(): void {
        return clientConnection.scheduleBackoffReset(this);
    }
    /** Best-effort send that skips closing/closed sockets and swallows send races. */
    private trySendEnvelope(ws: { readyState: number; OPEN: number; send(data: string): void } | null, envelope: MessageEnvelope): boolean {
        if (!ws || ws.readyState !== ws.OPEN)
            return false;
        try {
            ws.send(serializeEnvelope(envelope));
            return true;
        }
        catch {
            return false;
        }
    }
    /** Periodically send sequence_ack so server can evict acknowledged events. */
    /** @internal */ public startAckTimer(): void {
        return clientMessages.startAckTimer(this);
    }
    /** @internal */ public createReadyPromise(): void {
        this.readyPromise = new Promise<void>((resolve, reject) => {
            this.resolveReady = resolve;
            this.rejectReady = reject;
        });
        // Handshake failures may happen before any invoke() awaits readiness.
        // Attach a noop catch to avoid noisy unhandled rejection warnings.
        this.readyPromise.catch(() => { });
    }
    /** @internal */ public failReady(error: Error): void {
        if (!this.rejectReady)
            return;
        this.rejectReady(error);
        this.resolveReady = null;
        this.rejectReady = null;
        this.readyPromise = null;
    }
    private async ensureConnected(channel: string): Promise<void> {
        if (this.destroyed) {
            throw new Error(`Client destroyed (channel: ${channel})`);
        }
        if (this.connected && this.ws)
            return;
        // If a reconnect is already scheduled or in progress, await it instead of
        // canceling the backoff timer and forcing a new attempt. This prevents
        // concurrent RPC calls from resetting the exponential backoff.
        if (this.readyPromise || this.reconnectTimer) {
            const ready = this.readyPromise;
            if (!ready) {
                // Reconnect timer is pending but no readyPromise yet — wait for the
                // timer to fire and produce one. Throw so caller can retry.
                throw this.connectError ?? new Error(`Not connected (channel: ${channel})`);
            }
            try {
                await ready;
            }
            catch (error) {
                throw error instanceof Error ? error : new Error(`Not connected (channel: ${channel})`);
            }
            if (!this.connected || !this.ws) {
                throw new Error(`Not connected (channel: ${channel})`);
            }
            return;
        }
        // No connection in progress and no reconnect scheduled — start one
        this.connect();
        const ready = this.readyPromise;
        if (!ready) {
            throw this.connectError ?? new Error(`Not connected (channel: ${channel})`);
        }
        try {
            await ready;
        }
        catch (error) {
            throw error instanceof Error ? error : new Error(`Not connected (channel: ${channel})`);
        }
        if (!this.connected || !this.ws) {
            throw new Error(`Not connected (channel: ${channel})`);
        }
    }
    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------
    private inferMode(url: string): TransportMode {
        if (url.startsWith('ws://127.0.0.1') || url.startsWith('ws://localhost')) {
            return 'local';
        }
        return 'remote';
    }
    /** @internal */ public setConnectionState(partial: Omit<Partial<TransportConnectionState>, 'mode' | 'url' | 'updatedAt'>): void {
        this.connectionState = {
            ...this.connectionState,
            ...partial,
            mode: this.mode,
            url: this.url,
            updatedAt: Date.now(),
        };
        const snapshot = this.getConnectionState();
        for (const cb of this.connectionStateListeners) {
            try {
                cb(snapshot);
            }
            catch {
                // Listener failures must not break transport.
            }
        }
    }
    /** @internal */ public createConnectionError(kind: TransportConnectionErrorKind, message: string, code?: string): Error {
        const err: Error & {
            kind?: TransportConnectionErrorKind;
            code?: string;
        } = new Error(message);
        err.kind = kind;
        if (code)
            err.code = code;
        return err;
    }
    /** @internal */ public toErrorState(err: Error & {
        code?: unknown;
        kind?: unknown;
    }): TransportConnectionError {
        const code = err.code ? String(err.code) : undefined;
        const value = err.kind;
        const kind = value === 'auth' || value === 'protocol' || value === 'timeout'
            || value === 'network' || value === 'server' || value === 'unknown'
            ? value
            : this.classifyErrorKindFromCode(code);
        return {
            kind,
            message: err.message,
            ...(code !== undefined ? { code: code } : {}),
        };
    }
    private classifyErrorKindFromCode(code?: unknown): TransportConnectionErrorKind {
        const normalized = typeof code === 'string' ? code.toUpperCase() : '';
        if (normalized === 'AUTH_FAILED')
            return 'auth';
        if (normalized === 'PROTOCOL_VERSION_UNSUPPORTED')
            return 'protocol';
        if (normalized === 'HANDSHAKE_TIMEOUT' || normalized === 'REQUEST_TIMEOUT' || normalized === 'CLIENT_REQUEST_TIMEOUT') {
            return 'timeout';
        }
        if (normalized.startsWith('WS_CLOSE_')) {
            const closeCode = parseInt(normalized.slice('WS_CLOSE_'.length), 10);
            return this.classifyErrorKindFromCloseCode(closeCode);
        }
        if (normalized === 'WS_ERROR')
            return 'network';
        if (normalized === 'CHANNEL_NOT_FOUND' || normalized === 'HANDLER_ERROR')
            return 'server';
        return 'unknown';
    }
    private classifyErrorKindFromCloseCode(code?: number): TransportConnectionErrorKind {
        if (!code)
            return 'unknown';
        if (code === 4005)
            return 'auth';
        if (code === 4004)
            return 'protocol';
        if (code === 4001)
            return 'timeout';
        // 1006 = abnormal close / network interruption in browsers.
        if (code === 1006 || code === 1001)
            return 'network';
        return 'unknown';
    }
}
