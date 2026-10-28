import type { ConnectorOAuthProfile, ConnectorOAuthProfileOptions, ConnectorOAuthProvider } from './contracts.ts';
import { ConnectorOAuthError } from './contracts.ts';

const builtInProfiles: Record<
  Exclude<ConnectorOAuthProvider, 'genericCrm' | 'genericErp'>,
  ConnectorOAuthProfile
> = {
  microsoft365: {
    provider: 'microsoft365',
    authorizationEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    clientAuthentication: 'body',
    pkce: 'required',
    scopes: [
      { connectorScope: 'Files.Read', oauthScope: 'Files.Read' },
      { connectorScope: 'Files.ReadWrite', oauthScope: 'Files.ReadWrite' },
      { connectorScope: 'offline_access', oauthScope: 'offline_access' },
    ],
    authorizationParameters: { response_mode: 'query' },
  },
  googleWorkspace: {
    provider: 'googleWorkspace',
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    clientAuthentication: 'body',
    pkce: 'required',
    scopes: [
      {
        connectorScope: 'drive.readonly',
        oauthScope: 'https://www.googleapis.com/auth/drive.readonly',
      },
      {
        connectorScope: 'drive.file',
        oauthScope: 'https://www.googleapis.com/auth/drive.file',
      },
    ],
    authorizationParameters: {
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: 'consent',
    },
  },
  slack: {
    provider: 'slack',
    authorizationEndpoint: 'https://slack.com/oauth/v2/authorize',
    tokenEndpoint: 'https://slack.com/api/oauth.v2.access',
    clientAuthentication: 'body',
    pkce: 'unsupported',
    scopes: [
      { connectorScope: 'channels.history', oauthScope: 'channels:history' },
      { connectorScope: 'chat.write', oauthScope: 'chat:write' },
    ],
  },
  hubspot: {
    provider: 'hubspot',
    authorizationEndpoint: 'https://app.hubspot.com/oauth/authorize',
    tokenEndpoint: 'https://api.hubapi.com/oauth/v1/token',
    clientAuthentication: 'body',
    pkce: 'unsupported',
    scopes: [
      {
        connectorScope: 'crm.objects.read',
        oauthScope: 'crm.objects.contacts.read',
      },
      {
        connectorScope: 'crm.objects.write',
        oauthScope: 'crm.objects.contacts.write',
      },
    ],
  },
}

function profileEndpoint(endpoint: string, label: string): string {
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    throw new ConnectorOAuthError('INVALID_CONFIGURATION', `${label} must be an absolute HTTPS URL`)
  }
  if (parsed.protocol !== 'https:') {
    throw new ConnectorOAuthError('INVALID_CONFIGURATION', `${label} must use HTTPS`)
  }
  return parsed.toString()
}

export function createConnectorOAuthProfile(
  provider: ConnectorOAuthProvider,
  options: ConnectorOAuthProfileOptions = {},
): ConnectorOAuthProfile {
  if (provider === 'genericCrm' || provider === 'genericErp') {
    if (!options.authorizationEndpoint || !options.tokenEndpoint || !options.scopes?.length) {
      throw new ConnectorOAuthError(
        'INVALID_CONFIGURATION',
        `${provider} requires authorizationEndpoint, tokenEndpoint and explicit scope mappings`,
      )
    }
    return {
      provider,
      authorizationEndpoint: profileEndpoint(options.authorizationEndpoint, 'authorizationEndpoint'),
      tokenEndpoint: profileEndpoint(options.tokenEndpoint, 'tokenEndpoint'),
      clientAuthentication: 'body',
      pkce: 'supported',
      scopes: options.scopes.map((scope) => ({ ...scope })),
    }
  }

  const builtIn = builtInProfiles[provider]
  const tenantId = options.tenantId?.trim()
  const authorizationEndpoint = provider === 'microsoft365' && tenantId
    ? `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/authorize`
    : builtIn.authorizationEndpoint
  const tokenEndpoint = provider === 'microsoft365' && tenantId
    ? `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`
    : builtIn.tokenEndpoint
  return {
    ...builtIn,
    authorizationEndpoint,
    tokenEndpoint,
    scopes: builtIn.scopes.map((scope) => ({ ...scope })),
    ...(builtIn.authorizationParameters ? { authorizationParameters: { ...builtIn.authorizationParameters } } : {}),
  }
}
