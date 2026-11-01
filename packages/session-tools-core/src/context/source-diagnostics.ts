/**
 * Session Tools Core - Context Interface
 *
 * Defines the abstract context interface that both Claude (in-process)
 * and Codex (subprocess) implementations must provide.
 *
 * This enables writing tool handlers once and running them in both environments.
 */
import type { McpSourceConfig } from "../types.ts";

// ============================================================
// MCP Validation Types
// ============================================================

/**
 * Config for stdio MCP connection validation
 */
export interface StdioMcpConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * Config for HTTP/SSE MCP connection validation.
 * Derived from McpSourceConfig to stay in sync automatically (DRY).
 *
 * `accessToken` is the resolved OAuth / bearer token for sources whose
 * credential lives in the credential store (no `headerNames`). The probe
 * forwards it to the underlying impl, which builds an
 * `Authorization: Bearer …` header — matching the runtime path.
 */
export type HttpMcpConfig = Required<Pick<McpSourceConfig, 'url'>>
  & Pick<McpSourceConfig, 'authType' | 'headers' | 'headerNames' | 'transport'>
  & { accessToken?: string };

/**
 * Result from stdio MCP validation
 */
export interface StdioValidationResult {
  success: boolean;
  error?: string;
  toolCount?: number;
  toolNames?: string[];
  serverName?: string;
  serverVersion?: string;
}

/**
 * Result from HTTP MCP validation
 */
export interface McpValidationResult {
  success: boolean;
  error?: string;
  needsAuth?: boolean;
  toolCount?: number;
  toolNames?: string[];
  serverName?: string;
  serverVersion?: string;
}

/**
 * Result from API source test
 */
export interface ApiTestResult {
  success: boolean;
  status?: number;
  error?: string;
  hint?: string;
}
