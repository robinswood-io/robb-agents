/**
 * Source Test Handler
 *
 * Validates and tests a source configuration comprehensively.
 * Performs schema validation, completeness checks, icon handling,
 * connection tests, and auth verification.
 */
import { basename } from "node:path";
import type { SessionToolContext } from "../../context.ts";
import type { SourceConfig } from "../../types.ts";
import { resolveStdioConfig } from "@craft-agent/shared/utils";
import { getSourcePath } from "../../source-helpers.ts";

export async function testMcpConnection(
  ctx: SessionToolContext,
  source: SourceConfig,
  sourceSlug: string
): Promise<{ lines: string[]; success: boolean; hasError: boolean; error?: string }> {
  const lines: string[] = [];
  let success = false;
  let hasError = false;
  let error: string | undefined;

  if (source.mcp?.transport === 'stdio') {
    // Resolve platform overrides + expand path variables (runtime-only).
    const resolved = resolveStdioConfig(
      source.mcp,
      ctx.workspacePath,
      getSourcePath(ctx.workspacePath, sourceSlug),
    );
    if (!resolved) {
      hasError = true;
      error = 'No command configured';
      lines.push('✗ No command configured for stdio MCP source');
    } else {
      const expandedCommand = resolved.command;
      const expandedArgs = resolved.args;
      const expandedEnv = resolved.env;

      // Stdio MCP - use validateStdioMcpConnection if available
      if (ctx.validateStdioMcpConnection && source.mcp.command) {
        lines.push(`ℹ Testing stdio MCP: ${expandedCommand}`);
        try {
          const result = await ctx.validateStdioMcpConnection({
            command: expandedCommand,
            args: expandedArgs,
            ...(expandedEnv !== undefined ? { env: expandedEnv } : {}),
            cwd: getSourcePath(ctx.workspacePath, sourceSlug),
          });
          if (result.success) {
            success = true;
            lines.push(`✓ MCP server started successfully`);
            if (result.toolCount !== undefined) {
              lines.push(`  Tools available: ${result.toolCount}`);
              if (result.toolNames && result.toolNames.length > 0) {
                const preview = result.toolNames.slice(0, 5).join(', ');
                if (result.toolNames.length > 5) {
                  lines.push(`  Examples: ${preview}, ...`);
                } else {
                  lines.push(`  Tools: ${preview}`);
                }
              }
            }
            if (result.serverName) {
              lines.push(`  Server: ${result.serverName} v${result.serverVersion || 'unknown'}`);
            }
          } else {
            hasError = true;
            error = result.error || 'MCP validation failed';
            lines.push(`✗ ${error}`);
          }
        } catch (e) {
          hasError = true;
          error = e instanceof Error ? e.message : 'Unknown error';
          lines.push(`✗ Failed to test MCP server: ${error}`);
        }
      } else {
        // Basic check - just report config
        lines.push(`ℹ Stdio MCP source: ${expandedCommand}`);
        if (expandedArgs.length) {
          lines.push(`  Args: ${expandedArgs.join(' ')}`);
        }
        lines.push('  Connection test not available in this context — call the source\'s MCP tools directly to verify');
        success = true; // Config looks ok
      }
    }
  } else if (source.mcp?.url) {
    // HTTP/SSE MCP
    if (ctx.validateMcpConnection) {
      lines.push(`ℹ Testing MCP server: ${source.mcp.url}`);
      try {
        // Merge static headers with credential-store headers (if headerNames configured)
        let headers = source.mcp.headers ? { ...source.mcp.headers } : undefined;
        let accessToken: string | undefined;
        if (ctx.credentialManager) {
          const workspaceId = basename(ctx.workspacePath) || '';
          const loadedSource = {
            config: source,
            folderPath: getSourcePath(ctx.workspacePath, sourceSlug),
            workspaceRootPath: ctx.workspacePath,
            workspaceId,
          };

          if (source.mcp.headerNames?.length) {
            // Multi-header credential — credential value is JSON keyed by header name.
            try {
              const rawCred = await ctx.credentialManager.getToken(loadedSource);
              if (rawCred) {
                const parsed = JSON.parse(rawCred) as Record<string, string>;
                headers = { ...headers, ...parsed };
              }
            } catch {
              // Not JSON or no credential — continue without credential headers
            }
          } else if (source.mcp.authType === 'oauth' || source.mcp.authType === 'bearer') {
            // OAuth / bearer single-token path — mirror the runtime so the probe
            // sends an Authorization header. Cached token first, refresh fallback
            // only on miss (matches checkAuthStatus and TokenRefreshManager).
            try {
              accessToken =
                (await ctx.credentialManager.getToken(loadedSource)) ??
                (await ctx.credentialManager.refresh(loadedSource)) ??
                undefined;
            } catch {
              // Token resolution failed — fall through; the probe will surface
              // the resulting `needsAuth` / 401 the same way it always has.
            }
          }
        }
        const result = await ctx.validateMcpConnection({
          url: source.mcp.url,
          ...(source.mcp.transport !== undefined ? { transport: source.mcp.transport } : {}),
          ...(source.mcp.authType !== undefined ? { authType: source.mcp.authType } : {}),
          ...(headers !== undefined ? { headers } : {}),
          ...(accessToken !== undefined ? { accessToken } : {}),
        });
        if (result.success) {
          success = true;
          lines.push(`✓ MCP server connected`);
          if (result.toolCount !== undefined) {
            lines.push(`  Tools available: ${result.toolCount}`);
          }
          if (result.serverName) {
            lines.push(`  Server: ${result.serverName} v${result.serverVersion || 'unknown'}`);
          }
        } else if (result.needsAuth) {
          lines.push(`⚠ MCP server requires authentication`);
          if (source.mcp.authType === 'oauth') {
            lines.push('  Use source_oauth_trigger to authenticate');
          }
          success = true; // Server is reachable, just needs auth
        } else {
          hasError = true;
          error = result.error || 'MCP connection failed';
          lines.push(`✗ ${error}`);
        }
      } catch (e) {
        hasError = true;
        error = e instanceof Error ? e.message : 'Unknown error';
        lines.push(`✗ Failed to connect to MCP server: ${error}`);
      }
    } else {
      // Basic URL check
      lines.push(`ℹ MCP source URL: ${source.mcp.url}`);
      lines.push('  Connection test not available in this context — call the source\'s MCP tools directly to verify');
      success = true; // Config looks ok
    }
  } else {
    hasError = true;
    error = 'No MCP URL or command configured';
    lines.push('✗ No MCP URL or command configured');
  }

  return { lines, success, hasError, ...(error !== undefined ? { error } : {}) };
}

export function testLocalConnection(
  ctx: SessionToolContext,
  source: SourceConfig
): { lines: string[]; success: boolean; hasError: boolean; error?: string } {
  const lines: string[] = [];
  let success = false;
  let hasError = false;
  let error: string | undefined;

  if (!source.local?.path) {
    hasError = true;
    error = 'No local path configured';
    lines.push('✗ No local path configured');
    return { lines, success, hasError, error };
  }

  if (ctx.fs.exists(source.local.path)) {
    success = true;
    const isDir = ctx.fs.isDirectory(source.local.path);
    lines.push(`✓ Local path exists: ${source.local.path}`);
    lines.push(`  Type: ${isDir ? 'Directory' : 'File'}`);
  } else {
    hasError = true;
    error = 'Path not found';
    lines.push(`✗ Local path not found: ${source.local.path}`);
    lines.push('  Verify the path exists and is accessible');
  }

  return { lines, success, hasError, ...(error !== undefined ? { error } : {}) };
}
