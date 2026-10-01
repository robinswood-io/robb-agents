/**
 * MCP client using the official split @modelcontextprotocol/client SDK
 * Supports both HTTP and stdio transports for remote and local MCP servers
 */

import {
  Client,
  StreamableHTTPClientTransport,
  type ProtocolEra,
  type Transport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { buildRestrictedSubprocessEnvironment } from '../processes/subprocess-env.ts';
import {
  expectLongRunningChildPid,
  type ExpectedChildProcessHandle,
} from '../processes/long-running-supervisor.ts';

/**
 * HTTP transport config for remote MCP servers
 */
export interface HttpMcpClientConfig {
  transport: 'http';
  url: string;
  headers?: Record<string, string>;
}

/**
 * Stdio transport config for local MCP servers (spawns subprocess)
 */
export interface StdioMcpClientConfig {
  transport: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Unified config supporting both transport types
 */
export type McpClientConfig = HttpMcpClientConfig | StdioMcpClientConfig;

/**
 * Tool shape shared by the v2 remote client and the still-v1 in-process API
 * adapter. Keeping this pool boundary structural avoids coupling the rest of
 * the application to either SDK era's JSON Schema type aliases.
 */
export interface PoolTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    idempotentHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  };
}

/**
 * Build the environment for one configured stdio MCP source.
 *
 * `config.env` is the source's explicit grant and may contain credentials the
 * server actually needs. Unrelated host variables are never inherited.
 */
export function buildStdioMcpSubprocessEnvironment(
  configEnv?: Record<string, string>,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return buildRestrictedSubprocessEnvironment(configEnv, baseEnv);
}

/**
 * Interface for clients managed by McpClientPool.
 * Both CraftMcpClient (remote MCP sources) and ApiSourcePoolClient (API sources) implement this.
 */
export interface PoolClient {
  listTools(): Promise<PoolTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export class CraftMcpClient {
  private client: Client;
  private transport: Transport;
  private stdioTransport?: StdioClientTransport;
  private expectedChildHandle?: ExpectedChildProcessHandle;
  private connected = false;

  constructor(config: McpClientConfig, private readonly ownerId = 'mcp-source') {
    this.client = new Client(
      {
        name: 'craft-agent',
        version: '1.0.0',
      },
      {
        capabilities: {},
        // Probe 2026-07-28 first, then conservatively fall back to the
        // byte-compatible 2025 initialize handshake for legacy servers.
        versionNegotiation: { mode: 'auto' },
      },
    );

    // Create transport based on config type
    if (config.transport === 'stdio') {
      // Stdio transport for local MCP servers. Inherit a strict operational
      // baseline, then layer only this source's explicitly configured env.
      this.stdioTransport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: buildStdioMcpSubprocessEnvironment(config.env),
      });
      this.transport = this.stdioTransport;
    } else {
      // HTTP transport for remote MCP servers
      this.transport = new StreamableHTTPClientTransport(
        new URL(config.url),
        {
          requestInit: {
            headers: config.headers,
          },
        }
      );
    }
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    await this.client.connect(this.transport);
    const pid = this.stdioTransport?.pid;
    if (pid) {
      this.expectedChildHandle = expectLongRunningChildPid(pid, `mcp:${this.ownerId}`);
    }

    // Verify connection works by listing tools
    try {
      await this.client.listTools();
    } catch (error) {
      await this.client.close();
      throw new Error(
        `MCP connection failed health check: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    this.connected = true;
  }

  async listTools(): Promise<PoolTool[]> {
    if (!this.connected) {
      await this.connect();
    }

    const result = await this.client.listTools();
    return result.tools;
  }

  /**
   * Returns server name/version reported during the MCP handshake.
   * Available after `connect()` resolves; undefined otherwise.
   */
  getServerInfo(): { name: string; version: string } | undefined {
    const info = this.client.getServerVersion();
    if (!info) return undefined;
    return { name: info.name, version: info.version };
  }

  /** Protocol era selected by automatic negotiation after connect(). */
  getProtocolEra(): ProtocolEra | undefined {
    return this.client.getProtocolEra();
  }

  /** Exact MCP protocol revision selected by automatic negotiation. */
  getNegotiatedProtocolVersion(): string | undefined {
    return this.client.getNegotiatedProtocolVersion();
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) {
      await this.connect();
    }

    const result = await this.client.callTool({ name, arguments: args });
    return result;
  }

  async close(): Promise<void> {
    try {
      if (this.connected) {
        await this.client.close();
        this.connected = false;
      }
    } finally {
      this.expectedChildHandle?.release();
      this.expectedChildHandle = undefined;
    }
  }
}
