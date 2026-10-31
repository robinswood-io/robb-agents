import type { SessionToolContext } from "../../context.ts";
import type { SourceConfig } from "../../types.ts";
import { testApiConnectionBasic, testApiConnectionWithAuth } from './api-test.ts';
import { testLocalConnection, testMcpConnection } from './mcp-and-local-test.ts';

// ============================================================
// Connection Test
// ============================================================

export async function testConnection(
  ctx: SessionToolContext,
  source: SourceConfig,
  sourceSlug: string
): Promise<{ lines: string[]; success: boolean; hasError: boolean; error?: string }> {
  const lines: string[] = [];
  let success = false;
  let hasError = false;
  let error: string | undefined;

  if (source.type === 'api') {
    const result = await testApiConnection(ctx, source, sourceSlug);
    lines.push(...result.lines);
    success = result.success;
    hasError = result.hasError;
    error = result.error;
  } else if (source.type === 'mcp') {
    const result = await testMcpConnection(ctx, source, sourceSlug);
    lines.push(...result.lines);
    success = result.success;
    hasError = result.hasError;
    error = result.error;
  } else if (source.type === 'local') {
    const result = testLocalConnection(ctx, source);
    lines.push(...result.lines);
    success = result.success;
    hasError = result.hasError;
    error = result.error;
  } else {
    lines.push('ℹ No connection test available for this source type');
    success = true;
  }

  return { lines, success, hasError, ...(error !== undefined ? { error } : {}) };
}

async function testApiConnection(
  ctx: SessionToolContext,
  source: SourceConfig,
  sourceSlug: string
): Promise<{ lines: string[]; success: boolean; hasError: boolean; error?: string }> {
  const lines: string[] = [];
  let success = false;
  let hasError = false;
  let error: string | undefined;

  if (!source.api?.baseUrl) {
    lines.push('✗ No API base URL configured');
    hasError = true;
    error = 'No base URL';
    return { lines, success, hasError, error };
  }

  // If ctx has advanced testApiSource, use it
  if (ctx.testApiSource) {
    try {
      const result = await ctx.testApiSource(source);
      if (result.success) {
        success = true;
        lines.push(`✓ API endpoint reachable`);
        if (result.status) {
          lines.push(`  Status: ${result.status}`);
        }
      } else {
        hasError = true;
        error = result.error || 'Connection failed';
        lines.push(`✗ ${result.error || 'Connection failed'}`);
        if (result.hint) {
          lines.push(`  ${result.hint}`);
        }
      }
      return { lines, success, hasError, ...(error !== undefined ? { error } : {}) };
    } catch (e) {
      // Fall through to built-in test
    }
  }

  // Build test URL
  const testUrl = source.api.testEndpoint
    ? `${source.api.baseUrl}${source.api.testEndpoint.path}`
    : source.api.baseUrl;

  // Try authenticated request if credentials available
  if (source.isAuthenticated && ctx.credentialManager && source.api.authType !== 'none') {
    const authResult = await testApiConnectionWithAuth(ctx, source, sourceSlug, testUrl);
    if (authResult.attempted) {
      return authResult;
    }
    // If auth test wasn't attempted (no token), fall through to basic test
  }

  // Basic connection test (no auth)
  return testApiConnectionBasic(source, testUrl);
}
