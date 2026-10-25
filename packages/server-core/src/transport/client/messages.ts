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
import { SEQUENCE_ACK_INTERVAL_MS, isErrorCode, type ErrorCode, type MessageEnvelope } from "@craft-agent/shared/protocol";
import { deserializeEnvelope } from "../codec";
import type { WsRpcClient } from '../client.ts';

export function 
/** Emit a synthetic __transport:reconnected event. Used by RoutedClient after workspace swap to trigger stale recovery. */
emitReconnected(transportOwner: WsRpcClient, isStale: boolean): void {
    const set = transportOwner["listeners"].get('__transport:reconnected');
    if (set) {
        for (const cb of set) {
            try {
                Reflect.apply(cb, undefined, [isStale]);
            }
            catch { /* listener errors must not break transport */ }
        }
    }
}

export function onMessage(transportOwner: WsRpcClient, raw: string): void {
    let envelope: MessageEnvelope;
    try {
        envelope = deserializeEnvelope(raw);
    }
    catch {
        return;
    }
    switch (envelope.type) {
        case 'handshake_ack': {
            const wasReconnectAttempt = transportOwner["currentHandshakeWasReconnect"];
            const serverRecognizedReconnect = envelope.reconnected === true;
            transportOwner["currentHandshakeWasReconnect"] = false;
            transportOwner["pendingReconnect"] = null;
            transportOwner["clientId"] = envelope.clientId ?? null;
            transportOwner["_serverVersion"] = envelope.serverVersion ?? null;
            transportOwner["serverChannels"] = envelope.registeredChannels
                ? new Set(envelope.registeredChannels)
                : null;
            transportOwner["connected"] = true;
            transportOwner["connectError"] = null;
            // Delay backoff reset — only reset after 10s of stable connection.
            // Immediate reset causes rapid reconnect loops when the server
            // accepts the handshake but drops the connection right after.
            transportOwner["scheduleBackoffReset"]();
            if (!serverRecognizedReconnect) {
                transportOwner["lastSeenSeq"] = 0;
            }
            if (transportOwner["connectTimer"]) {
                clearTimeout(transportOwner["connectTimer"]);
                transportOwner["connectTimer"] = null;
            }
            transportOwner["setConnectionState"]({
                status: 'connected',
                attempt: 0,
                nextRetryInMs: undefined,
                lastError: undefined,
                lastClose: undefined,
            });
            transportOwner["startAckTimer"]();
            transportOwner["resolveReady"]?.();
            transportOwner["resolveReady"] = null;
            transportOwner["rejectReady"] = null;
            transportOwner["readyPromise"] = null;
            // Notify listeners about reconnection AFTER resolveReady
            if (wasReconnectAttempt) {
                // envelope.reconnected === true means server recognized the previous client.
                // If absent, the reconnect fell back to a fresh connection — treat as stale.
                const isStale = !serverRecognizedReconnect || !!envelope.stale;
                const set = transportOwner["listeners"].get('__transport:reconnected');
                if (set) {
                    for (const cb of set) {
                        try {
                            Reflect.apply(cb, undefined, [isStale]);
                        }
                        catch { /* listener errors must not break transport */ }
                    }
                }
            }
            break;
        }
        case 'response': {
            const req = transportOwner["pending"].get(envelope.id);
            if (req) {
                transportOwner["pending"].delete(envelope.id);
                clearTimeout(req.timeout);
                if (envelope.error) {
                    const err: Error & {
                        code?: string;
                        data?: unknown;
                    } = new Error(envelope.error.message);
                    err.code = envelope.error.code;
                    err.data = envelope.error.data;
                    req.reject(err);
                }
                else {
                    req.resolve(envelope.result);
                }
            }
            break;
        }
        case 'error': {
            // Protocol-level error (handshake rejection, version mismatch).
            // No pending request — connection is about to close.
            if (envelope.error?.message) {
                const kind = transportOwner["classifyErrorKindFromCode"](envelope.error.code);
                const err = transportOwner["createConnectionError"](kind, envelope.error.message, envelope.error.code);
                transportOwner["connectError"] = err;
                transportOwner["setConnectionState"]({
                    status: 'failed',
                    lastError: transportOwner["toErrorState"](err),
                    attempt: transportOwner["reconnectAttempt"],
                });
                transportOwner["failReady"](err);
            }
            break;
        }
        case 'request': {
            // Server→client capability invocation
            if (envelope.channel) {
                transportOwner["onServerRequest"](envelope);
            }
            break;
        }
        case 'event': {
            // Track sequence numbers for reliable delivery
            if (typeof envelope.seq === 'number') {
                if (transportOwner["lastSeenSeq"] > 0 && envelope.seq > transportOwner["lastSeenSeq"] + 1) {
                    console.warn(`[WsRpc] Sequence gap: expected ${transportOwner["lastSeenSeq"] + 1}, got ${envelope.seq}`);
                }
                transportOwner["lastSeenSeq"] = envelope.seq;
            }
            if (envelope.channel) {
                // Server is shutting down — stop reconnection before dispatching
                if (envelope.channel === 'server:shuttingDown') {
                    transportOwner["permanentlyClosed"] = true;
                    transportOwner["setConnectionState"]({
                        status: 'disconnected',
                        lastError: { kind: 'server', message: 'Server is shutting down', code: 'SERVER_SHUTDOWN' },
                    });
                }
                const set = transportOwner["listeners"].get(envelope.channel);
                if (set) {
                    for (const cb of set) {
                        try {
                            Reflect.apply(cb, undefined, envelope.args ?? []);
                        }
                        catch {
                            // Listener errors shouldn't break the client
                        }
                    }
                }
                // Wildcard listeners (used by RemoteClientBridge for event forwarding)
                for (const cb of transportOwner["anyEventListeners"]) {
                    try {
                        Reflect.apply(cb, undefined, [envelope.channel, ...(envelope.args ?? [])]);
                    }
                    catch {
                        // Listener errors shouldn't break the client
                    }
                }
            }
            break;
        }
    }
}

export async function onServerRequest(transportOwner: WsRpcClient, envelope: MessageEnvelope): Promise<void> {
    const handler = transportOwner["capabilityHandlers"].get(envelope.channel!);
    if (!handler) {
        const response: MessageEnvelope = {
            id: envelope.id,
            type: 'response',
            channel: envelope.channel,
            error: { code: 'CHANNEL_NOT_FOUND', message: `No handler for: ${envelope.channel}` },
        };
        transportOwner["trySendEnvelope"](transportOwner["ws"], response);
        return;
    }
    try {
        const result: unknown = await Reflect.apply(handler, undefined, envelope.args ?? []);
        const response: MessageEnvelope = {
            id: envelope.id,
            type: 'response',
            channel: envelope.channel,
            result,
        };
        transportOwner["trySendEnvelope"](transportOwner["ws"], response);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const rawCode = (err as {
            code?: unknown;
        } | null)?.code;
        const code: ErrorCode = isErrorCode(rawCode) ? rawCode : 'HANDLER_ERROR';
        const response: MessageEnvelope = {
            id: envelope.id,
            type: 'response',
            channel: envelope.channel,
            error: { code, message },
        };
        transportOwner["trySendEnvelope"](transportOwner["ws"], response);
    }
}

export function startAckTimer(transportOwner: WsRpcClient): void {
    if (transportOwner["ackTimer"])
        clearInterval(transportOwner["ackTimer"]);
    transportOwner["ackTimer"] = setInterval(() => {
        if (transportOwner["connected"] && transportOwner["lastSeenSeq"] > 0) {
            const ack: MessageEnvelope = {
                id: crypto.randomUUID(),
                type: 'sequence_ack',
                lastSeq: transportOwner["lastSeenSeq"],
            };
            transportOwner["trySendEnvelope"](transportOwner["ws"], ack);
        }
    }, SEQUENCE_ACK_INTERVAL_MS);
}
