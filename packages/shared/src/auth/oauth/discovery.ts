import { isUnknownArray } from '../../utils/json.ts';
import { URL } from "url";
import type { OAuthMetadata, ProtectedResourceMetadata } from './contracts.ts';

/**
 * Try to fetch OAuth authorization server metadata from a specific URL.
 * Returns the metadata if successful, null if not found or error.
 */
async function tryFetchAuthServerMetadata(
  url: string,
  onLog?: (message: string) => void
): Promise<OAuthMetadata | null> {
  try {
    onLog?.(`  Trying: ${url}`);
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json() as OAuthMetadata;
      if (data.authorization_endpoint && data.token_endpoint) {
        onLog?.(`  ✓ Found OAuth metadata at ${url}`);
        return data;
      }
      onLog?.(`  ✗ Invalid metadata at ${url} (missing required fields)`);
    } else {
      onLog?.(`  ✗ ${response.status} at ${url}`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    onLog?.(`  ✗ Error fetching ${url}: ${msg}`);
  }
  return null;
}

/** Default timeout for OAuth discovery requests (5 seconds) */
const DISCOVERY_TIMEOUT_MS = 5000;

/**
 * Check if a URL is safe to fetch (SSRF protection).
 * Rejects private IPs, localhost, and non-HTTPS URLs.
 */
function isUrlSafeToFetch(urlString: string): { safe: boolean; reason?: string } {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { safe: false, reason: 'Invalid URL' };
  }

  // Must be HTTPS (allow HTTP only for localhost in dev)
  if (url.protocol !== 'https:') {
    return { safe: false, reason: 'URL must use HTTPS' };
  }

  // Check hostname for private IP ranges
  const hostname = url.hostname.toLowerCase();

  // Block localhost variants
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return { safe: false, reason: 'Localhost not allowed' };
  }

  // Block private IP ranges (basic check - covers most cases)
  // This catches: 10.x.x.x, 172.16-31.x.x, 192.168.x.x, 169.254.x.x
  const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipMatch) {
    const a = Number(ipMatch[1]);
    const b = Number(ipMatch[2]);
    if (
      a === 0 ||                             // 0.0.0.0/8
      a === 10 ||                           // 10.0.0.0/8
      a === 127 ||                          // 127.0.0.0/8
      (a === 172 && b >= 16 && b <= 31) ||  // 172.16.0.0/12
      (a === 192 && b === 168) ||           // 192.168.0.0/16
      (a === 169 && b === 254)              // 169.254.0.0/16 (link-local/AWS metadata)
    ) {
      return { safe: false, reason: 'Private IP range not allowed' };
    }
  }

  return { safe: true };
}

/**
 * Type guard for ProtectedResourceMetadata
 */
function isProtectedResourceMetadata(data: unknown): data is ProtectedResourceMetadata {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;

  // resource is required
  if (typeof obj["resource"] !== 'string') return false;

  // authorization_servers is optional but must be string array if present
  if (obj["authorization_servers"] !== undefined) {
    if (!isUnknownArray(obj["authorization_servers"])) return false;
    if (!obj["authorization_servers"].every((s: unknown) => typeof s === 'string')) return false;
  }

  return true;
}

/**
 * Fetch with timeout using AbortController
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = DISCOVERY_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Normalize URL by removing trailing slash
 */
function normalizeUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Parse the resource_metadata URL from a WWW-Authenticate header.
 * Example header: Bearer error="invalid_token", resource_metadata="https://example.com/.well-known/oauth-protected-resource/path"
 * Supports both double and single quoted values per RFC 7235.
 */
function parseResourceMetadataFromHeader(wwwAuthenticate: string | null): string | null {
  if (!wwwAuthenticate) return null;

  // Look for resource_metadata="..." or resource_metadata='...' in the header
  // Also handles optional spaces around the equals sign
  const match = wwwAuthenticate.match(/resource_metadata\s*=\s*["']([^"']+)["']/);
  return match?.[1] ?? null;
}

/**
 * Fetch protected resource metadata and return the authorization server URL.
 * Per RFC 9728, the protected resource metadata contains authorization_servers array.
 */
async function fetchProtectedResourceMetadata(
  metadataUrl: string,
  onLog?: (message: string) => void
): Promise<string | null> {
  // SSRF protection: validate URL before fetching
  const urlCheck = isUrlSafeToFetch(metadataUrl);
  if (!urlCheck.safe) {
    onLog?.(`  ✗ Unsafe URL rejected: ${urlCheck.reason}`);
    return null;
  }

  try {
    onLog?.(`  Fetching protected resource metadata...`);
    const response = await fetchWithTimeout(metadataUrl);
    if (!response.ok) {
      onLog?.(`  ✗ ${response.status} at metadata endpoint`);
      return null;
    }

    const data: unknown = await response.json();

    // Type guard validation
    if (!isProtectedResourceMetadata(data)) {
      onLog?.(`  ✗ Invalid protected resource metadata format`);
      return null;
    }

    // Check for non-empty authorization_servers array
    if (!data.authorization_servers?.length) {
      onLog?.(`  ✗ No authorization_servers in protected resource metadata`);
      return null;
    }

    const authServer = data.authorization_servers[0]!;

    // Validate the auth server URL too
    const authServerCheck = isUrlSafeToFetch(authServer);
    if (!authServerCheck.safe) {
      onLog?.(`  ✗ Unsafe authorization server URL rejected: ${authServerCheck.reason}`);
      return null;
    }

    onLog?.(`  ✓ Found authorization server`);
    return authServer;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      onLog?.(`  ✗ Request timeout fetching protected resource metadata`);
    } else {
      const msg = error instanceof Error ? error.message : String(error);
      onLog?.(`  ✗ Error fetching protected resource metadata: ${msg}`);
    }
    return null;
  }
}

/**
 * Try to discover OAuth metadata via RFC 9728 flow:
 * 1. Make a request to the MCP endpoint to get 401 with WWW-Authenticate header
 * 2. Parse resource_metadata URL from the header
 * 3. Fetch protected resource metadata
 * 4. Get authorization server URL and fetch its metadata
 */
async function discoverViaProtectedResource(
  mcpUrl: string,
  onLog?: (message: string) => void
): Promise<OAuthMetadata | null> {
  try {
    onLog?.(`  Trying RFC 9728 protected resource discovery...`);

    // Make a request to the MCP endpoint to trigger 401
    // Try HEAD first, fall back to GET, then POST (Streamable HTTP servers only accept POST)
    let response: Response;
    try {
      response = await fetchWithTimeout(mcpUrl, { method: 'HEAD' });
      // Some servers don't support HEAD, fall back to GET
      if (response.status === 405) {
        onLog?.(`  HEAD not supported, trying GET...`);
        response = await fetchWithTimeout(mcpUrl, { method: 'GET' });
      }
      // Streamable HTTP MCP servers only accept POST.
      // POST is not a safe HTTP method, but this is acceptable here:
      // 1. We only proceed if the response is 401 (all other statuses are ignored)
      // 2. The endpoint is user-configured and trusted by design
      // 3. The body '{}' is a no-op for JSON-RPC servers (missing required fields)
      if (response.status === 405) {
        onLog?.(`  GET not supported, trying POST...`);
        response = await fetchWithTimeout(mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        onLog?.(`  ✗ Request timeout`);
      }
      return null;
    }

    // We expect a 401 with WWW-Authenticate header
    if (response.status !== 401) {
      onLog?.(`  ✗ Expected 401, got ${response.status}`);
      return null;
    }

    const wwwAuth = response.headers.get('www-authenticate');
    const resourceMetadataUrl = parseResourceMetadataFromHeader(wwwAuth);

    if (!resourceMetadataUrl) {
      onLog?.(`  ✗ No resource_metadata in WWW-Authenticate header`);
      return null;
    }

    // SSRF protection: validate the resource_metadata URL
    const urlCheck = isUrlSafeToFetch(resourceMetadataUrl);
    if (!urlCheck.safe) {
      onLog?.(`  ✗ Unsafe resource_metadata URL rejected: ${urlCheck.reason}`);
      return null;
    }

    onLog?.(`  Found resource_metadata hint`);

    // Fetch protected resource metadata to get authorization server
    const authServerUrl = await fetchProtectedResourceMetadata(resourceMetadataUrl, onLog);
    if (!authServerUrl) {
      return null;
    }

    // Fetch authorization server metadata (normalize URL to avoid double slashes)
    const normalizedAuthServer = normalizeUrl(authServerUrl);
    const authServerMetadataUrl = `${normalizedAuthServer}/.well-known/oauth-authorization-server`;
    return await tryFetchAuthServerMetadata(authServerMetadataUrl, onLog);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    onLog?.(`  ✗ RFC 9728 discovery failed: ${msg}`);
    return null;
  }
}

/**
 * Discovers OAuth metadata using progressive discovery per RFC 8414 and RFC 9728.
 * Returns the first successful metadata, or null if all fail.
 *
 * Discovery order:
 * 1. RFC 9728: Parse resource_metadata from WWW-Authenticate header on 401
 * 2. Origin root: `{origin}/.well-known/oauth-authorization-server`
 * 3. Path-scoped: `{origin}/.well-known/oauth-authorization-server{pathname}`
 */
export async function discoverOAuthMetadata(
  mcpUrl: string,
  onLog?: (message: string) => void
): Promise<OAuthMetadata | null> {
  let url: URL;
  try {
    url = new URL(mcpUrl);
  } catch {
    onLog?.(`Invalid MCP URL: ${mcpUrl}`);
    return null;
  }

  onLog?.(`Discovering OAuth metadata for ${mcpUrl}`);

  // 1. Try RFC 9728 protected resource discovery first (handles Craft MCP and other compliant servers)
  const rfc9728Metadata = await discoverViaProtectedResource(mcpUrl, onLog);
  if (rfc9728Metadata) {
    return rfc9728Metadata;
  }

  // 2. Fall back to RFC 8414 discovery locations
  const candidates = [
    // Origin root (most common for MCP servers)
    `${url.origin}/.well-known/oauth-authorization-server`,
    // Path-scoped (RFC 8414 allows this)
    `${url.origin}/.well-known/oauth-authorization-server${url.pathname}`,
  ];

  for (const candidate of candidates) {
    const metadata = await tryFetchAuthServerMetadata(candidate, onLog);
    if (metadata) {
      return metadata;
    }
  }

  onLog?.(`No OAuth metadata found for ${mcpUrl}`);
  return null;
}
