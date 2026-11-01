import type { SourceMcpAuthType } from './provider-inference.ts';

/**
 * MCP transport type for sources
 * - 'http': HTTP-based MCP server (URL endpoint)
 * - 'sse': Deprecated legacy Server-Sent Events transport (persisted configs only)
 * - 'stdio': Local subprocess MCP server (spawned command)
 */
export type McpTransport = 'http' | 'sse' | 'stdio';

/**
 * Platform identifier matching Node.js process.platform values.
 * Used as keys in the `platform` override block.
 */
export type McpPlatform = 'win32' | 'darwin' | 'linux';

/**
 * Stdio fields that can be overridden per-platform.
 */
export interface McpPlatformOverride {
  /** Command to spawn (overrides default for this platform). */
  command?: string;
  /** Arguments (overrides default args entirely for this platform). */
  args?: string[];
  /** Environment variables (merged on top of default env for this platform). */
  env?: Record<string, string>;
}

/**
 * MCP-specific configuration
 * Supports both HTTP-based and local stdio-based MCP servers.
 *
 * For cross-platform configs, use the `platform` field to override
 * stdio fields (command, args, env) per OS:
 * ```json
 * {
 *   "command": "npx",
 *   "args": ["server.js"],
 *   "platform": {
 *     "win32": { "command": "npx.cmd" },
 *     "darwin": { "env": { "DYLD_LIBRARY_PATH": "/opt/homebrew/lib" } }
 *   }
 * }
 * ```
 */
export interface McpSourceConfig {
  /**
   * Transport type. Defaults to 'http' if not specified.
   * The 'sse' value is retained only to read and migrate existing configs.
   */
  transport?: McpTransport;

  // === HTTP/SSE transport fields ===
  /**
   * URL endpoint for HTTP or SSE transport.
   * Required when transport is 'http' or 'sse' (or undefined).
   */
  url?: string;

  /**
   * Authentication type for HTTP/SSE servers.
   */
  authType?: SourceMcpAuthType;

  /**
   * OAuth client ID (stored in config, not secret).
   */
  clientId?: string;

  // === Stdio transport fields ===
  /**
   * Command to spawn for stdio transport.
   * Required when transport is 'stdio'.
   */
  command?: string;

  /**
   * Arguments to pass to the command.
   */
  args?: string[];

  /**
   * Environment variables for the spawned process.
   */
  env?: Record<string, string>;

  // === HTTP/SSE custom headers ===
  /**
   * Custom headers to include in every MCP request.
   * Auth headers (e.g. Authorization) are merged on top when authType is set.
   */
  headers?: Record<string, string>;

  /**
   * Header names for credential-store auth (e.g., ["X-API-Key"]).
   * Values are stored as JSON in the credential store, same as API multi-header auth.
   * Precedence: static headers < credential-store headerNames < Authorization bearer.
   */
  headerNames?: string[];

  // === Platform overrides (stdio only) ===
  /**
   * Per-platform overrides for stdio command, args, and env.
   * Keys are Node.js platform identifiers: "win32", "darwin", "linux".
   * When the current platform matches a key, its values are applied:
   * - command: replaces the default command
   * - args: replaces the default args entirely
   * - env: merged on top of the default env (not replaced)
   *
   * @example
   * // Use npx.cmd on Windows, npx elsewhere
   * {
   *   "command": "npx",
   *   "platform": { "win32": { "command": "npx.cmd" } }
   * }
   */
  platform?: Partial<Record<McpPlatform, McpPlatformOverride>>;
}
