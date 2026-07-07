import { generatePKCE, generateState } from './pkce.ts';

export const GOOGLE_GEMINI_OAUTH_CONFIG = {
  CLIENT_ID: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
  CLIENT_SECRET: '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',
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

export function prepareGoogleGeminiOAuth(redirectUri?: string): PreparedGoogleGeminiOAuth {
  const state = generateState();
  const { codeVerifier, codeChallenge } = generatePKCE();
  const finalRedirectUri = redirectUri ?? `http://127.0.0.1:${GOOGLE_GEMINI_OAUTH_CONFIG.CALLBACK_PORT}${GOOGLE_GEMINI_OAUTH_CONFIG.CALLBACK_PATH}`;

  const params = new URLSearchParams({
    client_id: GOOGLE_GEMINI_OAUTH_CONFIG.CLIENT_ID,
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
): Promise<GoogleGeminiTokens> {
  return exchangeTokenRequest(new URLSearchParams({
    client_id: GOOGLE_GEMINI_OAUTH_CONFIG.CLIENT_ID,
    client_secret: GOOGLE_GEMINI_OAUTH_CONFIG.CLIENT_SECRET,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri ?? `http://127.0.0.1:${GOOGLE_GEMINI_OAUTH_CONFIG.CALLBACK_PORT}${GOOGLE_GEMINI_OAUTH_CONFIG.CALLBACK_PATH}`,
    grant_type: 'authorization_code',
  }));
}

export async function refreshGoogleGeminiTokens(refreshToken: string): Promise<GoogleGeminiTokens> {
  return exchangeTokenRequest(new URLSearchParams({
    client_id: GOOGLE_GEMINI_OAUTH_CONFIG.CLIENT_ID,
    client_secret: GOOGLE_GEMINI_OAUTH_CONFIG.CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }));
}
