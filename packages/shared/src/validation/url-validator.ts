/** Validate the documented Craft MCP URL shape locally, without an LLM call. */
import type { AgentError } from '../agent/errors.ts';

export interface UrlValidationResult {
  valid: boolean;
  error?: string;
  /** Retained for callers reading results from older versions. */
  typedError?: AgentError;
}

export async function validateMcpUrl(
  value: string,
  _apiKey?: string,
  _oauthToken?: string,
): Promise<UrlValidationResult> {
  if (!value || value !== value.trim() || /\s/.test(value)) {
    return { valid: false, error: 'Enter only the MCP URL, without spaces or additional text.' };
  }
  let url: URL;
  try { url = new URL(value); } catch {
    return { valid: false, error: 'Enter a valid HTTPS URL.' };
  }
  if (url.protocol !== 'https:' || url.hostname !== 'mcp.craft.do' || url.port) {
    return { valid: false, error: 'Use an HTTPS URL on mcp.craft.do.' };
  }
  if (url.username || url.password || url.search || url.hash) {
    return { valid: false, error: 'The MCP URL must not include credentials, query parameters or a fragment.' };
  }
  if (!/^\/links\/[A-Za-z0-9_-]+\/mcp\/?$/.test(url.pathname)) {
    return { valid: false, error: 'Use the MCP URL format https://mcp.craft.do/links/<link-id>/mcp.' };
  }
  return { valid: true };
}
