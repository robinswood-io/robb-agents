/**
 * WsRpcServer — WebSocket-based RPC server.
 *
 * Owns ALL transport concerns: connection lifecycle, handshake, heartbeat,
 * optional auth, request dispatching, and push routing.
 *
 * Same class used locally (127.0.0.1, no auth) and remotely (0.0.0.0, auth).
 */
import { type WebSocket } from "ws";
import type { RequestContext, AuthenticationResult, ConnectedClientInfo } from "../types";
import { createLogger } from "@craft-agent/shared/utils";

// ---------------------------------------------------------------------------
// Client connection state
// ---------------------------------------------------------------------------
export interface BufferedEvent {
    seq: number;
    /** Shared serialized envelope — one allocation referenced by all client buffers. */
    data: string;
    bytes: number;
    timestamp: number;
}

export interface ClientConnection {
    id: string;
    ws: WebSocket;
    workspaceId: string | null;
    webContentsId: number | null;
    capabilities: Set<string>;
    actorId: string;
    roles: readonly string[];
    authorizationGeneration: number;
    allowedWorkspaceIds: ReadonlySet<string> | '*';
    missedPongs: number;
    alive: boolean;
    /** Ring buffer of recent events for replay on reconnect. */
    eventBuffer: BufferedEvent[];
    /** Total byte size of buffered event strings for O(1) memory cap enforcement. */
    bufferedBytes: number;
    /** Active concurrent RPC requests from this client. */
    inFlightRequests: number;
    /** Highest per-client seq the client has acknowledged. */
    lastAckedSeq: number;
    /** Highest per-client seq assigned to this client. */
    lastSentSeq: number;
    /** Set when authorization is explicitly revoked so close handler does not retain reconnect buffer. */
    revoked?: boolean;
}

export interface PendingInvoke {
    clientId: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Server options
// ---------------------------------------------------------------------------
export interface WsRpcTlsOptions {
    /** PEM-encoded certificate (or Buffer). */
    cert: string | Buffer;
    /** PEM-encoded private key (or Buffer). */
    key: string | Buffer;
    /** Optional PEM-encoded CA chain for client certificate verification. */
    ca?: string | Buffer;
    /** Optional passphrase for encrypted private keys. */
    passphrase?: string;
}

export interface WsRpcServerOptions {
    /** Host to bind to. Default: '127.0.0.1' */
    host?: string;
    /** Port to bind to. 0 = random available port. Default: 0 */
    port?: number;
    /** Whether to require a bearer token on handshake. Default: false */
    requireAuth?: boolean;
    /** Token validator. Authoritative deployments return a server-issued principal. */
    validateToken?: (token: string) => Promise<AuthenticationResult>;
    /**
     * Optional cookie-based session validator (for web UI auth).
     * Called with the Cookie header from the HTTP upgrade request.
     * If provided, a valid session cookie is accepted as an alternative to a bearer token.
     */
    validateSessionCookie?: (cookieHeader: string | null) => Promise<AuthenticationResult>;
    /**
     * Explicit browser origins allowed to authenticate a WebSocket with a
     * session cookie. When unset, the server requires its own HTTPS/HTTP origin.
     */
    allowedSessionCookieOrigins?: readonly string[];
    /** Authoritative per-channel authorization invoked before every RPC handler. */
    authorizeRequest?: (context: RequestContext, channel: string, args: readonly unknown[]) => boolean | Promise<boolean>;
    /** Reject legacy boolean authentication results when true. */
    requireAuthoritativePrincipal?: boolean;
    /** Server identity stamp on outgoing events. Default: 'local' */
    serverId?: string;
    /** TLS configuration. When provided, the server listens on wss:// instead of ws://. */
    tls?: WsRpcTlsOptions;
    /** App version string, included in handshake_ack for client compatibility checks. */
    serverVersion?: string;
    /** Maximum concurrent clients. 0 = unlimited. Default: 50 */
    maxClients?: number;
    /** Maximum WebSocket message size in bytes. Default: 8 MiB. */
    maxPayloadBytes?: number;
    /** Maximum concurrent in-flight RPC requests per client. Default: 64. */
    maxInFlightRequestsPerClient?: number;
    /** Maximum buffered event replay bytes per client. Default: 8 MiB. */
    maxEventBufferBytes?: number;
    /** Maximum failed auth handshakes per IP per 60s window. Default: 15. */
    maxFailedHandshakesPerIp?: number;
    /** Called when a client completes handshake. */
    onClientConnected?: (info: ConnectedClientInfo) => void;
    /** Called when a client disconnects. */
    onClientDisconnected?: (clientId: string) => void;
    /**
     * Optional HTTP request handler for non-WebSocket requests.
     * When provided, regular HTTP requests to the server's port are
     * routed here instead of being rejected. This enables serving the
     * WebUI from the same port as the WebSocket server.
     * Must use Node.js HTTP callback signature (IncomingMessage, ServerResponse).
     */
    httpHandler?: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void;
}

export const transportLog = createLogger('ws-rpc-server');
