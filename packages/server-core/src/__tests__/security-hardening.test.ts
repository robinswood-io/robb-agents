import { describe, it, expect } from 'bun:test';
import {
  isSensitiveFilePath,
  validateFilePath,
} from '../handlers/utils.ts';
import { assertRequestWorkspaceAccess, type RequestContext } from '../transport/types.ts';
import { WsRpcServer } from '../transport/server.ts';
import { RateLimiter } from '../webui/auth.ts';
import { resolveWebSocketUrl } from '../webui/http-server.ts';
import { nodeHttpAdapter } from '../webui/node-adapter.ts';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

interface WsRpcServerTestInternal {
  pendingInvokes: Map<
    string,
    {
      clientId: string;
      resolve: (val: unknown) => void;
      reject: (err: unknown) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >;
  onClientResponse: (
    client: { id: string },
    msg: { id: string; type: string; result?: unknown },
  ) => void;
  bufferAndMaybeSendEvent: (
    client: unknown,
    channel: string,
    args: unknown[],
    timestamp: number,
    isLive: boolean,
  ) => void;
  onRequest: (
    client: unknown,
    msg: { id: string; type: string; channel: string; args: unknown[] },
  ) => Promise<void>;
  isHandshakeIpRateLimited: (ip: string) => boolean;
  recordFailedHandshake: (ip: string) => void;
}

describe('Server-Core Security Hardening Regressions', () => {
  describe('Sensitive File Path Guards', () => {
    it('blocks sensitive credential and config files in isSensitiveFilePath and validateFilePath', async () => {
      const sensitivePaths = [
        '/Users/alice/.craft-agent/credentials.enc',
        '/Users/alice/.craft-agent/remote-devices.json',
        '/Users/alice/.craft-agent/workspaces/ws1/sources/s1/.credential-cache.json',
        '/Users/alice/.ssh/id_ed25519',
        '/Users/alice/.aws/credentials',
        '/Users/alice/.npmrc',
        '/Users/alice/.netrc',
        '/Users/alice/.git-credentials',
        '/Users/alice/.kube/config',
        '/project/.env',
        '/project/.env.production',
      ];
      for (const p of sensitivePaths) {
        expect(isSensitiveFilePath(p)).toBe(true);
        await expect(validateFilePath(p, ['/Users/alice', '/project'])).rejects.toThrow(
          /Access denied: cannot read sensitive files/,
        );
      }
    });
  });

  describe('Workspace Authorization Boundary', () => {
    it('blocks cross-workspace access when resolved workspace id differs from authorized workspace', () => {
      const ctx: RequestContext = {
        clientId: 'client-1',
        workspaceId: 'ws-authorized',
        webContentsId: null,
        actorId: 'dev-1',
        roles: ['workspace:member'],
        authorizationGeneration: 1,
        allowedWorkspaceIds: ['ws-authorized'],
      };

      expect(() => assertRequestWorkspaceAccess(ctx, 'ws-authorized', 'ws-authorized')).not.toThrow();
      expect(() => assertRequestWorkspaceAccess(ctx, 'ws-other')).toThrow(/Workspace access denied/);
      expect(() => assertRequestWorkspaceAccess(ctx, '/path/to/ws-other', 'ws-other')).toThrow(
        /Workspace access denied/,
      );
    });
  });

  describe('WsRpcServer Client Response Spoofing, Memory Caps & DoS Guards', () => {
    it('ignores invoke responses sent by a different client than the target clientId', () => {
      const server = new WsRpcServer({ host: '127.0.0.1', port: 0, requireAuth: false });
      const internal = server as unknown as WsRpcServerTestInternal;
      let resolvedValue: unknown = null;

      internal.pendingInvokes.set('req-1', {
        clientId: 'legit-client',
        resolve: (val: unknown) => {
          resolvedValue = val;
        },
        reject: () => {},
        timeout: setTimeout(() => {}, 10_000),
      });

      const attackerClient = { id: 'attacker-client' };
      internal.onClientResponse(attackerClient, {
        id: 'req-1',
        type: 'response',
        result: 'spoofed',
      });

      expect(resolvedValue).toBeNull();
      expect(internal.pendingInvokes.has('req-1')).toBe(true);

      const legitClient = { id: 'legit-client' };
      internal.onClientResponse(legitClient, {
        id: 'req-1',
        type: 'response',
        result: 'authentic',
      });

      expect(resolvedValue).toBe('authentic');
      expect(internal.pendingInvokes.has('req-1')).toBe(false);
    });

    it('enforces maxEventBufferBytes per client to prevent memory exhaustion', () => {
      const server = new WsRpcServer({
        host: '127.0.0.1',
        port: 0,
        requireAuth: false,
        maxEventBufferBytes: 1024,
      });
      const internal = server as unknown as WsRpcServerTestInternal;

      const fakeClient = {
        id: 'client-buf',
        ws: { readyState: 0, OPEN: 1, send: () => {} },
        workspaceId: 'ws-1',
        webContentsId: null,
        capabilities: new Set<string>(),
        actorId: 'local-owner',
        roles: ['owner'],
        authorizationGeneration: 0,
        allowedWorkspaceIds: '*' as const,
        missedPongs: 0,
        alive: true,
        eventBuffer: [],
        bufferedBytes: 0,
        inFlightRequests: 0,
        lastAckedSeq: 0,
        lastSentSeq: 0,
      };

      const chunk = 'x'.repeat(400);
      for (let i = 0; i < 10; i++) {
        internal.bufferAndMaybeSendEvent(fakeClient, 'test:event', [chunk], Date.now(), false);
      }

      expect(fakeClient.bufferedBytes).toBeLessThanOrEqual(1024);
      expect(fakeClient.eventBuffer.length).toBeGreaterThan(0);
      expect(fakeClient.eventBuffer.length).toBeLessThan(10);
    });

    it('enforces maxInFlightRequestsPerClient and maxFailedHandshakesPerIp', async () => {
      const server = new WsRpcServer({
        host: '127.0.0.1',
        port: 0,
        requireAuth: true,
        maxInFlightRequestsPerClient: 1,
        maxFailedHandshakesPerIp: 2,
      });
      const internal = server as unknown as WsRpcServerTestInternal;

      let releaseHandler!: () => void;
      server.handle('slow:op', async () => {
        await new Promise<void>((resolve) => {
          releaseHandler = resolve;
        });
        return 'ok';
      });

      const sentMessages: string[] = [];
      const fakeClient = {
        id: 'client-inflight',
        ws: {
          readyState: 1,
          OPEN: 1,
          send: (data: string) => sentMessages.push(data),
        },
        workspaceId: 'ws-1',
        webContentsId: null,
        capabilities: new Set<string>(),
        actorId: 'local-owner',
        roles: ['owner'],
        authorizationGeneration: 0,
        allowedWorkspaceIds: '*' as const,
        missedPongs: 0,
        alive: true,
        eventBuffer: [],
        bufferedBytes: 0,
        inFlightRequests: 0,
        lastAckedSeq: 0,
        lastSentSeq: 0,
      };

      const req1 = internal.onRequest(fakeClient, {
        id: 'r1',
        type: 'request',
        channel: 'slow:op',
        args: [],
      });
      await internal.onRequest(fakeClient, {
        id: 'r2',
        type: 'request',
        channel: 'slow:op',
        args: [],
      });

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toContain('Too many concurrent in-flight requests');

      releaseHandler();
      await req1;
      expect(fakeClient.inFlightRequests).toBe(0);

      expect(internal.isHandshakeIpRateLimited('203.0.113.9')).toBe(false);
      internal.recordFailedHandshake('203.0.113.9');
      internal.recordFailedHandshake('203.0.113.9');
      expect(internal.isHandshakeIpRateLimited('203.0.113.9')).toBe(true);
    });
  });

  describe('WebUI Host Sanitization & RateLimiter Bounding', () => {
    it('bounds RateLimiter per-IP map to maxEntries under IP flood', () => {
      const limiter = new RateLimiter(5, 60_000, 10_000, 16);
      for (let i = 0; i < 100; i++) {
        expect(limiter.check(`198.51.100.${i}`)).toBe(true);
      }
      expect((limiter as unknown as { entries: Map<string, unknown> }).entries.size).toBeLessThanOrEqual(16);
    });

    it('sanitizes spoofed X-Forwarded-Host containing userinfo, paths, or fragments', () => {
      const legitReq = new Request('http://127.0.0.1:9100/api/config', {
        headers: { 'X-Forwarded-Host': 'craft.example.com:3100' },
      });
      expect(
        resolveWebSocketUrl(legitReq, { wsProtocol: 'wss', wsPort: 9100, trustedProxy: true }),
      ).toBe('wss://craft.example.com:9100');

      for (const maliciousHost of [
        'evil.example.com/path#',
        'user:pass@evil.example.com',
        'evil.example.com?token=1',
        'evil.example.com\\@legit.com',
      ]) {
        const badReq = new Request('http://127.0.0.1:9100/api/config', {
          headers: { 'X-Forwarded-Host': maliciousHost },
        });
        expect(
          resolveWebSocketUrl(badReq, { wsProtocol: 'wss', wsPort: 9100, trustedProxy: true }),
        ).toBe('wss://127.0.0.1:9100');
      }
    });

    it('sanitizes malformed Host headers in nodeHttpAdapter without throwing 500 TypeError', async () => {
      let seenUrl = '';
      const adapter = nodeHttpAdapter((req) => {
        seenUrl = req.url;
        return new Response('ok', { status: 200 });
      });

      const fakeReq = Object.assign(Readable.from([]), {
        method: 'GET',
        url: '/api/health',
        headers: { host: 'user:pass@evil.example.com/bad path' },
        rawHeaders: ['Host', 'user:pass@evil.example.com/bad path'],
        socket: { encrypted: false, remoteAddress: '127.0.0.1' },
      });

      let statusCode = 0;
      let bodyText = '';
      await new Promise<void>((resolve) => {
        const fakeRes = {
          headersSent: false,
          writeHead(code: number) {
            statusCode = code;
            this.headersSent = true;
          },
          end(chunk?: Buffer | string) {
            bodyText = chunk ? chunk.toString() : '';
            resolve();
          },
        };
        adapter(
          fakeReq as unknown as IncomingMessage,
          fakeRes as unknown as ServerResponse,
        );
      });

      expect(statusCode).toBe(200);
      expect(bodyText).toBe('ok');
      expect(seenUrl).toBe('http://localhost/api/health');
    });
  });
});
