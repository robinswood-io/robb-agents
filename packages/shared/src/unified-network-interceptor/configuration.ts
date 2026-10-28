
// Type alias for fetch's HeadersInit
export type HeadersInitType = Headers | Record<string, string> | string[][];

/**
 * When `CRAFT_DEBUG_SSE_RAW=1`, the OpenAI strip streams dump every raw SSE
 * line they see (in) and emit (out) to interceptor.log. Used to diagnose
 * upstream SSE shape issues (e.g. DeepSeek's two-phase tool_call emission).
 * Independent of the broader DEBUG flag — opt-in only because raw chunks are
 * verbose and may contain user prompts/tool args.
 */
export const DEBUG_SSE_RAW = process.env["CRAFT_DEBUG_SSE_RAW"] === '1';

// ============================================================================
// PROXY CONFIGURATION (from env vars injected by parent process)
// ============================================================================

export const PROXY_URL = process.env["HTTPS_PROXY"] || process.env["https_proxy"]
  || process.env["HTTP_PROXY"] || process.env["http_proxy"] || '';

export const NO_PROXY = process.env["NO_PROXY"] || process.env["no_proxy"] || '';

/** Strip credentials from a proxy URL, returning only scheme://host:port */
export function redactProxyUrl(proxyUrl: string): string {
  try {
    const parsed = new URL(proxyUrl);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '(invalid proxy URL)';
  }
}

/** Parse NO_PROXY into hostname patterns for bypass matching. */
const noProxyPatterns: string[] = NO_PROXY
  ? NO_PROXY.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  : [];

/** Check if a URL should bypass the proxy based on NO_PROXY rules. */
function shouldBypassProxy(url: string): boolean {
  if (noProxyPatterns.length === 0) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return noProxyPatterns.some(pattern => {
      if (pattern === '*') return true;
      // .example.com matches any subdomain of example.com
      if (pattern.startsWith('.')) return hostname.endsWith(pattern);
      // exact match or subdomain match
      return hostname === pattern || hostname.endsWith('.' + pattern);
    });
  } catch {
    return false;
  }
}

/** Get the proxy URL for a given request URL, or undefined to go direct. */
export function getProxyForUrl(url: string): string | undefined {
  if (
    process.env["CRAFT_STRICT_LOCAL_ENDPOINT"] === '1' &&
    process.env["ROBB_ALLOW_LOCAL_MODEL_WEB_TOOLS"] !== '1'
  ) {
    return undefined;
  }
  if (!PROXY_URL || shouldBypassProxy(url)) return undefined;
  return PROXY_URL;
}
