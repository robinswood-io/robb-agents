/**
 * MCP Pool Server
 *
 * Serves McpClientPool tools over HTTP using the MCP Streamable HTTP protocol.
 * This allows external SDK subprocesses (Codex, Copilot) to access pool-managed
 * MCP source tools through a single HTTP endpoint instead of connecting to each
 * source independently.
 *
 * Uses Streamable HTTP transport in stateless mode because Codex uses the
 * Streamable HTTP protocol (POST-based JSON-RPC). Stateless mode means no
 * session tracking — each request is independent.
 *
 * Architecture:
 *   Codex/Copilot SDK subprocess
 *       ↓ (HTTP Streamable HTTP protocol)
 *   McpPoolServer (this, in Electron main process)
 *       ↓
 *   McpClientPool
 *       ↓ (per-source MCP connections)
 *   Linear / GitHub / Notion / etc.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import {
  createMcpHandler,
  Server as McpProtocolServer,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
  type NodeMcpRequestHandler,
} from '@modelcontextprotocol/node';
import type { Tool } from '@modelcontextprotocol/client';
import type { McpClientPool } from './mcp-pool.ts';

export class McpPoolServer {
  private pool: McpClientPool;
  private httpServer: HttpServer | null = null;
  private mcpHandler: McpHttpHandler | null = null;
  private nodeHandler: NodeMcpRequestHandler | null = null;
  private debugFn: ((msg: string) => void) | undefined;
  private _port = 0;

  constructor(pool: McpClientPool, options?: { debug?: (msg: string) => void }) {
    this.pool = pool;
    this.debugFn = options?.debug;
  }

  private debug(msg: string): void {
    this.debugFn?.(`[McpPoolServer] ${msg}`);
  }

  get port(): number {
    return this._port;
  }

  get url(): string {
    return `http://127.0.0.1:${this._port}/mcp`;
  }

  /**
   * Start the HTTP MCP server on a random port.
   * Returns the URL clients should connect to.
   */
  async start(): Promise<string> {
    if (this.httpServer) {
      return this.url;
    }

    // The v2 handler classifies each request and serves both protocol eras:
    // modern 2026-07-28 requests are stateless and legacy 2025 requests use
    // the SDK's stateless compatibility path. A fresh protocol instance is
    // created per request so no identity or capabilities leak across callers.
    this.mcpHandler = createMcpHandler(
      () => this.createMcpServer(),
      {
        legacy: 'stateless',
        onerror: (error) => this.debug(`MCP handler error: ${error.message}`),
      },
    );
    this.nodeHandler = toNodeHandler(this.mcpHandler, {
      onerror: (error) => this.debug(`MCP Node adapter error: ${error.message}`),
    });

    const validateHost = localhostHostValidation();
    const validateOrigin = localhostOriginValidation();

    this.httpServer = createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1`);
      if (url.pathname !== '/mcp') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      // The endpoint is loopback-only, and the guards prevent a hostile web
      // origin or DNS-rebinding Host header from reaching the MCP handler.
      if (!validateHost(req, res) || !validateOrigin(req, res)) return;

      await this.nodeHandler!(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(0, '127.0.0.1', () => {
        const addr = this.httpServer!.address();
        this._port = typeof addr === 'object' && addr ? addr.port : 0;
        this.debug(`Listening on 127.0.0.1:${this._port}`);
        resolve();
      });
      this.httpServer!.on('error', reject);
    });

    return this.url;
  }

  /**
   * Create an MCP Server instance wired to the pool.
   * Tools from pool use `mcp__craft__search_spaces` naming internally.
   * We strip the `mcp__` prefix so Codex (which adds its own `mcp__sources__`
   * prefix based on the POOL_SERVER_MCP_NAME) sees clean names:
   *   pool internal: mcp__craft__search_spaces
   *   exposed here:  craft__search_spaces
   *   Codex sees:    mcp__sources__craft__search_spaces
   */
  private createMcpServer(): McpProtocolServer {
    const server = new McpProtocolServer(
      { name: 'craft-pool-proxy', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    // List tools — proxy from pool, strip `mcp__` prefix
    server.setRequestHandler('tools/list', async () => {
      const proxyDefs = this.pool.getProxyToolDefs();
      return {
        tools: proxyDefs.map(def => ({
          name: def.name.replace(/^mcp__/, ''),
          description: def.description,
          inputSchema: def.inputSchema as Tool['inputSchema'],
        })),
      };
    });

    // Call tool — add `mcp__` prefix back before routing through pool
    server.setRequestHandler('tools/call', async (request) => {
      const { name, arguments: args } = request.params;
      const internalName = `mcp__${name}`;
      this.debug(`Tool call: ${name} → ${internalName}`);

      const result = await this.pool.callTool(internalName, args || {});

      return {
        content: [{ type: 'text' as const, text: result.content }],
        ...(result.isError ? { isError: true } : {}),
      };
    });

    return server;
  }

  /**
   * Notify that the tool list has changed.
   * In stateless mode this is a no-op — source changes already trigger
   * `regenCodexConfigAndReconnect()` which restarts the app-server,
   * and it re-discovers tools on startup.
   */
  notifyToolsChanged(): void {
    this.debug('Tools changed (stateless mode — clients will discover on next connect)');
  }

  /**
   * Stop the HTTP server and close the transport.
   */
  async stop(): Promise<void> {
    if (this.mcpHandler) {
      await this.mcpHandler.close().catch(() => {});
      this.mcpHandler = null;
      this.nodeHandler = null;
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
      this._port = 0;
      this.debug('Stopped');
    }
  }
}
