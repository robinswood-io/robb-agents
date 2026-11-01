import { randomBytes, createHash } from "crypto";

export interface OAuthConfig {
  mcpUrl: string; // Full MCP URL including path (e.g., https://mcp.craft.do/my/mcp)
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType: string;
}

export interface OAuthCallbacks {
  onStatus: (message: string) => void;
  onError: (error: string) => void;
}

// Port range for OAuth callback server - tries ports sequentially until one is available
export const CALLBACK_PORT_START = 8914;

export const CALLBACK_PORT_END = 8924;

export const CALLBACK_PATH = '/oauth/callback';

export const CLIENT_NAME = 'Claude Code (Craft Agent)';

// Generate PKCE code verifier and challenge
export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// Generate random state for CSRF protection
export function generateState(): string {
  return randomBytes(16).toString('hex');
}

export interface OAuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

/**
 * Protected resource metadata per RFC 9728
 */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers?: string[];
}
