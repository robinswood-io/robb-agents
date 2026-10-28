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
import { PROTOCOL_VERSION, type MessageEnvelope } from "@craft-agent/shared/protocol";
import type { WsRpcClient, RpcWebSocket } from '../client.ts';
import type { TransportConnectionStatus, TransportCloseInfo } from './shared.ts';

export function reconnectNow(transportOwner: WsRpcClient): void {
    if (transportOwner["destroyed"])
        return;
    if (transportOwner.clientId) {
        transportOwner.pendingReconnect = {
            clientId: transportOwner.clientId,
            lastSeq: transportOwner.lastSeenSeq,
        };
    }
    if (transportOwner["reconnectTimer"]) {
        clearTimeout(transportOwner["reconnectTimer"]);
        transportOwner["reconnectTimer"] = null;
    }
    transportOwner.connectStarted = false;
    transportOwner["connectError"] = null;
    if (!transportOwner["ws"]) {
        transportOwner.setConnectionState({
            status: 'reconnecting',
            attempt: transportOwner.reconnectAttempt,
            nextRetryInMs: undefined,
        });
        transportOwner.connect();
        return;
    }
    transportOwner.manualReconnectRequested = true;
    try {
        transportOwner["ws"].close();
    }
    catch {
        transportOwner.manualReconnectRequested = false;
        transportOwner.setConnectionState({
            status: 'reconnecting',
            attempt: transportOwner.reconnectAttempt,
            nextRetryInMs: undefined,
        });
        transportOwner.connect();
    }
}

export function createWebSocket(transportOwner: WsRpcClient, url: string): RpcWebSocket {
    const needsTlsOptions = url.startsWith('wss://') && !transportOwner.tlsRejectUnauthorized;
    if (needsTlsOptions && typeof process !== 'undefined' && process.versions?.node) {
        // Node.js / Electron main process — use `ws` library for TLS options
        try {
            const { WebSocket: WsWebSocket } = require('ws') as typeof import('ws');
            return new WsWebSocket(url, { rejectUnauthorized: false });
        }
        catch {
            // Fallback if ws not available
            return new WebSocket(url);
        }
    }
    return new WebSocket(url);
}

export function connect(transportOwner: WsRpcClient): void {
    if (transportOwner["destroyed"])
        return;
    transportOwner.connectStarted = true;
    transportOwner["connectError"] = null;
    transportOwner.createReadyPromise();
    const isReconnectAttempt = transportOwner.reconnectAttempt > 0 || transportOwner.pendingReconnect !== null;
    const status: TransportConnectionStatus = isReconnectAttempt ? 'reconnecting' : 'connecting';
    transportOwner.setConnectionState({
        status,
        attempt: transportOwner.reconnectAttempt,
        nextRetryInMs: undefined,
        lastError: undefined,
    });
    if (transportOwner.connectTimer) {
        clearTimeout(transportOwner.connectTimer);
        transportOwner.connectTimer = null;
    }
    // Close and detach any existing socket before creating a new one.
    // Prevents orphaned connections and stale event handler interference.
    if (transportOwner["ws"]) {
        const oldWs = transportOwner["ws"];
        transportOwner["ws"] = null;
        oldWs.onopen = null;
        oldWs.onmessage = null;
        oldWs.onclose = null;
        oldWs.onerror = null;
        try {
            oldWs.close();
        }
        catch { /* best effort */ }
    }
    transportOwner.connectTimer = setTimeout(() => {
        if (!transportOwner["connected"]) {
            const err = transportOwner.createConnectionError('timeout', `Connection timeout after ${transportOwner.connectTimeout}ms`, 'HANDSHAKE_TIMEOUT');
            transportOwner["connectError"] = err;
            transportOwner.setConnectionState({
                status: 'failed',
                lastError: transportOwner.toErrorState(err),
                attempt: transportOwner.reconnectAttempt,
            });
            transportOwner.failReady(err);
            transportOwner["ws"]?.close();
        }
    }, transportOwner.connectTimeout);
    const ws = transportOwner.createWebSocket(transportOwner["url"]);
    transportOwner["ws"] = ws;
    ws.onopen = () => {
        if (transportOwner["ws"] !== ws)
            return; // stale socket — ignore
        const reconnectSnapshot = transportOwner.pendingReconnect;
        transportOwner.currentHandshakeWasReconnect = reconnectSnapshot !== null;
        // Send handshake (includes reconnection info if available)
        const handshake: MessageEnvelope = omitUndefined<MessageEnvelope>({
            id: crypto.randomUUID(),
            type: 'handshake',
            protocolVersion: PROTOCOL_VERSION,
            ...(transportOwner.workspaceId !== undefined ? { workspaceId: transportOwner.workspaceId } : {}),
            ...(transportOwner.webContentsId !== undefined ? { webContentsId: transportOwner.webContentsId } : {}),
            ...(transportOwner.token !== undefined ? { token: transportOwner.token } : {}),
            clientCapabilities: transportOwner.clientCapabilities.length > 0 ? transportOwner.clientCapabilities : undefined,
            ...(reconnectSnapshot?.clientId !== undefined ? { reconnectClientId: reconnectSnapshot?.clientId } : {}),
            ...(reconnectSnapshot?.lastSeq !== undefined ? { lastSeq: reconnectSnapshot?.lastSeq } : {}),
        });
        transportOwner["trySendEnvelope"](ws, handshake);
    };
    ws.onmessage = (event: { data: unknown }) => {
        if (transportOwner["ws"] !== ws)
            return; // stale socket — ignore
        const data: unknown = event.data;
        transportOwner.onMessage(typeof data === 'string' ? data : String(data));
    };
    ws.onclose = (event: { code: number; reason: string; wasClean: boolean }) => {
        if (transportOwner["ws"] !== ws)
            return; // stale socket — ignore
        transportOwner.onDisconnect(event);
    };
    ws.onerror = (event: Event | {
        message?: string;
        error?: Error;
    }) => {
        if (transportOwner["ws"] !== ws)
            return; // stale socket — ignore
        // Error is typically followed by close event, handled there.
        // Capture this early for more actionable state while connecting.
        if (!transportOwner["connected"] && !transportOwner["connectError"]) {
            // Extract actual error message when available (Node.js ws library provides it)
            const detail = ('message' in event && event.message)
                || ('error' in event && event.error?.message)
                || undefined;
            const message = detail
                ? `WebSocket error: ${detail}`
                : 'WebSocket error during connection setup';
            const err = transportOwner.createConnectionError('network', message, 'WS_ERROR');
            transportOwner["connectError"] = err;
            transportOwner.setConnectionState({
                status: 'failed',
                lastError: transportOwner.toErrorState(err),
                attempt: transportOwner.reconnectAttempt,
            });
        }
    };
}

export function destroy(transportOwner: WsRpcClient): void {
    transportOwner["destroyed"] = true;
    if (transportOwner["reconnectTimer"]) {
        clearTimeout(transportOwner["reconnectTimer"]);
        transportOwner["reconnectTimer"] = null;
    }
    if (transportOwner.connectTimer) {
        clearTimeout(transportOwner.connectTimer);
        transportOwner.connectTimer = null;
    }
    if (transportOwner.ackTimer) {
        clearInterval(transportOwner.ackTimer);
        transportOwner.ackTimer = null;
    }
    if (transportOwner.backoffResetTimer) {
        clearTimeout(transportOwner.backoffResetTimer);
        transportOwner.backoffResetTimer = null;
    }
    transportOwner.manualReconnectRequested = false;
    transportOwner.currentHandshakeWasReconnect = false;
    transportOwner.pendingReconnect = null;
    transportOwner.failReady(new Error('Client destroyed'));
    // Reject all pending requests
    for (const [_id, req] of transportOwner["pending"]) {
        clearTimeout(req.timeout);
        req.reject(new Error('Client destroyed'));
    }
    transportOwner["pending"].clear();
    transportOwner["anyEventListeners"].clear();
    transportOwner["ws"]?.close();
    transportOwner["ws"] = null;
    transportOwner["connected"] = false;
    transportOwner.setConnectionState({
        status: 'disconnected',
        lastError: {
            kind: 'unknown',
            code: 'CLIENT_DESTROYED',
            message: 'Client destroyed',
        },
        nextRetryInMs: undefined,
    });
}

export function onDisconnect(transportOwner: WsRpcClient, closeEvent?: {
    code?: number;
    reason?: string;
    wasClean?: boolean;
}): void {
    if (transportOwner.clientId) {
        transportOwner.pendingReconnect = {
            clientId: transportOwner.clientId,
            lastSeq: transportOwner.lastSeenSeq,
        };
    }
    const manualReconnect = transportOwner.manualReconnectRequested;
    transportOwner.manualReconnectRequested = false;
    const wasConnected = transportOwner["connected"];
    transportOwner["connected"] = false;
    transportOwner.clientId = null;
    transportOwner["ws"] = null;
    // Stop ack timer
    if (transportOwner.ackTimer) {
        clearInterval(transportOwner.ackTimer);
        transportOwner.ackTimer = null;
    }
    if (transportOwner.connectTimer) {
        clearTimeout(transportOwner.connectTimer);
        transportOwner.connectTimer = null;
    }
    // Cancel backoff reset — counter carries over across short-lived connections
    if (transportOwner.backoffResetTimer) {
        clearTimeout(transportOwner.backoffResetTimer);
        transportOwner.backoffResetTimer = null;
    }
    const closeInfo: TransportCloseInfo | undefined = closeEvent
        ? omitUndefined<TransportCloseInfo>({
            code: Number.isFinite(closeEvent.code) ? closeEvent.code : undefined,
            reason: closeEvent.reason || undefined,
            wasClean: closeEvent.wasClean,
        })
        : undefined;
    if (!transportOwner["connectError"] && closeInfo?.code) {
        const closeKind = transportOwner["classifyErrorKindFromCloseCode"](closeInfo.code);
        if (closeKind !== 'unknown') {
            transportOwner["connectError"] = transportOwner.createConnectionError(closeKind, closeInfo.reason || `Connection closed (${closeInfo.code})`, `WS_CLOSE_${closeInfo.code}`);
        }
    }
    // Reject all pending requests
    if (wasConnected) {
        for (const [_id, req] of transportOwner["pending"]) {
            clearTimeout(req.timeout);
            req.reject(new Error('Connection lost'));
        }
        transportOwner["pending"].clear();
        transportOwner.setConnectionState({
            status: 'disconnected',
            ...(closeInfo !== undefined ? { lastClose: closeInfo } : {}),
            attempt: transportOwner.reconnectAttempt,
        });
    }
    else {
        const err = transportOwner["connectError"] ?? new Error('Connection lost before handshake');
        transportOwner.failReady(err);
        transportOwner.setConnectionState({
            status: 'failed',
            lastError: transportOwner.toErrorState(err),
            ...(closeInfo !== undefined ? { lastClose: closeInfo } : {}),
            attempt: transportOwner.reconnectAttempt,
        });
    }
    if (manualReconnect && !transportOwner["destroyed"]) {
        transportOwner.connect();
        return;
    }
    if (!transportOwner["destroyed"] && !transportOwner.permanentlyClosed && transportOwner.autoReconnect) {
        transportOwner.scheduleReconnect();
    }
}

export function scheduleReconnect(transportOwner: WsRpcClient): void {
    if (transportOwner.permanentlyClosed)
        return;
    const delay = Math.min(1000 * Math.pow(2, transportOwner.reconnectAttempt), transportOwner.maxReconnectDelay);
    transportOwner.reconnectAttempt++;
    transportOwner.setConnectionState({
        status: 'reconnecting',
        attempt: transportOwner.reconnectAttempt,
        nextRetryInMs: delay,
    });
    transportOwner["reconnectTimer"] = setTimeout(() => {
        transportOwner["reconnectTimer"] = null;
        transportOwner.connect();
    }, delay);
}

export function scheduleBackoffReset(transportOwner: WsRpcClient): void {
    if (transportOwner.backoffResetTimer)
        clearTimeout(transportOwner.backoffResetTimer);
    transportOwner.backoffResetTimer = setTimeout(() => {
        transportOwner.backoffResetTimer = null;
        transportOwner.reconnectAttempt = 0;
    }, 10000);
}
