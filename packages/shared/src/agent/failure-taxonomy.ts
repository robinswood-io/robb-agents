/**
 * Structured failure classification shared by autonomous recovery paths.
 *
 * Explicit machine-readable fields always win over message heuristics. Text
 * matching is retained only as a compatibility fallback for providers and MCP
 * servers that do not expose an error code or HTTP status.
 */

export type AgentFailureClass =
  | 'interactive-auth-required'
  | 'credential-required'
  | 'permission-denied'
  | 'invalid-input'
  | 'conflict'
  | 'rate-limited'
  | 'timeout'
  | 'network-unavailable'
  | 'service-unavailable'
  | 'resource-exhausted'
  | 'model-unavailable'
  | 'backend-init-failed'
  | 'sandbox-denied'
  | 'unknown'

export type AgentFailureRetryability = 'safe' | 'conditional' | 'never'

export type AgentFailureRecovery =
  | 'retry'
  | 'provider-fallback'
  | 'browser-fallback'
  | 'request-authentication'
  | 'fix-input'
  | 'request-authorization'
  | 'stop'

export interface AgentFailureSignal {
  message: string
  toolName?: string
  code?: string
  httpStatus?: number
  retryAfterMs?: number
}

export interface AgentFailureClassification {
  failureClass: AgentFailureClass
  retryability: AgentFailureRetryability
  recovery: AgentFailureRecovery
  confidence: 'structured' | 'heuristic' | 'fallback'
  retryAfterMs?: number
}

function normalizedCode(code: string | undefined): string {
  return code?.trim().toUpperCase().replaceAll('-', '_') ?? ''
}

function result(
  failureClass: AgentFailureClass,
  retryability: AgentFailureRetryability,
  recovery: AgentFailureRecovery,
  confidence: AgentFailureClassification['confidence'],
  retryAfterMs?: number,
): AgentFailureClassification {
  return {
    failureClass,
    retryability,
    recovery,
    confidence,
    ...(typeof retryAfterMs === 'number' && retryAfterMs >= 0 ? { retryAfterMs } : {}),
  }
}

function classifyStructuredFailure(signal: AgentFailureSignal): AgentFailureClassification | null {
  const code = normalizedCode(signal.code)
  const status = signal.httpStatus

  if (
    code === 'MFA_REQUIRED'
    || code === 'OAUTH_REQUIRED'
    || code === 'INTERACTIVE_AUTH_REQUIRED'
  ) {
    return result('interactive-auth-required', 'never', 'request-authentication', 'structured')
  }
  if (
    code === 'CREDENTIAL_REQUIRED'
    || code === 'TOKEN_EXPIRED'
    || code === 'INVALID_TOKEN'
    || status === 401
  ) {
    return result('credential-required', 'never', 'request-authentication', 'structured')
  }
  if (code === 'PERMISSION_DENIED' || code === 'FORBIDDEN' || status === 403) {
    return result('permission-denied', 'never', 'request-authorization', 'structured')
  }
  if (
    code === 'INVALID_ARGUMENT'
    || code === 'VALIDATION_ERROR'
    || code === 'BAD_REQUEST'
    || status === 400
    || status === 422
  ) {
    return result('invalid-input', 'never', 'fix-input', 'structured')
  }
  if (code === 'CONFLICT' || status === 409) {
    return result('conflict', 'conditional', 'retry', 'structured', signal.retryAfterMs)
  }
  if (code === 'RATE_LIMITED' || code === 'RESOURCE_RATE_LIMITED' || status === 429) {
    return result('rate-limited', 'safe', 'provider-fallback', 'structured', signal.retryAfterMs)
  }
  if (code === 'TIMEOUT' || code === 'DEADLINE_EXCEEDED' || status === 408 || status === 504) {
    return result('timeout', 'safe', 'retry', 'structured', signal.retryAfterMs)
  }
  if (
    code === 'ECONNREFUSED'
    || code === 'ECONNRESET'
    || code === 'ENOTFOUND'
    || code === 'NETWORK_ERROR'
  ) {
    return result('network-unavailable', 'safe', 'browser-fallback', 'structured', signal.retryAfterMs)
  }
  if (code === 'MODEL_NOT_FOUND' || code === 'MODEL_UNAVAILABLE') {
    return result('model-unavailable', 'conditional', 'provider-fallback', 'structured')
  }
  if (code === 'BACKEND_INIT_FAILED' || code === 'BACKEND_CREATE_FAILED' || code === 'SPAWN_FAILED') {
    return result('backend-init-failed', 'conditional', 'provider-fallback', 'structured')
  }
  if (code === 'RESOURCE_EXHAUSTED' || code === 'OUT_OF_MEMORY' || status === 507) {
    return result('resource-exhausted', 'conditional', 'provider-fallback', 'structured', signal.retryAfterMs)
  }
  if (code === 'SANDBOX_DENIED' || code === 'POLICY_DENIED') {
    return result('sandbox-denied', 'never', 'request-authorization', 'structured')
  }
  if (
    code === 'SERVICE_UNAVAILABLE'
    || code === 'PROVIDER_UNAVAILABLE'
    || status === 502
    || status === 503
  ) {
    return result('service-unavailable', 'safe', 'provider-fallback', 'structured', signal.retryAfterMs)
  }

  return null
}

/**
 * Classify a provider/tool failure without retaining its raw payload.
 */
export function classifyAgentFailure(signal: AgentFailureSignal): AgentFailureClassification {
  const structured = classifyStructuredFailure(signal)
  if (structured) return structured

  const text = `${signal.code ?? ''} ${signal.message}`.toLowerCase()
  if (
    /\bmfa\b|multi[ -]?factor|two[ -]?factor|\boauth\b.*(?:required|login|sign[ -]?in|consent)|(?:required|login|sign[ -]?in|consent).*\boauth\b/.test(
      text,
    )
  ) {
    return result('interactive-auth-required', 'never', 'request-authentication', 'heuristic')
  }
  if (/credential|api key|access token|token.*expired|unauthori[sz]ed/.test(text)) {
    return result('credential-required', 'never', 'request-authentication', 'heuristic')
  }
  if (/forbidden|permission denied|not allowed|authorization required/.test(text)) {
    return result('permission-denied', 'never', 'request-authorization', 'heuristic')
  }
  if (/sandbox|policy denied|operation denied by policy/.test(text)) {
    return result('sandbox-denied', 'never', 'request-authorization', 'heuristic')
  }
  if (/invalid argument|validation failed|bad request|malformed|schema error/.test(text)) {
    return result('invalid-input', 'never', 'fix-input', 'heuristic')
  }
  if (/rate limit|too many requests|\b429\b|quota exceeded/.test(text)) {
    return result('rate-limited', 'safe', 'provider-fallback', 'heuristic', signal.retryAfterMs)
  }
  if (/deadline exceeded|timed? ?out|\b408\b|\b504\b/.test(text)) {
    return result('timeout', 'safe', 'retry', 'heuristic', signal.retryAfterMs)
  }
  if (/econnrefused|econnreset|enotfound|network error|fetch failed|connection refused/.test(text)) {
    return result('network-unavailable', 'safe', 'browser-fallback', 'heuristic', signal.retryAfterMs)
  }
  if (/model.+(not found|unavailable|unsupported)|unsupported model/.test(text)) {
    return result('model-unavailable', 'conditional', 'provider-fallback', 'heuristic')
  }
  if (/backend.+(create|creation|init)|spawn.+failed|failed.+spawn/.test(text)) {
    return result('backend-init-failed', 'conditional', 'provider-fallback', 'heuristic')
  }
  if (/out of memory|resource exhausted|disk full|no space left/.test(text)) {
    return result('resource-exhausted', 'conditional', 'provider-fallback', 'heuristic', signal.retryAfterMs)
  }
  if (/service unavailable|provider unavailable|bad gateway|\b502\b|\b503\b/.test(text)) {
    return result('service-unavailable', 'safe', 'provider-fallback', 'heuristic', signal.retryAfterMs)
  }
  if (/\bconflict\b|\b409\b|already exists/.test(text)) {
    return result('conflict', 'conditional', 'retry', 'heuristic', signal.retryAfterMs)
  }

  return result('unknown', 'conditional', 'browser-fallback', 'fallback')
}
