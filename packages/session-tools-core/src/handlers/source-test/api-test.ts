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

/**
 * Test API connection WITH authentication credentials.
 * Returns attempted=false if credentials couldn't be retrieved.
 */
export async function testApiConnectionWithAuth(
  ctx: SessionToolContext,
  source: SourceConfig,
  sourceSlug: string,
  testUrl: string
): Promise<{ lines: string[]; success: boolean; hasError: boolean; error?: string; attempted: boolean }> {
  const lines: string[] = [];

  // Build LoadedSource for credential manager
  const workspaceId = basename(ctx.workspacePath) || '';
  const loadedSource = {
    config: source,
    folderPath: getSourcePath(ctx.workspacePath, sourceSlug),
    workspaceRootPath: ctx.workspacePath,
    workspaceId,
  };

  // Get token from credential manager
  let token: string | null = null;
  try {
    token = await ctx.credentialManager!.getToken(loadedSource);
  } catch {
    // Couldn't get token, will fall through to basic test
  }

  if (!token) {
    return { lines: [], success: false, hasError: false, attempted: false };
  }

  // Build auth headers based on authType
  const headers: Record<string, string> = {};
  let urlWithAuth = testUrl;

  switch (source.api!.authType) {
    case 'bearer':
    case 'oauth':
      // Generic OAuth tokens are sent as Bearer tokens
      headers['Authorization'] = `Bearer ${token}`;
      break;
    case 'basic': {
      // Vault value for source_basic is JSON `{"username","password"}` (written by
      // source_credential_prompt / WebUI). Parse and base64-encode to match what
      // api-tools.ts buildHeaders does at runtime. Fall through if the token is
      // already a non-JSON string (legacy / hand-edited vault entries).
      try {
        const parsed: unknown = JSON.parse(token);
        if (parsed && typeof parsed === 'object' && 'username' in parsed && 'password' in parsed
          && typeof parsed.username === 'string' && parsed.username && typeof parsed.password === 'string' && parsed.password) {
          const encoded = Buffer.from(`${parsed.username}:${parsed.password}`).toString('base64');
          headers['Authorization'] = `Basic ${encoded}`;
          break;
        }
      } catch {
        // Not JSON — pass through
      }
      headers['Authorization'] = `Basic ${token}`;
      break;
    }
    case 'header':
      // Custom header name
      if (source.api!.headerName) {
        headers[source.api!.headerName] = token;
      } else if (source.api!.headerNames && source.api!.headerNames.length > 0) {
        // Multi-header auth: token is JSON with header values
        const headerNames = source.api!.headerNames;
        try {
          const headerValues = JSON.parse(token) as Record<string, string>;
          for (const headerName of headerNames) {
            if (headerValues[headerName]) {
              headers[headerName] = headerValues[headerName];
            }
          }
        } catch {
          // Token is not valid JSON - this is a configuration error for multi-header auth
          const firstHeader = headerNames[0] || 'Header';
          return {
            lines: [`✗ Multi-header auth requires JSON token with header values`],
            success: false,
            hasError: true,
            error: `Expected JSON token like {"${firstHeader}": "value"} but got non-JSON string`,
            attempted: true,
          };
        }
      } else {
        // Fallback to X-API-Key if no header name specified
        headers['X-API-Key'] = token;
      }
      break;
    case 'query':
      // Add token as query parameter
      const paramName = source.api!.queryParam || 'api_key';
      const separator = testUrl.includes('?') ? '&' : '?';
      urlWithAuth = `${testUrl}${separator}${paramName}=${encodeURIComponent(token)}`;
      break;
  }

  // Make authenticated request
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const method = source.api!.testEndpoint?.method || 'GET';
    const body = source.api!.testEndpoint?.body;
    const extraHeaders = source.api!.testEndpoint?.headers;

    // Merge any per-endpoint headers; auth headers win on conflict so a stale
    // testEndpoint header can't shadow the live token.
    if (extraHeaders) {
      for (const [k, v] of Object.entries(extraHeaders)) {
        if (!(k in headers)) headers[k] = v;
      }
    }

    const init: RequestInit = { method, headers, signal: controller.signal };
    if (body !== undefined && method !== 'GET') {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      // Default to JSON only if no Content-Type was provided by testEndpoint.headers.
      const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
      if (!hasContentType) headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(urlWithAuth, init);

    clearTimeout(timeoutId);

    if (response.ok) {
      lines.push(`✓ API connection successful (authenticated)`);
      lines.push(`  Status: ${response.status}`);
      return { lines, success: true, hasError: false, attempted: true };
    } else if (response.status === 401 || response.status === 403) {
      lines.push(`✗ API returned ${response.status} (credentials invalid or expired)`);
      lines.push('  Re-authenticate the source to refresh credentials');
      return { lines, success: false, hasError: true, error: `Auth failed: ${response.status}`, attempted: true };
    } else if (response.status === 404) {
      lines.push(`⚠ API returned 404 (endpoint not found)`);
      if (source.api!.testEndpoint) {
        lines.push(`  Check if testEndpoint.path is correct: ${source.api!.testEndpoint.path}`);
      }
      return { lines, success: false, hasError: false, attempted: true };
    } else {
      lines.push(`⚠ API returned ${response.status}`);
      return { lines, success: false, hasError: false, attempted: true };
    }
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : 'Unknown error';
    lines.push(`✗ Connection failed: ${errorMsg}`);
    if (errorMsg.includes('abort')) {
      lines.push('  Request timed out after 10 seconds');
    }
    return { lines, success: false, hasError: true, error: errorMsg, attempted: true };
  }
}

/**
 * Basic API connection test WITHOUT authentication.
 * Used when no credentials are available.
 */
export async function testApiConnectionBasic(
  source: SourceConfig,
  testUrl: string
): Promise<{ lines: string[]; success: boolean; hasError: boolean; error?: string }> {
  const lines: string[] = [];
  let success = false;
  let hasError = false;
  let error: string | undefined;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    // If a testEndpoint.method was configured, honor it directly. The HEAD→GET
    // probe can't validate POST-only endpoints (it 405s, falls back to GET, and
    // typically gets another 405 the basic probe silently treats as soft pass).
    // We deliberately don't carry testEndpoint.body in the basic probe — this
    // path runs without credentials, so anything sensitive in the body would
    // leak; better to let the authed probe carry the body once auth is set up.
    const configuredMethod = source.api?.testEndpoint?.method;
    let response: Response | null;
    if (configuredMethod) {
      response = await fetch(testUrl, {
        method: configuredMethod,
        signal: controller.signal,
      }).catch(() => null);
    } else {
      // Try HEAD first
      response = await fetch(testUrl, {
        method: 'HEAD',
        signal: controller.signal,
      }).catch(() => null);

      // If HEAD returns 405, try GET
      if (response && response.status === 405) {
        response = await fetch(testUrl, {
          method: 'GET',
          signal: controller.signal,
        }).catch(() => null);
      }
    }

    clearTimeout(timeoutId);

    if (response) {
      if (response.ok) {
        success = true;
        lines.push(`✓ API endpoint reachable (${testUrl})`);
      } else if (response.status === 401 || response.status === 403) {
        // Auth required - endpoint is reachable but needs credentials
        success = true;
        lines.push(`⚠ API returned ${response.status} (authentication required)`);
        if (!source.isAuthenticated) {
          lines.push('  Authenticate the source to test with credentials');
        } else {
          lines.push('  Source is marked authenticated but credentials could not be retrieved');
        }
      } else if (response.status === 404) {
        lines.push(`⚠ API returned 404 (endpoint not found)`);
        if (source.api?.testEndpoint) {
          lines.push(`  Check if testEndpoint.path is correct: ${source.api.testEndpoint.path}`);
        } else {
          lines.push('  Consider adding testEndpoint configuration');
        }
      } else {
        lines.push(`⚠ API returned ${response.status}`);
      }
    } else {
      hasError = true;
      error = 'Connection failed';
      lines.push(`✗ Cannot reach API endpoint (${source.api?.baseUrl})`);
      lines.push('  Check if the URL is correct and the service is running');
    }
  } catch (e) {
    hasError = true;
    error = e instanceof Error ? e.message : 'Unknown error';
    lines.push(`✗ Connection failed: ${error}`);
    if (error.includes('abort')) {
      lines.push('  Request timed out after 10 seconds');
    }
  }

  return { lines, success, hasError, ...(error !== undefined ? { error } : {}) };
}
