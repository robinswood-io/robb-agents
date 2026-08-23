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
  | 'execution-bridge-unavailable'
  | 'service-unavailable'
  | 'resource-exhausted'
  | 'model-unavailable'
  | 'backend-init-failed'
  | 'sandbox-denied'
  | 'unknown'

export type AgentFailureRetryability = 'safe' | 'conditional' | 'never'

export type AgentFailureRecovery =
  | 'retry'
  | 'runtime-reconnect'
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

const EXPLICIT_RUNTIME_BRIDGE_CODES = new Set([
  'EXECUTION_BRIDGE_UNAVAILABLE',
  'RUNTIME_BRIDGE_UNAVAILABLE',
  'TOOL_BRIDGE_CORRUPTED',
])

const CONTEXTUAL_RUNTIME_BRIDGE_CODES = new Set([
  'HANDLER_ERROR',
  'CLIENT_DISCONNECTED',
  'CLIENT_REQUEST_TIMEOUT',
  'REQUEST_TIMEOUT',
  'ECONNREFUSED',
])

function hasRuntimeBridgeContext(signal: AgentFailureSignal): boolean {
  const text = `${signal.message} ${signal.toolName ?? ''}`.toLowerCase()

  if (
    text.includes('execution bridge')
    || text.includes('runtime bridge')
    || text.includes('tool bridge')
    || text.includes('tools context')
    || text.includes('tool context')
    || text.includes('bridge is corrupted')
    || text.includes('bridge corrupted')
    || text.includes('command bridge')
    || text.includes('exec bridge')
    || text.includes('codex bridge')
    || text.includes('localhost:3201')
    || text.includes('localhost 3201')
    || text.includes('fix-errors')
    || text.includes('local agent')
    || text.includes('agent task')
    || text.includes('exec_command')
  ) {
    return true
  }

  return (
    (text.includes('connection refused') || text.includes('econnrefused'))
    && text.includes('3201')
  )
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
  if (
    EXPLICIT_RUNTIME_BRIDGE_CODES.has(code)
    || (CONTEXTUAL_RUNTIME_BRIDGE_CODES.has(code) && hasRuntimeBridgeContext(signal))
  ) {
    return result('execution-bridge-unavailable', 'safe', 'runtime-reconnect', 'structured', signal.retryAfterMs)
  }
  if (
    code === 'TIMEOUT'
    || code === 'DEADLINE_EXCEEDED'
    || code === 'REQUEST_TIMEOUT'
    || code === 'CLIENT_REQUEST_TIMEOUT'
    || status === 408
    || status === 504
  ) {
    return result('timeout', 'safe', 'retry', 'structured', signal.retryAfterMs)
  }
  if (
    code === 'ECONNREFUSED'
    || code === 'ECONNRESET'
    || code === 'ENOTFOUND'
    || code === 'NETWORK_ERROR'
    || code === 'CLIENT_DISCONNECTED'
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
  const words = new Set(text.split(/[^a-z0-9]+/).filter(Boolean))
  const containsAny = (terms: readonly string[]): boolean => terms.some(term => text.includes(term))
  if (
    words.has('mfa')
    || containsAny(['multi-factor', 'multi factor', 'multifactor', 'two-factor', 'two factor', 'twofactor'])
    || (words.has('oauth') && containsAny(['required', 'login', 'sign-in', 'sign in', 'consent']))
  ) {
    return result('interactive-auth-required', 'never', 'request-authentication', 'heuristic')
  }
  if (
    containsAny(['credential', 'api key', 'access token', 'unauthorized', 'unauthorised'])
    || (words.has('token') && words.has('expired'))
  ) {
    return result('credential-required', 'never', 'request-authentication', 'heuristic')
  }
  if (containsAny(['forbidden', 'permission denied', 'not allowed', 'authorization required'])) {
    return result('permission-denied', 'never', 'request-authorization', 'heuristic')
  }
  if (containsAny(['sandbox', 'policy denied', 'operation denied by policy'])) {
    return result('sandbox-denied', 'never', 'request-authorization', 'heuristic')
  }
  if (containsAny(['invalid argument', 'validation failed', 'bad request', 'malformed', 'schema error'])) {
    return result('invalid-input', 'never', 'fix-input', 'heuristic')
  }
  if (containsAny(['rate limit', 'too many requests', 'quota exceeded']) || words.has('429')) {
    return result('rate-limited', 'safe', 'provider-fallback', 'heuristic', signal.retryAfterMs)
  }
  if (hasRuntimeBridgeContext(signal)) {
    return result('execution-bridge-unavailable', 'safe', 'runtime-reconnect', 'heuristic', signal.retryAfterMs)
  }
  if (containsAny(['deadline exceeded', 'timed out', 'timeout']) || words.has('408') || words.has('504')) {
    return result('timeout', 'safe', 'retry', 'heuristic', signal.retryAfterMs)
  }
  if (containsAny(['econnrefused', 'econnreset', 'enotfound', 'network error', 'fetch failed', 'connection refused'])) {
    return result('network-unavailable', 'safe', 'browser-fallback', 'heuristic', signal.retryAfterMs)
  }
  if (
    text.includes('unsupported model')
    || (text.includes('model') && ['not found', 'unavailable', 'unsupported'].some(term => text.includes(term)))
  ) {
    return result('model-unavailable', 'conditional', 'provider-fallback', 'heuristic')
  }
  if (
    (text.includes('backend') && ['create', 'creation', 'init'].some(term => text.includes(term)))
    || (text.includes('spawn') && text.includes('failed'))
  ) {
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
