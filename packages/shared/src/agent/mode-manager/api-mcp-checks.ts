/// <reference path="../../types/incr-regex-package.d.ts" />
import { classifyToolNameMutationSemantics } from "../core/tool-name-semantics.ts";
import type { PermissionsContext } from "../permissions-config.ts";
import { SAFE_MODE_CONFIG } from "../mode-types.ts";
import type { ToolCheckConfig } from './bash-contracts.ts';

/**
 * Check if an MCP tool is read-only using the given config
 */
export function isReadOnlyMcpToolWithConfig(toolName: string, config: ToolCheckConfig): boolean {
  if (classifyToolNameMutationSemantics(toolName) !== 'neutral') return false;
  return config.readOnlyMcpPatterns.some(pattern => pattern.test(toolName));
}

/**
 * Check if an API call is allowed using the given config
 * Checks fine-grained endpoint rules (method + path pattern)
 */
export function isApiCallAllowedWithConfig(method: string, path: string | undefined, config: ToolCheckConfig): boolean {
  const upperMethod = method.toUpperCase();

  // GET is always allowed
  if (upperMethod === 'GET') return true;

  // Check fine-grained endpoint rules (if path is available)
  if (path && config.allowedApiEndpoints) {
    for (const rule of config.allowedApiEndpoints) {
      if (rule.method === upperMethod && rule.pathPattern.test(path)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if an API endpoint is allowed based on permissions context.
 * Used in 'ask' mode to auto-allow whitelisted API endpoints from permissions.json.
 *
 * @param method - HTTP method (GET, POST, etc.)
 * @param path - API endpoint path
 * @param permissionsContext - Context for loading custom permissions
 * @returns true if endpoint is allowed (GET or matches allowedApiEndpoints rules)
 */
export function isApiEndpointAllowed(
  method: string,
  path: string | undefined,
  permissionsContext?: PermissionsContext
): boolean {
  let config: ToolCheckConfig;

  if (permissionsContext) {
    // Lazy import to avoid circular dependency
    const { permissionsConfigCache } = require("../permissions-config.ts");
    config = permissionsConfigCache.getMergedConfig(permissionsContext);
  } else {
    config = SAFE_MODE_CONFIG;
  }

  return isApiCallAllowedWithConfig(method, path, config);
}
