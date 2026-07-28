import { generatePKCE, generateState } from './pkce.ts';

export const GOOGLE_GEMINI_OAUTH_CONFIG = {
  AUTH_URL: 'https://accounts.google.com/o/oauth2/v2/auth',
  TOKEN_URL: 'https://oauth2.googleapis.com/token',
  CALLBACK_PORT: 1457,
  CALLBACK_PATH: '/oauth2callback',
  SCOPES: [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ],
} as const;

export interface GoogleGeminiOAuthCredentials {
  clientId: string;
  clientSecret: string;
}

type GoogleGeminiOAuthEnvironment = Readonly<Record<string, string | undefined>>;

export function loadGoogleGeminiOAuthCredentials(
  environment: GoogleGeminiOAuthEnvironment = process.env,
): GoogleGeminiOAuthCredentials {
  const clientId = environment.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = environment.GOOGLE_OAUTH_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) {
    throw new Error(
      'Google Gemini OAuth requires GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET',
    );
  }

  return { clientId, clientSecret };
}

export interface PreparedGoogleGeminiOAuth {
  authUrl: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface GoogleGeminiTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  idToken?: string;
  email?: string;
}

export function prepareGoogleGeminiOAuth(
  redirectUri?: string,
  credentials: GoogleGeminiOAuthCredentials = loadGoogleGeminiOAuthCredentials(),
): PreparedGoogleGeminiOAuth {
  const state = generateState();
  const { codeVerifier, codeChallenge } = generatePKCE();
  const finalRedirectUri = redirectUri ?? `http://127.0.0.1:${GOOGLE_GEMINI_OAUTH_CONFIG.CALLBACK_PORT}${GOOGLE_GEMINI_OAUTH_CONFIG.CALLBACK_PATH}`;

  const params = new URLSearchParams({
    client_id: credentials.clientId,
    redirect_uri: finalRedirectUri,
    response_type: 'code',
    scope: GOOGLE_GEMINI_OAUTH_CONFIG.SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });

  return {
    authUrl: `${GOOGLE_GEMINI_OAUTH_CONFIG.AUTH_URL}?${params.toString()}`,
    state,
    codeVerifier,
    redirectUri: finalRedirectUri,
  };
}

async function exchangeTokenRequest(params: URLSearchParams): Promise<GoogleGeminiTokens> {
  const response = await fetch(GOOGLE_GEMINI_OAUTH_CONFIG.TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const data = await response.json().catch(() => ({})) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    id_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !data.access_token) {
    const detail = data.error_description || data.error || response.statusText;
    throw new Error(`Google Gemini OAuth token exchange failed: ${detail}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + Math.max(0, (data.expires_in ?? 3600) - 60) * 1000,
    idToken: data.id_token,
  };
}

export async function exchangeGoogleGeminiTokens(
  code: string,
  codeVerifier: string,
  redirectUri?: string,
  credentials: GoogleGeminiOAuthCredentials = loadGoogleGeminiOAuthCredentials(),
): Promise<GoogleGeminiTokens> {
  return exchangeTokenRequest(new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri ?? `http://127.0.0.1:${GOOGLE_GEMINI_OAUTH_CONFIG.CALLBACK_PORT}${GOOGLE_GEMINI_OAUTH_CONFIG.CALLBACK_PATH}`,
    grant_type: 'authorization_code',
  }));
}

export async function refreshGoogleGeminiTokens(
  refreshToken: string,
  credentials: GoogleGeminiOAuthCredentials = loadGoogleGeminiOAuthCredentials(),
): Promise<GoogleGeminiTokens> {
  return exchangeTokenRequest(new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }));
}
