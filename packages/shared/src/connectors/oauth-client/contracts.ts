
export type ConnectorOAuthProvider =
  | 'microsoft365'
  | 'googleWorkspace'
  | 'slack'
  | 'hubspot'
  | 'genericCrm'
  | 'genericErp'

export interface ConnectorOAuthScopeMapping {
  connectorScope: string
  oauthScope: string
}

export interface ConnectorOAuthProfile {
  provider: ConnectorOAuthProvider
  authorizationEndpoint: string
  tokenEndpoint: string
  clientAuthentication: 'none' | 'body' | 'basic'
  pkce: 'required' | 'supported' | 'unsupported'
  scopes: ConnectorOAuthScopeMapping[]
  authorizationParameters?: Record<string, string>
}

export interface ConnectorOAuthFlow {
  provider: ConnectorOAuthProvider
  authorizationUrl: string
  state: string
  codeVerifier: string
  redirectUri: string
  requestedConnectorScopes: string[]
  requestedOAuthScopes: string[]
  createdAt: string
  expiresAt: string
}

export interface ConnectorOAuthTokenSet {
  accessToken: string
  tokenType: string
  refreshToken?: string
  expiresAt?: string
  grantedOAuthScopes: string[]
}

export interface ConnectorOAuthHttpRequest {
  method: 'POST'
  url: string
  headers: Record<string, string>
  body: string
  timeoutMs: number
}

export interface ConnectorOAuthHttpResponse {
  status: number
  body: unknown
}

export type ConnectorOAuthTransport = (
  request: ConnectorOAuthHttpRequest,
) => Promise<ConnectorOAuthHttpResponse>

export class ConnectorOAuthError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_CONFIGURATION'
      | 'INVALID_STATE'
      | 'FLOW_EXPIRED'
      | 'TOKEN_EXCHANGE_FAILED'
      | 'INVALID_TOKEN_RESPONSE'
      | 'MISSING_CLIENT_SECRET'
      | 'SECRET_LEASE_INVALID'
      | 'SCOPE_DENIED',
    message: string,
  ) {
    super(message)
    this.name = 'ConnectorOAuthError'
  }
}

export interface ConnectorOAuthProfileOptions {
  tenantId?: string
  authorizationEndpoint?: string
  tokenEndpoint?: string
  scopes?: ConnectorOAuthScopeMapping[]
}
