import { omitUndefined } from '@craft-agent/shared/utils/json';
/**
 * WsRpcServer — WebSocket-based RPC server.
 *
 * Owns ALL transport concerns: connection lifecycle, handshake, heartbeat,
 * optional auth, request dispatching, and push routing.
 *
 * Same class used locally (127.0.0.1, no auth) and remotely (0.0.0.0, auth).
 */
import { type WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { PROTOCOL_VERSION, type MessageEnvelope } from "@craft-agent/shared/protocol";
import type { AuthenticatedPrincipal, AuthenticationResult } from "../types";
import { serializeEnvelope, deserializeEnvelope } from "../codec";
import type { WsRpcServer } from '../server.ts';
import { transportLog } from './shared.ts';
import type { ClientConnection } from './shared.ts';

export function parseAuthenticatedPrincipal(value: AuthenticationResult): AuthenticatedPrincipal | null {
    if (typeof value !== 'object' || value === null)
        return null;
    if (typeof value.actorId !== 'string' || value.actorId.trim() === '')
        return null;
    if (!Number.isInteger(value.authorizationGeneration) || value.authorizationGeneration < 0)
        return null;
    const workspaceIdsValid = value.allowedWorkspaceIds === '*'
        || (Array.isArray(value.allowedWorkspaceIds)
            && value.allowedWorkspaceIds.every((workspaceId: unknown) => typeof workspaceId === 'string' && workspaceId.trim() !== ''));
    const capabilitiesValid = value.capabilities === '*'
        || (Array.isArray(value.capabilities)
            && value.capabilities.every((capability: unknown) => typeof capability === 'string' && capability.trim() !== ''));
    const rolesValid = Array.isArray(value.roles)
        && value.roles.every((role: unknown) => typeof role === 'string' && role.trim() !== '');
    return workspaceIdsValid && capabilitiesValid && rolesValid ? value : null;
}

export function principalAllowsWorkspace(principal: AuthenticatedPrincipal, workspaceId: string | null): boolean {
    if (workspaceId === null || principal.allowedWorkspaceIds === '*')
        return true;
    return principal.allowedWorkspaceIds.includes(workspaceId);
}

export function authorizedCapabilities(principal: AuthenticatedPrincipal, requestedCapabilities: readonly string[]): Set<string> {
    if (principal.capabilities === '*')
        return new Set(requestedCapabilities);
    const allowed = new Set(principal.capabilities);
    return new Set(requestedCapabilities.filter((capability) => allowed.has(capability)));
}

export function localPrincipal(): AuthenticatedPrincipal {
    return {
        actorId: 'local-owner',
        allowedWorkspaceIds: '*',
        capabilities: '*',
        roles: ['owner'],
        authorizationGeneration: 0,
    };
}

export function legacyAuthenticatedPrincipal(workspaceId: string | null, requestedCapabilities: readonly string[]): AuthenticatedPrincipal {
    return {
        actorId: 'legacy-authenticated',
        allowedWorkspaceIds: workspaceId === null ? [] : [workspaceId],
        capabilities: [...requestedCapabilities],
        roles: [],
        authorizationGeneration: 0,
    };
}

export function onConnection(transportOwner: WsRpcServer, ws: WebSocket, upgradeRequestCookie: string | null, upgradeRequestOrigin: string | null, upgradeRequestHost: string | null, remoteAddress: string): void {
    // Reject if at capacity
    if (transportOwner.maxClients > 0 && transportOwner["clients"].size >= transportOwner.maxClients) {
        transportLog.warn('Connection rejected: at capacity', {
            maxClients: transportOwner.maxClients,
            current: transportOwner["clients"].size,
        });
        ws.close(4008, 'Server at capacity');
        return;
    }
    if (transportOwner.requireAuth && transportOwner.isHandshakeIpRateLimited(remoteAddress)) {
        transportLog.warn('Connection rejected: handshake auth rate limit exceeded', { remoteAddress });
        ws.close(4029, 'Too many authentication attempts');
        return;
    }
    let handshakeCompleted = false;
    let handshakeTimeout: ReturnType<typeof setTimeout> | null = null;
    // Give the client 5 seconds to send a handshake
    handshakeTimeout = setTimeout(() => {
        if (!handshakeCompleted) {
            ws.close(4001, 'Handshake timeout');
        }
    }, 5000);
    ws.on('message', async (raw) => {
        let envelope: MessageEnvelope;
        try {
            envelope = deserializeEnvelope(raw.toString());
        }
        catch {
            ws.close(4002, 'Invalid JSON');
            return;
        }
        if (!handshakeCompleted) {
            if (envelope.type !== 'handshake') {
                ws.close(4003, 'Expected handshake');
                return;
            }
            if (handshakeTimeout) {
                clearTimeout(handshakeTimeout);
                handshakeTimeout = null;
            }
            // Protocol version check (required)
            if (!envelope.protocolVersion || typeof envelope.protocolVersion !== 'string') {
                transportOwner.sendError(ws, envelope.id, 'PROTOCOL_VERSION_UNSUPPORTED', `Missing protocolVersion. Server protocol ${PROTOCOL_VERSION}`);
                ws.close(4004, 'Protocol version unsupported');
                return;
            }
            const clientMajor = parseInt(envelope.protocolVersion.split('.')[0] ?? '0', 10);
            const serverMajor = parseInt(PROTOCOL_VERSION.split('.')[0] ?? '0', 10);
            if (clientMajor !== serverMajor) {
                transportOwner.sendError(ws, envelope.id, 'PROTOCOL_VERSION_UNSUPPORTED', `Server protocol ${PROTOCOL_VERSION}, client ${envelope.protocolVersion}`);
                ws.close(4004, 'Protocol version unsupported');
                return;
            }
            const requestedWorkspaceId = envelope.workspaceId ?? null;
            const requestedCapabilities = envelope.clientCapabilities ?? [];
            let principal = localPrincipal();
            // Auth check — bearer token OR session cookie (web UI)
            if (transportOwner.requireAuth) {
                let authenticationResult: AuthenticationResult = false;
                // 1. Try bearer token (standard path)
                if (envelope.token && transportOwner.validateToken) {
                    try {
                        authenticationResult = await transportOwner.validateToken(envelope.token);
                    }
                    catch (error) {
                        transportLog.warn('Bearer token validation failed', {
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                }
                // 2. Fallback: try session cookie from HTTP upgrade request (web UI path)
                if (authenticationResult === false
                    && transportOwner.validateSessionCookie
                    && upgradeRequestCookie
                    && transportOwner.isSessionCookieOriginAllowed(upgradeRequestOrigin, upgradeRequestHost)) {
                    try {
                        authenticationResult = await transportOwner.validateSessionCookie(upgradeRequestCookie);
                    }
                    catch (error) {
                        transportLog.warn('Session cookie validation failed', {
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                }
                const authoritativePrincipal = parseAuthenticatedPrincipal(authenticationResult);
                if (authoritativePrincipal) {
                    principal = authoritativePrincipal;
                }
                else if (authenticationResult === true && !transportOwner.requireAuthoritativePrincipal) {
                    principal = legacyAuthenticatedPrincipal(requestedWorkspaceId, requestedCapabilities);
                }
                else {
                    transportOwner.recordFailedHandshake(remoteAddress);
                    const reason = envelope.token ? 'Invalid token' : 'Token required';
                    transportOwner.sendError(ws, envelope.id, 'AUTH_FAILED', reason);
                    ws.close(4005, 'Auth failed');
                    return;
                }
                if (!principalAllowsWorkspace(principal, requestedWorkspaceId)) {
                    transportOwner.recordFailedHandshake(remoteAddress);
                    transportOwner.sendError(ws, envelope.id, 'AUTH_FAILED', 'Workspace access denied');
                    ws.close(4005, 'Auth failed');
                    return;
                }
            }
            const capabilities = authorizedCapabilities(principal, requestedCapabilities);
            // ── Reconnect attempt ──
            if (envelope.reconnectClientId && envelope.lastSeq != null) {
                const entry = transportOwner["disconnectedClients"].get(envelope.reconnectClientId);
                if (entry) {
                    const prevClient = entry.client;
                    // Identity must match the server-authorized actor and scope generation.
                    const identityMatch = prevClient.workspaceId === requestedWorkspaceId &&
                        prevClient.webContentsId === (envelope.webContentsId ?? null) &&
                        prevClient.actorId === principal.actorId &&
                        prevClient.authorizationGeneration === principal.authorizationGeneration;
                    if (identityMatch) {
                        // Valid reconnect — prepare client state but do NOT add to
                        // this.clients yet. The client stays in disconnectedClients
                        // during replay so that push() can't interleave new events
                        // between replayed ones. (Currently safe due to Node.js
                        // single-threading, but this ordering makes the invariant
                        // explicit and future-proof.)
                        clearTimeout(entry.timer);
                        prevClient.ws = ws;
                        prevClient.alive = true;
                        prevClient.missedPongs = 0;
                        prevClient.capabilities = capabilities;
                        prevClient.roles = [...principal.roles];
                        prevClient.allowedWorkspaceIds = principal.allowedWorkspaceIds === '*'
                            ? '*'
                            : new Set(principal.allowedWorkspaceIds);
                        handshakeCompleted = true;
                        // Determine replay vs stale using the per-client delivery sequence.
                        // Retained buffers continue collecting events while the client is disconnected,
                        // but TTL eviction still applies during the reconnect window.
                        transportOwner.evictBuffer(prevClient);
                        const lastSeq = envelope.lastSeq as number;
                        const hasMissedEvents = lastSeq < prevClient.lastSentSeq;
                        const firstBufferedSeq = prevClient.eventBuffer[0]?.seq;
                        const canReplay = !hasMissedEvents
                            ? true
                            : firstBufferedSeq != null && lastSeq >= firstBufferedSeq - 1;
                        if (canReplay) {
                            const replayEvents = prevClient.eventBuffer.filter(e => e.seq > lastSeq);
                            const ack: MessageEnvelope = omitUndefined<MessageEnvelope>({
                                id: envelope.id,
                                type: 'handshake_ack',
                                protocolVersion: PROTOCOL_VERSION,
                                serverVersion: transportOwner.serverVersion || undefined,
                                clientId: prevClient.id,
                                registeredChannels: [...transportOwner["handlers"].keys()],
                                reconnected: true,
                            });
                            transportOwner["safeSend"](ws, serializeEnvelope(ack));
                            // Replay missed events in order
                            for (const event of replayEvents) {
                                transportOwner["safeSend"](ws, event.data);
                            }
                            transportLog.info('Client reconnected with replay', {
                                clientId: prevClient.id,
                                replayedCount: replayEvents.length,
                                lastSeq,
                            });
                        }
                        else {
                            // Buffer evicted — client must full-refresh
                            const ack: MessageEnvelope = omitUndefined<MessageEnvelope>({
                                id: envelope.id,
                                type: 'handshake_ack',
                                protocolVersion: PROTOCOL_VERSION,
                                serverVersion: transportOwner.serverVersion || undefined,
                                clientId: prevClient.id,
                                registeredChannels: [...transportOwner["handlers"].keys()],
                                reconnected: true,
                                stale: true,
                            });
                            transportOwner["safeSend"](ws, serializeEnvelope(ack));
                            transportLog.info('Client reconnected as stale', {
                                clientId: prevClient.id,
                                lastSeq,
                                firstBufferedSeq,
                                lastSentSeq: prevClient.lastSentSeq,
                            });
                        }
                        // Atomic state transition: move from disconnected → active
                        // AFTER replay is complete so push() can't target this client mid-replay.
                        transportOwner["disconnectedClients"].delete(envelope.reconnectClientId);
                        transportOwner["clients"].set(prevClient.id, prevClient);
                        transportOwner["clientByWs"].set(ws, prevClient);
                        transportOwner.setupClientHandlers(ws, prevClient);
                        transportOwner.onClientConnected?.({
                            clientId: prevClient.id,
                            webContentsId: prevClient.webContentsId,
                            workspaceId: prevClient.workspaceId,
                            capabilities: [...prevClient.capabilities],
                            actorId: prevClient.actorId,
                            roles: [...prevClient.roles],
                            authorizationGeneration: prevClient.authorizationGeneration,
                            allowedWorkspaceIds: prevClient.allowedWorkspaceIds === '*'
                                ? '*'
                                : [...prevClient.allowedWorkspaceIds],
                        });
                        return;
                    }
                    // Identity mismatch — fall through to fresh connect
                    transportLog.warn('Reconnect identity mismatch', {
                        reconnectClientId: envelope.reconnectClientId,
                    });
                }
                // reconnectClientId not found — fall through to fresh connect
            }
            // ── Normal fresh connect ──
            const clientId = randomUUID();
            const client: ClientConnection = {
                id: clientId,
                ws,
                workspaceId: requestedWorkspaceId,
                webContentsId: envelope.webContentsId ?? null,
                capabilities,
                actorId: principal.actorId,
                roles: [...principal.roles],
                authorizationGeneration: principal.authorizationGeneration,
                allowedWorkspaceIds: principal.allowedWorkspaceIds === '*'
                    ? '*'
                    : new Set(principal.allowedWorkspaceIds),
                missedPongs: 0,
                alive: true,
                eventBuffer: [],
                bufferedBytes: 0,
                inFlightRequests: 0,
                lastAckedSeq: 0,
                lastSentSeq: 0,
            };
            transportOwner["clients"].set(clientId, client);
            transportOwner["clientByWs"].set(ws, client);
            handshakeCompleted = true;
            // Send handshake_ack
            const ack: MessageEnvelope = omitUndefined<MessageEnvelope>({
                id: envelope.id,
                type: 'handshake_ack',
                protocolVersion: PROTOCOL_VERSION,
                serverVersion: transportOwner.serverVersion || undefined,
                clientId,
                registeredChannels: [...transportOwner["handlers"].keys()],
            });
            transportOwner["safeSend"](ws, serializeEnvelope(ack));
            // Notify lifecycle listener
            transportLog.info('Client connected', {
                clientId,
                webContentsId: client.webContentsId,
                workspaceId: client.workspaceId,
            });
            transportOwner.onClientConnected?.({
                clientId,
                webContentsId: client.webContentsId,
                workspaceId: client.workspaceId,
                capabilities: [...client.capabilities],
                actorId: client.actorId,
                roles: [...client.roles],
                authorizationGeneration: client.authorizationGeneration,
                allowedWorkspaceIds: client.allowedWorkspaceIds === '*'
                    ? '*'
                    : [...client.allowedWorkspaceIds],
            });
            transportOwner.setupClientHandlers(ws, client);
            return;
        }
        // Post-handshake: find the client for this ws
        const client = transportOwner.findClientByWs(ws);
        if (!client) {
            ws.close(4006, 'Unknown client');
            return;
        }
        if (envelope.type === 'request') {
            await transportOwner.onRequest(client, envelope);
        }
        else if (envelope.type === 'response') {
            transportOwner.onClientResponse(client, envelope);
        }
        else if (envelope.type === 'sequence_ack') {
            const ackSeq = envelope.lastSeq;
            if (typeof ackSeq === 'number' && ackSeq > client.lastAckedSeq) {
                client.lastAckedSeq = ackSeq;
                // Evict acknowledged events
                const buf = client.eventBuffer;
                let removeCount = 0;
                let removedBytes = 0;
                while (removeCount < buf.length && buf[removeCount]!.seq <= ackSeq) {
                    removedBytes += buf[removeCount]!.bytes;
                    removeCount++;
                }
                if (removeCount > 0) {
                    buf.splice(0, removeCount);
                    client.bufferedBytes = Math.max(0, client.bufferedBytes - removedBytes);
                }
            }
        }
    });
    ws.on('error', () => {
        // Connection errors are handled by the close event
    });
}

export function isSessionCookieOriginAllowed(transportOwner: WsRpcServer, origin: string | null, host: string | null): boolean {
    if (!origin)
        return false;
    try {
        const normalizedOrigin = new URL(origin).origin;
        if (transportOwner.allowedSessionCookieOrigins.size > 0) {
            return transportOwner.allowedSessionCookieOrigins.has(normalizedOrigin);
        }
        if (!host)
            return false;
        const expectedProtocol = transportOwner.tlsOptions ? 'https' : 'http';
        return normalizedOrigin === new URL(`${expectedProtocol}://${host}`).origin;
    }
    catch {
        return false;
    }
}
