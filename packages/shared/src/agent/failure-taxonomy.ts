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
  // Node reports an overfull child-process output pipe as ENOBUFS. Retrying
  // through an unrelated browser cannot repair it; the caller must narrow the
  // structured read/output or use another structured connector operation.
  if (code === 'ENOBUFS' || code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return result('resource-exhausted', 'conditional', 'fix-input', 'structured', signal.retryAfterMs)
  }

  if (
    code === 'MFA_REQUIRED'
    || code === 'OAUTH_REQUIRED'
    || code === 'INTERACTIVE_AUTH_REQUIRED'
    || code === 'AUTHORIZATION_PENDING'
    || code === 'AUTHENTICATION_PENDING'
    || code === 'DEVICE_CODE_PENDING'
    || code === 'CONSENT_REQUIRED'
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

/** Recognize only host-refusal envelopes produced at the tool boundary. The
 * payload must start with the host's fixed label after at most two known plain
 * wrappers, or occupy the sole payload field of a closed JSON error object.
 * Searching arbitrary prose/JSON recursively would let external content
 * suppress normal recovery merely by quoting the label. */
function isObjectiveAuthorityRefusal(message: string): boolean {
  const raw = message.trim()
  if (!raw || raw.length > 8_192) return false
  const normalize = (value: string): string => value
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
  const direct = (value: string): boolean => (
    /^objective authority(?:\s*:|\s+(?:could not|cannot)\b)/u.test(normalize(value))
  )
  const wrappedDirect = (value: string): boolean => {
    let current = value.trim()
    for (let wrapperCount = 0; wrapperCount <= 2; wrapperCount += 1) {
      if (direct(current)) return true
      if (wrapperCount === 2) return false
      const envelope = /^(?:\[error\]\s*:?\s*|(?:error|tool\s+execution\s+failed|mcp\s+error)\s*:\s*)([\s\S]+)$/iu.exec(current)
      if (!envelope?.[1] || envelope[1].trim() === current) return false
      current = envelope[1].trim()
    }
    return false
  }
  if (wrappedDirect(raw)) return true
  if (!raw.startsWith('{') || !raw.endsWith('}')) return false
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    const record = parsed as Record<string, unknown>
    const keys = Object.keys(record)
    const allowedKeys = new Set(['error', 'message', 'code', 'name', 'status', 'success'])
    const payloadKeys = ['error', 'message'].filter(key => Object.hasOwn(record, key))
    if (keys.length === 0 || keys.length > allowedKeys.size
      || payloadKeys.length !== 1 || keys.some(key => !allowedKeys.has(key))) return false
    if ('success' in record && record.success !== false) return false
    if ('status' in record) {
      const statusValid = typeof record.status === 'number'
        ? Number.isInteger(record.status) && record.status >= 400 && record.status <= 599
        : typeof record.status === 'string' && /^[45]\d\d$/.test(record.status)
      if (!statusValid) return false
    }
    if ('code' in record && typeof record.code !== 'string' && typeof record.code !== 'number') return false
    if ('name' in record && typeof record.name !== 'string') return false
    const payloadKey = payloadKeys[0]!
    const rawPayload = record[payloadKey]
    const payload = typeof rawPayload === 'string'
      ? rawPayload
      : payloadKey === 'error' && rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
        && Object.keys(rawPayload).length === 1 && typeof (rawPayload as Record<string, unknown>).message === 'string'
        ? (rawPayload as Record<string, string>).message
        : undefined
    return typeof payload === 'string' && wrappedDirect(payload)
  } catch {
    return false
  }
}

/**
 * Classify a provider/tool failure without retaining its raw payload.
 */
export function classifyAgentFailure(signal: AgentFailureSignal): AgentFailureClassification {
  const structured = classifyStructuredFailure(signal)
  if (structured) return structured

  const text = `${signal.code ?? ''} ${signal.message}`
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  const words = new Set(text.split(/[^a-z0-9]+/).filter(Boolean))
  const containsAny = (terms: readonly string[]): boolean => terms.some(term => text.includes(term))
  // Objective-authority refusals are emitted by our own host guard. They mean
  // that this invocation does not fit the already accepted objective; they do
  // not prove that the external source is unavailable. Keep the correction at
  // the original tool boundary instead of inventing a browser/cross-tool path.
  if (isObjectiveAuthorityRefusal(signal.message)) {
    return result('invalid-input', 'never', 'fix-input', 'heuristic')
  }
  const keyCredentialSource = String.raw`(?:api[\s_-]+(?:keys?|cles?)|(?:keys?|cles?)[\s_-]+api|(?:license|licence)[\s_-]+(?:keys?|cles?)|cles?(?:\s+de)?\s+(?:license|licence)|access[\s_-]+tokens?|jetons?\s+d?['’\s-]*acces)`
  // Remove only an explicitly optional credential phrase before looking for
  // absence states elsewhere. This prevents `no API key is required` from
  // becoming a human authentication blocker while preserving a later, real
  // signal such as `access token missing` in the same error.
  const explicitlyOptionalCredential = new RegExp([
    String.raw`\bno\s+${keyCredentialSource}\s+(?:is\s+)?(?:required|needed)\b`,
    String.raw`\b${keyCredentialSource}\s+(?:is\s+)?not\s+(?:required|needed)\b`,
    String.raw`\b(?:requires?\s+no|(?:does\s+not|doesn['’]t)\s+require\s+(?:an?|any)?)\s+${keyCredentialSource}\b`,
    String.raw`\baucun(?:e)?\s+${keyCredentialSource}\s+(?:n['’]?est\s+)?(?:pas\s+)?(?:requis(?:e)?|necessaire)\b`,
    String.raw`\b${keyCredentialSource}\s+(?:n['’]?est\s+pas|non)\s+(?:requis(?:e)?|necessaire)\b`,
  ].join('|'), 'giu')
  const credentialSignalText = text.replace(explicitlyOptionalCredential, ' ')
  // Connector errors commonly expose stable machine codes instead of prose
  // (for example `guardtek_analytics_api_key_missing`). Keep the state bound
  // to that credential expression so an unrelated `missing` result after a
  // successful authentication cannot become a human blocker.
  const documentaryCredentialMention = /^(?:documentation|docs?|guide|reference|examples?|instructions?|how\s+to)\b/u
    .test(text.trim())
  const keyCredentialUnavailable = !documentaryCredentialMention
    && new RegExp([
      String.raw`(?:^|[^a-z0-9])${keyCredentialSource}[\s_-]+(?:missing|required|needed|absent|invalid|expired|unconfigured|not[\s_-]+found|unset|not[\s_-]+configured|manquant(?:e)?|requis(?:e)?|necessaire|absent(?:e)?|invalide|expire)(?:$|[^a-z0-9])`,
      String.raw`\b${keyCredentialSource}\b\s+(?:(?:is|are|was|were|est|sont)\s+)?(?:missing|required|needed|absent|invalid|expired|unconfigured|not\s+found|unset|not\s+configured|manquant(?:e)?|requis(?:e)?|necessaire|absent(?:e)?|invalide|expire)\b`,
      String.raw`\b(?:missing|required|needed|absent|invalid|expired|unconfigured|not\s+found|unset|manquant(?:e)?|requis(?:e)?|necessaire|absent(?:e)?|invalide|expire)\s+(?:the\s+|your\s+|la\s+|le\s+|votre\s+)?${keyCredentialSource}\b`,
      String.raw`\bno\s+${keyCredentialSource}\s+(?:(?:is|are)\s+)?(?:available|configured|present|found)\b`,
      String.raw`\b(?:unable|failed)\s+to\s+(?:retrieve|load|read)\s+(?:the\s+|your\s+)?${keyCredentialSource}\b`,
      String.raw`\b${keyCredentialSource}\b\s+could(?:\s+not|n['’]?t)\s+be\s+(?:retrieved|loaded|read)\b`,
    ].join('|'), 'u').test(credentialSignalText)
  const keyCredentialNotFoundOrUnset = !documentaryCredentialMention
    && new RegExp(`${keyCredentialSource}[\\s_-]+(?:(?:is|est)[\\s_-]+)?(?:not[\\s_-]+found|unset)(?:\\b|$)`, 'u')
      .test(credentialSignalText)
  const keyCredentialProvisionRequested = !documentaryCredentialMention
    && /^(?:(?:error|erreur|authentication|authentification)[^:\n]{0,48}:\s*)?(?:(?:please|kindly|veuillez|merci\s+de)\s+)?(?:provide|enter|supply|set|configure|add|paste|fournir|fournissez|renseigner|renseignez|saisir|saisissez|entrer|entrez|configurer|configurez|ajouter|ajoutez|coller|collez|definir|definissez)\s+(?:(?:your|the|an?|votre|vos|la|le|une?|des)\s+){0,2}(?:api[\s_-]+(?:keys?|cles?)|(?:keys?|cles?)[\s_-]+api|(?:license|licence)[\s_-]+(?:keys?|cles?)|cles?(?:\s+de)?\s+(?:license|licence)|access[\s_-]+tokens?|jetons?\s+d?['’\s-]*acces)(?:\b|$)/u.test(credentialSignalText.trim())
  const keyCredentialPassiveProvisionRequired = !documentaryCredentialMention
    && /^(?:(?:error|erreur|authentication|authentification)[^:\n]{0,48}:\s*)?(?:(?:the|your|an?|le|la|une?|votre)\s+)?(?:api[\s_-]+(?:keys?|cles?)|(?:keys?|cles?)[\s_-]+api|(?:license|licence)[\s_-]+(?:keys?|cles?)|cles?(?:\s+de)?\s+(?:license|licence)|access[\s_-]+tokens?|jetons?\s+d?['’\s-]*acces)\s+(?:must\s+be|needs?\s+to\s+be)\s+set(?:\b|$)/u.test(text.trim())
  const keyCredentialMissing = keyCredentialUnavailable
    || keyCredentialNotFoundOrUnset
    || keyCredentialProvisionRequested
    || keyCredentialPassiveProvisionRequired
  const tokenExpired = !documentaryCredentialMention && new RegExp([
    String.raw`(?:^|[^a-z0-9])tokens?[\s_-]+expired(?:$|[^a-z0-9])`,
    String.raw`\btokens?\b\s+(?:(?:is|was|has\s+been)\s+)?expired\b`,
    String.raw`\bexpired\s+tokens?\b`,
  ].join('|'), 'u').test(credentialSignalText)
  const genericCredentialSource = String.raw`(?:credentials?|passwords?|mots?\s+de\s+passe|identifiants?)`
  const explicitlyOptionalGenericCredential = new RegExp([
    String.raw`\bno\s+${genericCredentialSource}\s+(?:(?:is|are)\s+)?(?:required|needed|missing|invalid|expired|unavailable)\b`,
    String.raw`\b${genericCredentialSource}\s+(?:(?:is|are)\s+)?(?:not\s+(?:required|needed|missing|invalid|expired|unavailable|unset)|optional)\b`,
    String.raw`\b(?:requires?\s+no|(?:does\s+not|doesn['’]t)\s+require\s+(?:an?|any)?)\s*${genericCredentialSource}\b`,
    String.raw`\baucun(?:e)?\s+${genericCredentialSource}\s+(?:n['’]?est\s+)?(?:pas\s+)?(?:requis(?:e)?|necessaire)\b`,
    String.raw`\b${genericCredentialSource}\s+(?:n['’]?est\s+pas|ne\s+sont\s+pas|non)\s+(?:requis(?:e)?s?|necessaires?)\b`,
    String.raw`\b(?:ne|n['’])\s+(?:necessite|requiert)\s+pas\s+(?:de\s+|d['’]\s*)?(?:${genericCredentialSource})\b`,
  ].join('|'), 'giu')
  const explicitlySuccessfulGenericCredential = new RegExp([
    String.raw`(?<!\bno\s)(?<!\bnot\s)\b(?:the\s+|your\s+|les?\s+|vos?\s+)?${genericCredentialSource}(?:\s+helper)?\s+(?:(?:is|are|was|were|has\s+been|have\s+been)\s+)?(?:accepted|valid|validated|verified|configured|updated|installed|available|present|successful|succeeded)(?:\s+successfully)?\b`,
    String.raw`(?<!\bno\s)(?<!\bnot\s)\b(?:accepted|valid|validated|verified|configured|updated|installed)\s+${genericCredentialSource}\b`,
  ].join('|'), 'giu')
  const genericCredentialSignalText = credentialSignalText
    .replace(explicitlyOptionalGenericCredential, ' ')
    .replace(explicitlySuccessfulGenericCredential, ' ')
  const genericCredentialUnavailable = !documentaryCredentialMention && new RegExp([
    String.raw`(?:^|[^a-z0-9])${genericCredentialSource}[\s_-]+(?:missing|required|needed|absent|invalid|incorrect|wrong|expired|unavailable|unset|manquant(?:e)?|requis(?:e)?|necessaire|invalide|expire|indisponible|introuvable)(?:$|[^a-z0-9])`,
    String.raw`\b${genericCredentialSource}\b\s+(?:must\s+be|needs?\s+to\s+be)\s+set\b`,
    String.raw`\b${genericCredentialSource}\b[^.!?;\n]{0,40}\b(?:missing|required|needed|absent|invalid|incorrect|wrong|expired|unavailable|not[\s_-]+found|unset|not[\s_-]+configured|could[\s_-]+not[\s_-]+be[\s_-]+retrieved|couldn['’]t[\s_-]+be[\s_-]+retrieved)\b`,
    String.raw`\b(?:missing|required|needed|absent|invalid|incorrect|wrong|expired|unavailable|not[\s_-]+found|unset|not[\s_-]+configured)\b[^.!?;\n]{0,40}\b${genericCredentialSource}\b`,
    String.raw`\bno\s+${genericCredentialSource}\s+(?:(?:is|are)\s+)?available\b`,
    String.raw`\b(?:unable|failed)\s+to\s+(?:retrieve|load|read)\s+(?:the\s+|your\s+)?${genericCredentialSource}\b`,
    String.raw`\b${genericCredentialSource}\b[^.!?;\n]{0,40}\b(?:manquant(?:e|es|s)?|requis(?:e|es|s)?|necessaires?|absent(?:e|es|s)?|invalides?|incorrect(?:e|es|s)?|expire(?:e|es|s)?|indisponibles?|introuvables?|non[\s_-]+configure(?:e|es|s)?)\b`,
    String.raw`\b(?:manquant(?:e|es|s)?|requis(?:e|es|s)?|necessaires?|absent(?:e|es|s)?|invalides?|incorrect(?:e|es|s)?|expire(?:e|es|s)?|indisponibles?|introuvables?)\b[^.!?;\n]{0,40}\b${genericCredentialSource}\b`,
  ].join('|'), 'u').test(genericCredentialSignalText)
  const genericCredentialProvisionRequested = !documentaryCredentialMention
    && new RegExp(String.raw`^(?:(?:error|erreur|authentication|authentification)[^:\n]{0,48}:\s*)?(?:(?:please|kindly|veuillez|merci\s+de)\s+)?(?:provide|enter|supply|set|configure|add|paste|fournir|fournissez|renseigner|renseignez|saisir|saisissez|entrer|entrez|configurer|configurez|ajouter|ajoutez|coller|collez|definir|definissez)\s+(?:(?:your|the|an?|votre|vos|la|le|une?|des)\s+){0,2}${genericCredentialSource}(?:\b|$)`, 'u')
      .test(genericCredentialSignalText.trim())
  const genericCredentialReauthenticationRequested = !documentaryCredentialMention
    && new RegExp(String.raw`\b(?:re[- ]?authenticate|authenticate|re[- ]?authentifiez|authentifiez)(?:\s+[^.!?;\n]{0,80})?\b${genericCredentialSource}\b`, 'u')
      .test(genericCredentialSignalText)
  const genericCredentialMissing = genericCredentialUnavailable
    || genericCredentialProvisionRequested
    || genericCredentialReauthenticationRequested
  if (
    words.has('mfa')
    || containsAny(['multi-factor', 'multi factor', 'multifactor', 'two-factor', 'two factor', 'twofactor'])
    || (words.has('oauth') && containsAny(['required', 'login', 'sign-in', 'sign in', 'consent']))
    || containsAny(['authorization_pending', 'authentication pending', 'device code pending'])
  ) {
    return result('interactive-auth-required', 'never', 'request-authentication', 'heuristic')
  }
  if (
    containsAny(['unauthorized', 'unauthorised'])
    || keyCredentialMissing
    || genericCredentialMissing
    || tokenExpired
  ) {
    return result('credential-required', 'never', 'request-authentication', 'heuristic')
  }
  if (containsAny(['forbidden', 'permission denied', 'not allowed', 'authorization required'])) {
    return result('permission-denied', 'never', 'request-authorization', 'heuristic')
  }
  if (containsAny([
    'sandbox',
    'policy denied',
    'operation denied by policy',
    'blocked in explore',
    'blocked (explore mode)',
    'high-stakes evidence gate',
  ])) {
    return result('sandbox-denied', 'never', 'request-authorization', 'heuristic')
  }
  if (containsAny(['invalid argument', 'validation failed', 'bad request', 'malformed', 'schema error'])) {
    return result('invalid-input', 'never', 'fix-input', 'heuristic')
  }
  if (
    containsAny([
      'rate limit',
      'too many requests',
      'quota exceeded',
      'quota exhausted',
      'quota unavailable',
      'no usable quota',
      'does not currently have usable',
      'usage limit has been reached',
      'usage limit reached',
      'credit balance is too low',
    ])
    || words.has('429')
  ) {
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
  if (/\benobufs\b|(?:stdout|stderr|stdio).*maxbuffer|maxbuffer.*(?:stdout|stderr|stdio)/.test(text)) {
    return result('resource-exhausted', 'conditional', 'fix-input', 'heuristic', signal.retryAfterMs)
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
  if (/service unavailable|provider unavailable|bad gateway|\b502\b|\b503\b|\b500\b|an unexpected error (?:has )?occurred|unexpected provider error|unexpected api error/.test(text)) {
    return result('service-unavailable', 'safe', 'provider-fallback', 'heuristic', signal.retryAfterMs)
  }
  if (/\bconflict\b|\b409\b|already exists/.test(text)) {
    return result('conflict', 'conditional', 'retry', 'heuristic', signal.retryAfterMs)
  }

  return result('unknown', 'conditional', 'browser-fallback', 'fallback')
}
