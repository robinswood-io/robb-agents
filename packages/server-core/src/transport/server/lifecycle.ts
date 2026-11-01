/**
 * WsRpcServer — WebSocket-based RPC server.
 *
 * Owns ALL transport concerns: connection lifecycle, handshake, heartbeat,
 * optional auth, request dispatching, and push routing.
 *
 * Same class used locally (127.0.0.1, no auth) and remotely (0.0.0.0, auth).
 */
import { WebSocketServer } from "ws";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_MAX_MISSED } from "@craft-agent/shared/protocol";
import type { WsRpcServer } from '../server.ts';

export function configureNodeHttpTimeouts(_transportOwner: WsRpcServer, server: HttpServer | HttpsServer): void {
    server.headersTimeout = 15000;
    server.requestTimeout = 60000;
    server.keepAliveTimeout = 5000;
    server.maxHeadersCount = 100;
}

export async function listen(transportOwner: WsRpcServer): Promise<void> {
    return new Promise((resolve, reject) => {
        if (transportOwner.tlsOptions) {
            // TLS mode: create HTTPS server, attach WebSocketServer to it.
            // When httpHandler is set, regular HTTP requests are served by it
            // (e.g. WebUI), while ws intercepts WebSocket upgrade requests.
            transportOwner["_protocol"] = 'wss';
            transportOwner.httpsServer = createHttpsServer({
                cert: transportOwner.tlsOptions.cert,
                key: transportOwner.tlsOptions.key,
                ca: transportOwner.tlsOptions.ca,
                // A client CA is an authentication requirement, not just a trust hint.
                requestCert: transportOwner.tlsOptions.ca !== undefined,
                rejectUnauthorized: true,
                passphrase: transportOwner.tlsOptions.passphrase,
            }, transportOwner.httpHandler);
            transportOwner.configureNodeHttpTimeouts(transportOwner.httpsServer);
            transportOwner.wss = new WebSocketServer({
                server: transportOwner.httpsServer,
                perMessageDeflate: false,
                maxPayload: transportOwner.maxPayloadBytes,
            });
            transportOwner.httpsServer.on('error', (err) => reject(err));
            transportOwner.httpsServer.listen(transportOwner.requestedPort, transportOwner.host, () => {
                const addr = transportOwner.httpsServer!.address();
                if (typeof addr === 'object' && addr) {
                    transportOwner["_port"] = addr.port;
                }
                transportOwner.startHeartbeat();
                resolve();
            });
        }
        else if (transportOwner.httpHandler) {
            // Plain WS + HTTP handler: create an HTTP server for both.
            transportOwner["_protocol"] = 'ws';
            transportOwner.httpServer = createHttpServer(transportOwner.httpHandler);
            transportOwner.configureNodeHttpTimeouts(transportOwner.httpServer);
            transportOwner.wss = new WebSocketServer({
                server: transportOwner.httpServer,
                perMessageDeflate: false,
                maxPayload: transportOwner.maxPayloadBytes,
            });
            transportOwner.httpServer.on('error', (err) => reject(err));
            transportOwner.httpServer.listen(transportOwner.requestedPort, transportOwner.host, () => {
                const addr = transportOwner.httpServer!.address();
                if (typeof addr === 'object' && addr) {
                    transportOwner["_port"] = addr.port;
                }
                transportOwner.startHeartbeat();
                resolve();
            });
        }
        else {
            // Plain WS mode, no HTTP handler
            transportOwner["_protocol"] = 'ws';
            transportOwner.wss = new WebSocketServer({
                host: transportOwner.host,
                port: transportOwner.requestedPort,
                perMessageDeflate: false,
                maxPayload: transportOwner.maxPayloadBytes,
            });
            transportOwner.wss.on('listening', () => {
                const addr = transportOwner.wss!.address();
                if (typeof addr === 'object' && addr) {
                    transportOwner["_port"] = addr.port;
                }
                transportOwner.startHeartbeat();
                resolve();
            });
            transportOwner.wss.on('error', (err) => {
                reject(err);
            });
        }
        transportOwner.wss.on('connection', (ws, req) => {
            transportOwner.onConnection(ws, req.headers.cookie ?? null, req.headers.origin ?? null, req.headers.host ?? null, req.socket?.remoteAddress ?? 'direct');
        });
    });
}

export function close(transportOwner: WsRpcServer): void {
    if (transportOwner.heartbeatTimer) {
        clearInterval(transportOwner.heartbeatTimer);
        transportOwner.heartbeatTimer = null;
    }
    // Reject all pending invokes before tearing down connections
    for (const [id, pending] of transportOwner["pendingInvokes"]) {
        clearTimeout(pending.timeout);
        const err: Error & {
            code?: string;
        } = new Error('Server shutting down');
        err.code = 'CLIENT_DISCONNECTED';
        pending.reject(err);
        transportOwner["pendingInvokes"].delete(id);
    }
    for (const client of transportOwner["clients"].values()) {
        client.ws.terminate();
    }
    transportOwner["clients"].clear();
    // Clean up disconnected client timers
    for (const entry of transportOwner["disconnectedClients"].values()) {
        clearTimeout(entry.timer);
    }
    transportOwner["disconnectedClients"].clear();
    transportOwner.wss?.close();
    transportOwner.wss = null;
    transportOwner.httpServer?.close();
    transportOwner.httpServer = null;
    transportOwner.httpsServer?.close();
    transportOwner.httpsServer = null;
}

export function startHeartbeat(transportOwner: WsRpcServer): void {
    transportOwner.heartbeatTimer = setInterval(() => {
        const now = Date.now();
        for (const [ip, entry] of transportOwner["failedHandshakesByIp"].entries()) {
            if (now - entry.windowStart > 60000) {
                transportOwner["failedHandshakesByIp"].delete(ip);
            }
        }
        for (const [, client] of transportOwner["clients"]) {
            // Skip sockets that are already closing/closed (e.g. terminated on a previous tick)
            if (client.ws.readyState !== client.ws.OPEN)
                continue;
            if (!client.alive) {
                client.missedPongs++;
                if (client.missedPongs >= HEARTBEAT_MAX_MISSED) {
                    // Let the close handler (setupClientHandlers) handle all cleanup:
                    // clients.delete, buffer retention for reconnect, onClientDisconnected.
                    client.ws.terminate();
                    continue;
                }
            }
            client.alive = false;
            client.ws.ping();
        }
    }, HEARTBEAT_INTERVAL_MS);
}
