import { isUnknownArray } from '../../utils/json.ts';
import { createHash, randomBytes } from "node:crypto";
import type { ConnectorSecretLease } from "../http-drivers";
import type { SecretLeaseGrant } from "../../credentials/secret-lease-broker";
import type { ConnectorOAuthFlow, ConnectorOAuthHttpResponse, ConnectorOAuthProfile, ConnectorOAuthScopeMapping, ConnectorOAuthTokenSet, ConnectorOAuthTransport } from './contracts.ts';
import { ConnectorOAuthError } from './contracts.ts';

function base64Url(value: Buffer): string {
  return value.toString('base64url')
}

function requestedMappings(
  profile: ConnectorOAuthProfile,
  connectorScopes: string[],
): ConnectorOAuthScopeMapping[] {
  const uniqueScopes = [...new Set(connectorScopes)]
  const mappings = uniqueScopes.map((connectorScope) => {
    const mapping = profile.scopes.find((candidate) => candidate.connectorScope === connectorScope)
    if (!mapping) {
      throw new ConnectorOAuthError(
        'SCOPE_DENIED',
        `${profile.provider} does not declare connector scope ${connectorScope}`,
      )
    }
    return mapping
  })
  if (mappings.length === 0) {
    throw new ConnectorOAuthError('SCOPE_DENIED', 'At least one connector scope is required')
  }
  return mappings
}

export function prepareConnectorOAuthFlow(input: {
  profile: ConnectorOAuthProfile
  clientId: string
  redirectUri: string
  connectorScopes: string[]
  now?: () => string
  lifetimeMs?: number
}): ConnectorOAuthFlow {
  const clientId = input.clientId.trim()
  if (!clientId) throw new ConnectorOAuthError('INVALID_CONFIGURATION', 'OAuth clientId is required')
  let redirectUri: URL
  try {
    redirectUri = new URL(input.redirectUri)
  } catch {
    throw new ConnectorOAuthError('INVALID_CONFIGURATION', 'OAuth redirectUri must be absolute')
  }
  if (redirectUri.protocol !== 'https:' && redirectUri.hostname !== '127.0.0.1' && redirectUri.hostname !== 'localhost') {
    throw new ConnectorOAuthError(
      'INVALID_CONFIGURATION',
      'OAuth redirectUri must use HTTPS or an explicit loopback host',
    )
  }

  const mappings = requestedMappings(input.profile, input.connectorScopes)
  const state = base64Url(randomBytes(32))
  const codeVerifier = base64Url(randomBytes(48))
  const codeChallenge = base64Url(createHash('sha256').update(codeVerifier).digest())
  const url = new URL(input.profile.authorizationEndpoint)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri.toString())
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('state', state)
  url.searchParams.set('scope', mappings.map((mapping) => mapping.oauthScope).join(' '))
  if (input.profile.pkce !== 'unsupported') {
    url.searchParams.set('code_challenge', codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
  }
  for (const [key, value] of Object.entries(input.profile.authorizationParameters ?? {})) {
    url.searchParams.set(key, value)
  }

  const now = input.now?.() ?? new Date().toISOString()
  const lifetimeMs = input.lifetimeMs ?? 10 * 60_000
  return {
    provider: input.profile.provider,
    authorizationUrl: url.toString(),
    state,
    codeVerifier,
    redirectUri: redirectUri.toString(),
    requestedConnectorScopes: mappings.map((mapping) => mapping.connectorScope),
    requestedOAuthScopes: mappings.map((mapping) => mapping.oauthScope),
    createdAt: now,
    expiresAt: new Date(Date.parse(now) + lifetimeMs).toISOString(),
  }
}

function readString(body: object, key: string): string | undefined {
  const value: unknown = Reflect.get(body, key)
  return typeof value === 'string' && value.trim() ? value : undefined
}

function readPositiveNumber(body: object, key: string): number | undefined {
  const value: unknown = Reflect.get(body, key)
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function parseGrantedScopes(value: string | undefined): string[] {
  return value ? value.split(/[ ,]+/u).map((scope) => scope.trim()).filter(Boolean) : []
}

function basicAuthorization(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`
}

function tokenRequest(input: {
  profile: ConnectorOAuthProfile
  clientId: string
  clientSecret?: string
  parameters: URLSearchParams
}): { headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
  }
  input.parameters.set('client_id', input.clientId)
  if (input.profile.clientAuthentication !== 'none') {
    if (!input.clientSecret) {
      throw new ConnectorOAuthError(
        'MISSING_CLIENT_SECRET',
        `${input.profile.provider} requires a client secret for token exchange`,
      )
    }
    if (input.profile.clientAuthentication === 'basic') {
      headers["Authorization"] = basicAuthorization(input.clientId, input.clientSecret)
    } else {
      input.parameters.set('client_secret', input.clientSecret)
    }
  }
  return { headers, body: input.parameters.toString() }
}

function parseTokenResponse(
  response: ConnectorOAuthHttpResponse,
  now: string,
): ConnectorOAuthTokenSet {
  if (response.status < 200 || response.status >= 300) {
    throw new ConnectorOAuthError(
      'TOKEN_EXCHANGE_FAILED',
      `OAuth token endpoint returned HTTP ${response.status}`,
    )
  }
  if (!response.body || typeof response.body !== 'object' || isUnknownArray(response.body)) {
    throw new ConnectorOAuthError('INVALID_TOKEN_RESPONSE', 'OAuth token response must be an object')
  }
  const accessToken = readString(response.body, 'access_token')
  if (!accessToken) {
    throw new ConnectorOAuthError('INVALID_TOKEN_RESPONSE', 'OAuth token response has no access_token')
  }
  const expiresIn = readPositiveNumber(response.body, 'expires_in')
  const refreshToken = readString(response.body, 'refresh_token')
  return {
    accessToken,
    tokenType: readString(response.body, 'token_type') ?? 'Bearer',
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    ...(expiresIn ? { expiresAt: new Date(Date.parse(now) + Math.floor(expiresIn * 1000)).toISOString() } : {}),
    grantedOAuthScopes: parseGrantedScopes(readString(response.body, 'scope')),
  }
}

export async function exchangeConnectorOAuthCode(input: {
  profile: ConnectorOAuthProfile
  flow: ConnectorOAuthFlow
  returnedState: string
  code: string
  clientId: string
  clientSecret?: string
  transport: ConnectorOAuthTransport
  now?: () => string
  timeoutMs?: number
}): Promise<ConnectorOAuthTokenSet> {
  const now = input.now?.() ?? new Date().toISOString()
  if (input.returnedState !== input.flow.state) {
    throw new ConnectorOAuthError('INVALID_STATE', 'OAuth callback state does not match the active flow')
  }
  if (Date.parse(input.flow.expiresAt) <= Date.parse(now)) {
    throw new ConnectorOAuthError('FLOW_EXPIRED', 'OAuth authorization flow has expired')
  }
  if (input.flow.provider !== input.profile.provider) {
    throw new ConnectorOAuthError('INVALID_CONFIGURATION', 'OAuth flow provider does not match token profile')
  }
  const parameters = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.flow.redirectUri,
  })
  if (input.profile.pkce !== 'unsupported') {
    parameters.set('code_verifier', input.flow.codeVerifier)
  }
  const request = tokenRequest({
    profile: input.profile,
    clientId: input.clientId,
    ...(input.clientSecret !== undefined ? { clientSecret: input.clientSecret } : {}),
    parameters,
  })
  const response = await input.transport({
    method: 'POST',
    url: input.profile.tokenEndpoint,
    headers: request.headers,
    body: request.body,
    timeoutMs: input.timeoutMs ?? 15_000,
  })
  return parseTokenResponse(response, now)
}

export async function refreshConnectorOAuthToken(input: {
  profile: ConnectorOAuthProfile
  refreshToken: string
  clientId: string
  clientSecret?: string
  transport: ConnectorOAuthTransport
  now?: () => string
  timeoutMs?: number
}): Promise<ConnectorOAuthTokenSet> {
  const parameters = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
  })
  const request = tokenRequest({
    profile: input.profile,
    clientId: input.clientId,
    ...(input.clientSecret !== undefined ? { clientSecret: input.clientSecret } : {}),
    parameters,
  })
  const response = await input.transport({
    method: 'POST',
    url: input.profile.tokenEndpoint,
    headers: request.headers,
    body: request.body,
    timeoutMs: input.timeoutMs ?? 15_000,
  })
  const parsed = parseTokenResponse(response, input.now?.() ?? new Date().toISOString())
  return parsed.refreshToken ? parsed : { ...parsed, refreshToken: input.refreshToken }
}

export function createConnectorSecretLeaseFromOAuth(input: {
  grant: SecretLeaseGrant
  profile: ConnectorOAuthProfile
  tokenSet: ConnectorOAuthTokenSet
  requestedConnectorScopes: string[]
  fallbackLifetimeMs?: number
  now?: () => string
}): ConnectorSecretLease {
  const mappings = requestedMappings(input.profile, input.requestedConnectorScopes)
  const granted = new Set(input.tokenSet.grantedOAuthScopes)
  const connectorScopes = mappings
    .filter((mapping) => granted.has(mapping.oauthScope))
    .map((mapping) => mapping.connectorScope)
  if (connectorScopes.length !== mappings.length) {
    const missing = mappings
      .filter((mapping) => !granted.has(mapping.oauthScope))
      .map((mapping) => mapping.oauthScope)
    throw new ConnectorOAuthError(
      'SCOPE_DENIED',
      `OAuth token did not grant requested scopes: ${missing.join(', ')}`,
    )
  }
  const now = input.now?.() ?? new Date().toISOString()
  const tokenExpiresAt = input.tokenSet.expiresAt
    ?? new Date(Date.parse(now) + (input.fallbackLifetimeMs ?? 5 * 60_000)).toISOString()
  if (Date.parse(input.grant.expiresAt) > Date.parse(tokenExpiresAt)) {
    throw new ConnectorOAuthError(
      'SECRET_LEASE_INVALID',
      'Secret lease cannot outlive the OAuth access token',
    )
  }
  const ungrantedLeaseScopes = connectorScopes.filter((scope) => !input.grant.scopes.includes(scope))
  if (ungrantedLeaseScopes.length > 0) {
    throw new ConnectorOAuthError(
      'SECRET_LEASE_INVALID',
      `Secret lease is missing connector scopes: ${ungrantedLeaseScopes.join(', ')}`,
    )
  }
  return {
    grant: input.grant,
    value: input.tokenSet.accessToken,
  }
}

export const fetchConnectorOAuthTransport: ConnectorOAuthTransport = async (request) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs)
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    })
    const text = await response.text()
    let body: unknown = text
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    return { status: response.status, body }
  } finally {
    clearTimeout(timeout)
  }
}
