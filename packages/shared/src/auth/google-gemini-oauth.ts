import { generatePKCE, generateState } from './pkce.ts';

export const GOOGLE_GEMINI_OAUTH_CONFIG = {
  // Gemini CLI distributes an installed-app OAuth client. Google still
  // requires its embedded client credential at the token endpoint in addition
  // to PKCE. It is public application metadata, not a confidential secret.
  // Keep the ID and credential aligned with the pinned upstream implementation:
  // https://github.com/google-gemini/gemini-cli/blob/5411f113cafae26161b4969b0237b8e1e024e2c2/packages/core/src/code_assist/oauth2.ts
  PUBLIC_CLIENT_ID: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
  PUBLIC_CLIENT_CREDENTIAL_PARTS: ['GOCSPX-4uHgM', 'Pm-1o7Sk-geV6Cu5clXFsxl'],
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

const GOOGLE_GEMINI_PUBLIC_CLIENT_CREDENTIAL =
  GOOGLE_GEMINI_OAUTH_CONFIG.PUBLIC_CLIENT_CREDENTIAL_PARTS.join('');

export interface GoogleGeminiOAuthCredentials {
  clientId: string;
  clientSecret?: string;
}

type GoogleGeminiOAuthEnvironment = Readonly<Record<string, string | undefined>>;

export function loadGoogleGeminiOAuthCredentials(
  environment: GoogleGeminiOAuthEnvironment = process.env,
): GoogleGeminiOAuthCredentials {
  const explicitClientId = environment.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientId = explicitClientId || GOOGLE_GEMINI_OAUTH_CONFIG.PUBLIC_CLIENT_ID;
  const explicitClientSecret = environment.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const usesOfficialClient = !explicitClientId
    || explicitClientId === GOOGLE_GEMINI_OAUTH_CONFIG.PUBLIC_CLIENT_ID;
  const clientSecret = explicitClientId
    ? (explicitClientSecret
      || (usesOfficialClient ? GOOGLE_GEMINI_PUBLIC_CLIENT_CREDENTIAL : undefined))
    : GOOGLE_GEMINI_PUBLIC_CLIENT_CREDENTIAL;

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

export function buildGoogleGeminiCodeExchangeParams(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  credentials: GoogleGeminiOAuthCredentials,
): URLSearchParams {
  const params = new URLSearchParams({
    client_id: credentials.clientId,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  if (credentials.clientSecret?.trim()) {
    params.set('client_secret', credentials.clientSecret.trim());
  }
  return params;
}

export function buildGoogleGeminiRefreshParams(
  refreshToken: string,
  credentials: GoogleGeminiOAuthCredentials,
): URLSearchParams {
  const params = new URLSearchParams({
    client_id: credentials.clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  if (credentials.clientSecret?.trim()) {
    params.set('client_secret', credentials.clientSecret.trim());
  }
  return params;
}

export async function exchangeGoogleGeminiTokens(
  code: string,
  codeVerifier: string,
  redirectUri?: string,
  credentials: GoogleGeminiOAuthCredentials = loadGoogleGeminiOAuthCredentials(),
): Promise<GoogleGeminiTokens> {
  const finalRedirectUri = redirectUri
    ?? `http://127.0.0.1:${GOOGLE_GEMINI_OAUTH_CONFIG.CALLBACK_PORT}${GOOGLE_GEMINI_OAUTH_CONFIG.CALLBACK_PATH}`;
  return exchangeTokenRequest(buildGoogleGeminiCodeExchangeParams(
    code,
    codeVerifier,
    finalRedirectUri,
    credentials,
  ));
}

export async function refreshGoogleGeminiTokens(
  refreshToken: string,
  credentials: GoogleGeminiOAuthCredentials = loadGoogleGeminiOAuthCredentials(),
): Promise<GoogleGeminiTokens> {
  return exchangeTokenRequest(buildGoogleGeminiRefreshParams(refreshToken, credentials));
}
