export type ConnectorSandboxProvider =
  | 'microsoft365'
  | 'googleWorkspace'
  | 'slack'
  | 'hubspot'
  | 'genericCrm'
  | 'genericErp'

export interface ConnectorSandboxRequest {
  method: 'GET'
  url: string
  headers: Record<string, string>
  timeoutMs: number
}

export interface ConnectorSandboxResponse {
  status: number
  body: unknown
}

export type ConnectorSandboxTransport = (
  request: ConnectorSandboxRequest,
) => Promise<ConnectorSandboxResponse>

export interface ConnectorSandboxResult {
  provider: ConnectorSandboxProvider
  endpoint: string
  status: number
  authenticated: boolean
}

export class ConnectorSandboxError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_CONFIGURATION'
      | 'AUTHENTICATION_FAILED'
      | 'UPSTREAM_ERROR'
      | 'INVALID_RESPONSE',
    message: string,
  ) {
    super(message)
    this.name = 'ConnectorSandboxError'
  }
}

const sandboxEndpoints: Partial<Record<ConnectorSandboxProvider, string>> = {
  microsoft365: 'https://graph.microsoft.com/v1.0/me/drive?$select=id,driveType',
  googleWorkspace: 'https://www.googleapis.com/drive/v3/about?fields=user,storageQuota',
  slack: 'https://slack.com/api/auth.test',
  hubspot: 'https://api.hubapi.com/crm/v3/objects/contacts?limit=1&archived=false',
}

function validateEndpoint(endpoint: string): string {
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    throw new ConnectorSandboxError('INVALID_CONFIGURATION', 'Sandbox endpoint must be an absolute HTTPS URL')
  }
  if (parsed.protocol !== 'https:') {
    throw new ConnectorSandboxError('INVALID_CONFIGURATION', 'Sandbox endpoint must use HTTPS')
  }
  return parsed.toString()
}

function slackResponseIsAuthenticated(body: unknown): boolean {
  return Boolean(
    body
    && typeof body === 'object'
    && !Array.isArray(body)
    && Reflect.get(body, 'ok') === true,
  )
}

export async function runConnectorSandboxProbe(input: {
  provider: ConnectorSandboxProvider
  accessToken: string
  endpoint?: string
  transport: ConnectorSandboxTransport
  timeoutMs?: number
}): Promise<ConnectorSandboxResult> {
  if (!input.accessToken.trim()) {
    throw new ConnectorSandboxError('INVALID_CONFIGURATION', 'Sandbox access token is required')
  }
  const builtIn = sandboxEndpoints[input.provider]
  const endpoint = validateEndpoint(input.endpoint ?? builtIn ?? '')
  const response = await input.transport({
    method: 'GET',
    url: endpoint,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${input.accessToken}`,
      'User-Agent': 'Robb-Agents-Connector-Conformance/1.0',
    },
    timeoutMs: input.timeoutMs ?? 15_000,
  })
  if (response.status === 401 || response.status === 403) {
    throw new ConnectorSandboxError(
      'AUTHENTICATION_FAILED',
      `${input.provider} sandbox rejected the credential with HTTP ${response.status}`,
    )
  }
  if (response.status < 200 || response.status >= 300) {
    throw new ConnectorSandboxError(
      'UPSTREAM_ERROR',
      `${input.provider} sandbox returned HTTP ${response.status}`,
    )
  }
  if (!response.body || typeof response.body !== 'object' || Array.isArray(response.body)) {
    throw new ConnectorSandboxError(
      'INVALID_RESPONSE',
      `${input.provider} sandbox did not return a JSON object`,
    )
  }
  if (input.provider === 'slack' && !slackResponseIsAuthenticated(response.body)) {
    throw new ConnectorSandboxError('AUTHENTICATION_FAILED', 'Slack auth.test returned ok=false')
  }
  return {
    provider: input.provider,
    endpoint,
    status: response.status,
    authenticated: true,
  }
}

export const fetchConnectorSandboxTransport: ConnectorSandboxTransport = async (request) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs)
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
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
