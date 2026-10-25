

// ---------------------------------------------------------------------------
// Pending request state
// ---------------------------------------------------------------------------
export interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Connection state model
// ---------------------------------------------------------------------------
export type TransportMode = 'local' | 'remote';

export type TransportConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed';

export type TransportConnectionErrorKind = 'auth' | 'protocol' | 'timeout' | 'network' | 'server' | 'unknown';

export interface TransportConnectionError {
    kind: TransportConnectionErrorKind;
    message: string;
    code?: string;
}

export interface TransportCloseInfo {
    code?: number;
    reason?: string;
    wasClean?: boolean;
}

export interface TransportConnectionState {
    mode: TransportMode;
    status: TransportConnectionStatus;
    url: string;
    attempt: number;
    nextRetryInMs?: number;
    lastError?: TransportConnectionError;
    lastClose?: TransportCloseInfo;
    updatedAt: number;
}

// ---------------------------------------------------------------------------
// Client options
// ---------------------------------------------------------------------------
export interface WsRpcClientOptions {
    /** Workspace ID sent on handshake. */
    workspaceId?: string;
    /** Electron webContents.id, sent on handshake for local clients. */
    webContentsId?: number;
    /** Bearer token for remote auth. */
    token?: string;
    /** Request timeout in ms. Default: 30_000 */
    requestTimeout?: number;
    /** Max reconnection backoff in ms. Default: 30_000 */
    maxReconnectDelay?: number;
    /** Whether to auto-reconnect on disconnect. Default: true */
    autoReconnect?: boolean;
    /** Handshake/connect timeout in ms. Default: 10_000 */
    connectTimeout?: number;
    /** Capabilities to advertise on handshake. Handlers must be registered via handleCapability(). */
    clientCapabilities?: string[];
    /** Runtime mode — local embedded or remote thin-client connection. */
    mode?: TransportMode;
    /** Accept self-signed TLS certificates for wss:// connections. Default: false. Only works in Node.js (main process). */
    tlsRejectUnauthorized?: boolean;
}
