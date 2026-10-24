/**
 * MCP Connection Validation
 *
 * Validates HTTP/SSE MCP servers by connecting directly via CraftMcpClient
 * and listing tools. Avoids spawning a Claude Code subprocess (which is killed
 * by Electron's macOS sandbox — see issue #697).
 */
import { CraftMcpClient } from "../client.js";
import { debug } from "../../utils/debug.ts";
import { normalizeMcpUrl } from "../../sources/server-builder.ts";
import type { InvalidProperty, McpValidationConfig, McpValidationResult } from './tool-validation.ts';
import { findInvalidProperties } from './tool-validation.ts';

/**
 * Map a low-level connection error to a user-actionable result.
 * Heuristic — keep simple, the underlying message is preserved as the source of truth.
 */
function classifyConnectionError(err: unknown): McpValidationResult {
  const message = err instanceof Error ? err.message : String(err);
  let errorType: McpValidationResult['errorType'] = 'failed';
  if (/\b401\b|\b403\b|unauthorized|forbidden|authentication/i.test(message)) {
    errorType = 'needs-auth';
  }
  return {
    success: false,
    error: message || 'Validation failed',
    errorType,
  };
}

/**
 * Validates an HTTP/SSE MCP connection by connecting via CraftMcpClient and
 * listing tools. The internal `connect()` call performs a `listTools()` health
 * check, so a successful connect proves the server is reachable and responsive.
 */
export async function validateMcpConnection(
  config: McpValidationConfig
): Promise<McpValidationResult> {
  debug('Validating MCP connection to', config.mcpUrl);

  const mcpUrl = normalizeMcpUrl(config.mcpUrl);

  // Custom headers first, auth header overrides.
  const headers = {
    ...config.mcpHeaders,
    ...(config.mcpAccessToken ? { Authorization: `Bearer ${config.mcpAccessToken}` } : {}),
  };

  // SSE transport is not supported by CraftMcpClient (HTTP only). Streamable
  // HTTP is the modern transport; SSE servers will surface a clear connect error.
  const mcpClient = new CraftMcpClient({
    transport: 'http',
    url: mcpUrl,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
  });

  try {
    await mcpClient.connect();
    const serverInfo = mcpClient.getServerInfo();

    const tools = await mcpClient.listTools();
    const toolNames = tools.map((t) => t.name);

    debug(`Validating schemas for ${tools.length} tools`);

    const allInvalidProperties: InvalidProperty[] = [];
    for (const tool of tools) {
      if (tool.inputSchema && typeof tool.inputSchema === 'object') {
        const invalidProps = findInvalidProperties(
          tool.inputSchema as Record<string, unknown>
        );
        for (const prop of invalidProps) {
          allInvalidProperties.push({
            toolName: tool.name,
            propertyPath: prop.path,
            propertyKey: prop.key,
          });
        }
      }
    }

    if (allInvalidProperties.length > 0) {
      const toolsWithIssues = [
        ...new Set(allInvalidProperties.map((p) => p.toolName)),
      ];
      return {
        success: false,
        error: `Server has ${allInvalidProperties.length} invalid property name(s) in ${toolsWithIssues.length} tool(s): ${toolsWithIssues.join(', ')}. Property names must match ^[a-zA-Z0-9_.-]{1,64}$`,
        errorType: 'invalid-schema',
        serverInfo,
        invalidProperties: allInvalidProperties,
        tools: toolNames,
      };
    }

    return {
      success: true,
      serverInfo,
      tools: toolNames,
    };
  } catch (err) {
    debug('[mcp-validation] error:', err instanceof Error ? err.message : err);
    return classifyConnectionError(err);
  } finally {
    await mcpClient.close().catch(() => {});
  }
}

export interface StdioValidationConfig {
  /** Command to spawn (e.g., 'npx', 'node') */
  command: string;
  /** Arguments to pass to the command */
  args?: string[];
  /** Environment variables for the spawned process */
  env?: Record<string, string>;
  /** Working directory for the spawned process (default: source folder) */
  cwd?: string;
  /** Timeout in ms (default: 30000) */
  timeout?: number;
}

/**
 * Get a user-friendly error message based on the validation result.
 * Accepts optional transport context to distinguish local (stdio) vs remote failures.
 */
export function getValidationErrorMessage(
  result: McpValidationResult,
  context?: { transport?: string }
): string {
  // Prefer the SDK's error field when available (most specific)
  if (result.error) return result.error;

  switch (result.errorType) {
    case 'failed':
      // Distinguish local stdio servers (crashed/not running) from remote (unreachable)
      if (context?.transport === 'stdio') {
        return 'Server process not running or failed to start.';
      }
      return 'Server unreachable - check the URL and your network.';
    case 'needs-auth':
      return 'Authentication expired or was revoked.';
    case 'pending':
      return 'Connection is still pending - try again.';
    case 'invalid-schema':
      return 'Server has tools with invalid property names.';
    case 'unknown':
    default:
      return 'Connection failed - check source configuration.';
  }
}
