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
import { getSourcePath } from "../../source-helpers.ts";

// ============================================================
// Auth Status Check
// ============================================================

export async function checkAuthStatus(
  ctx: SessionToolContext,
  source: SourceConfig,
  sourceSlug: string
): Promise<{ lines: string[]; hasWarning: boolean }> {
  const lines: string[] = [];
  let hasWarning = false;

  if (source.isAuthenticated) {
    // In Codex context (no validateMcpConnection), MCP source credentials are delivered
    // via config.toml headers, not the credential cache. Skip token verification to avoid
    // false "token missing" warnings from the file-based cache.
    if (source.type === 'mcp' && !ctx.validateMcpConnection) {
      lines.push('✓ Source is authenticated');
    } else if (ctx.credentialManager) {
      const workspaceId = basename(ctx.workspacePath) || '';
      const loadedSource = {
        config: source,
        folderPath: getSourcePath(ctx.workspacePath, sourceSlug),
        workspaceRootPath: ctx.workspacePath,
        workspaceId,
      };

      try {
        const token = await ctx.credentialManager.getToken(loadedSource);
        if (token) {
          lines.push('✓ Source is authenticated (token valid)');
        } else {
          // Token missing or expired — attempt refresh before reporting failure.
          // OAuth tokens are short-lived (typically 1h) and frequently expired in the
          // credential store between uses. The normal connection pipeline refreshes
          // them proactively, so source_test should too.
          const refreshed = await ctx.credentialManager.refresh(loadedSource);
          if (refreshed) {
            lines.push('✓ Source is authenticated (token refreshed)');
          } else {
            hasWarning = true;
            lines.push('⚠ Source marked authenticated but token missing or refresh failed');
            lines.push('  Re-authenticate to refresh credentials');
          }
        }
      } catch {
        lines.push('✓ Source is authenticated');
      }
    } else {
      lines.push('✓ Source is authenticated');
    }
  } else {
    // Determine required auth type
    if (source.type === 'mcp' && source.mcp?.authType === 'oauth') {
      hasWarning = true;
      lines.push('⚠ Source not authenticated');
      lines.push('  Use source_oauth_trigger to authenticate');
    } else if (source.type === 'api') {
      if (source.provider === 'google') {
        hasWarning = true;
        lines.push('⚠ Source not authenticated');
        lines.push('  Use source_google_oauth_trigger to authenticate');
      } else if (source.provider === 'slack') {
        hasWarning = true;
        lines.push('⚠ Source not authenticated');
        lines.push('  Use source_slack_oauth_trigger to authenticate');
      } else if (source.provider === 'microsoft') {
        hasWarning = true;
        lines.push('⚠ Source not authenticated');
        lines.push('  Use source_microsoft_oauth_trigger to authenticate');
      } else if (source.api?.authType && source.api.authType !== 'none') {
        hasWarning = true;
        lines.push('⚠ Source not authenticated');
        lines.push('  Use source_credential_prompt to enter credentials');
      } else {
        lines.push('ℹ Source does not require authentication');
      }
    } else {
      lines.push('ℹ Source does not require authentication');
    }
  }

  return { lines, hasWarning };
}
