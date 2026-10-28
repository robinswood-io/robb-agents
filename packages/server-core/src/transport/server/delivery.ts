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
import { EVENT_BUFFER_MAX_SIZE, EVENT_BUFFER_TTL_MS, DISCONNECTED_CLIENT_TTL_MS, type MessageEnvelope, type PushTarget } from "@craft-agent/shared/protocol";
import { serializeEnvelope } from "../codec";
import type { WsRpcServer } from '../server.ts';
import { transportLog } from './shared.ts';
import type { ClientConnection } from './shared.ts';

export function push(transportOwner: WsRpcServer, channel: string, target: PushTarget, ...args: unknown[]): void {
    if (transportOwner["clients"].size === 0 && transportOwner["disconnectedClients"].size === 0)
        return;
    const timestamp = Date.now();
    if (target.to === 'client') {
        const activeClient = transportOwner["clients"].get(target.clientId);
        if (activeClient) {
            transportOwner.bufferAndMaybeSendEvent(activeClient, channel, args, timestamp, true);
            return;
        }
        const disconnectedEntry = transportOwner["disconnectedClients"].get(target.clientId);
        if (disconnectedEntry) {
            transportOwner.bufferAndMaybeSendEvent(disconnectedEntry.client, channel, args, timestamp, false);
        }
        return;
    }
    for (const client of transportOwner["clients"].values()) {
        if (!transportOwner.matchesTarget(client, target))
            continue;
        transportOwner.bufferAndMaybeSendEvent(client, channel, args, timestamp, true);
    }
    for (const { client } of transportOwner["disconnectedClients"].values()) {
        if (!transportOwner.matchesTarget(client, target))
            continue;
        transportOwner.bufferAndMaybeSendEvent(client, channel, args, timestamp, false);
    }
}

export function setupClientHandlers(transportOwner: WsRpcServer, ws: WebSocket, client: ClientConnection): void {
    ws.on('close', () => {
        transportLog.info('Client disconnected', { clientId: client.id });
        transportOwner["clients"].delete(client.id);
        if (!client.revoked) {
            // Retain buffer for potential reconnect
            const timer = setTimeout(() => {
                transportOwner["disconnectedClients"].delete(client.id);
            }, DISCONNECTED_CLIENT_TTL_MS);
            transportOwner["disconnectedClients"].set(client.id, { client, timer });
            // Cap disconnectedClients to prevent unbounded growth
            if (transportOwner["disconnectedClients"].size > 50) {
                const oldestKey = transportOwner["disconnectedClients"].keys().next().value;
                if (oldestKey) {
                    const oldest = transportOwner["disconnectedClients"].get(oldestKey);
                    if (oldest)
                        clearTimeout(oldest.timer);
                    transportOwner["disconnectedClients"].delete(oldestKey);
                }
            }
        }
        transportOwner["rejectPendingInvokesForClient"](client.id);
        transportOwner.onClientDisconnected?.(client.id);
    });
    ws.on('pong', () => {
        client.alive = true;
        client.missedPongs = 0;
    });
}

export function bufferAndMaybeSendEvent(transportOwner: WsRpcServer, client: ClientConnection, channel: string, args: unknown[], timestamp: number, shouldSend: boolean): void {
    client.lastSentSeq += 1;
    const seq = client.lastSentSeq;
    const envelope: MessageEnvelope = {
        id: randomUUID(),
        type: 'event',
        channel,
        args,
        serverId: transportOwner["serverId"],
        seq,
    };
    const data = serializeEnvelope(envelope);
    const bytes = Buffer.byteLength(data, 'utf8');
    client.eventBuffer.push({ seq, data, bytes, timestamp });
    client.bufferedBytes += bytes;
    transportOwner.evictBuffer(client);
    if (shouldSend) {
        transportOwner["safeSend"](client.ws, data);
    }
}

export function evictBuffer(transportOwner: WsRpcServer, client: ClientConnection): void {
    const buf = client.eventBuffer;
    if (buf.length === 0)
        return;
    const now = Date.now();
    let removeCount = 0;
    let removedBytes = 0;
    // Evict by TTL
    while (removeCount < buf.length &&
        now - buf[removeCount]!.timestamp > EVENT_BUFFER_TTL_MS) {
        removedBytes += buf[removeCount]!.bytes;
        removeCount++;
    }
    // Evict by count (keep at most EVENT_BUFFER_MAX_SIZE after TTL eviction)
    const remaining = buf.length - removeCount;
    if (remaining > EVENT_BUFFER_MAX_SIZE) {
        const extra = remaining - EVENT_BUFFER_MAX_SIZE;
        for (let i = 0; i < extra; i++) {
            removedBytes += buf[removeCount + i]!.bytes;
        }
        removeCount += extra;
    }
    // Evict by byte cap (keep at least the newest event if single event exceeds cap)
    if (transportOwner.maxEventBufferBytes > 0) {
        while (removeCount < buf.length - 1 &&
            client.bufferedBytes - removedBytes > transportOwner.maxEventBufferBytes) {
            removedBytes += buf[removeCount]!.bytes;
            removeCount++;
        }
    }
    // Single splice instead of O(n) shift loop
    if (removeCount > 0) {
        buf.splice(0, removeCount);
        client.bufferedBytes = Math.max(0, client.bufferedBytes - removedBytes);
    }
}

export function findClientByWs(transportOwner: WsRpcServer, ws: WebSocket): ClientConnection | undefined {
    const fast = transportOwner["clientByWs"].get(ws);
    if (fast && transportOwner["clients"].has(fast.id))
        return fast;
    for (const client of transportOwner["clients"].values()) {
        if (client.ws === ws) {
            transportOwner["clientByWs"].set(ws, client);
            return client;
        }
    }
    return undefined;
}

export function onClientResponse(transportOwner: WsRpcServer, client: ClientConnection, envelope: MessageEnvelope): void {
    const pending = transportOwner["pendingInvokes"].get(envelope.id);
    if (!pending)
        return;
    if (pending.clientId !== client.id) {
        transportLog.warn('Ignored spoofed client response for pending invoke', {
            invokeId: envelope.id,
            expectedClientId: pending.clientId,
            actualClientId: client.id,
        });
        return;
    }
    transportOwner["pendingInvokes"].delete(envelope.id);
    clearTimeout(pending.timeout);
    if (envelope.error) {
        const err: Error & {
            code?: string;
            data?: unknown;
        } = new Error(envelope.error.message);
        err.code = envelope.error.code;
        err.data = envelope.error.data;
        pending.reject(err);
    }
    else {
        pending.resolve(envelope.result);
    }
}
