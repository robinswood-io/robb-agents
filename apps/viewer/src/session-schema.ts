import { z } from 'zod'
import type { StoredMessage, StoredSession } from '@craft-agent/core'

// Keep unknown extension fields while validating every maintained session field.
// Missing optional fields remain absent, matching JSON persistence semantics.

const string = z.string()
const number = z.number()
const boolean = z.boolean()
const strings = z.array(string)
const jsonObject = z.record(string, z.unknown())

const annotation = z.object({
  id: string, schemaVersion: z.literal(1), createdAt: number,
  updatedAt: number.exactOptional(), deletedAt: number.exactOptional(),
  createdBy: z.object({ id: string, name: string.exactOptional(), type: z.enum(['user', 'agent', 'system']).exactOptional() }).passthrough().exactOptional(),
  body: z.array(z.union([
    z.object({ type: z.literal('highlight') }).passthrough(),
    z.object({ type: z.literal('note'), text: string, format: z.enum(['plain', 'markdown']).exactOptional() }).passthrough(),
    z.object({ type: z.literal('tag'), value: string }).passthrough(),
  ])),
  target: z.object({
    source: z.object({ sessionId: string, messageId: string }).passthrough(),
    selectors: z.array(z.union([
      z.object({ type: z.literal('text-quote'), exact: string, prefix: string.exactOptional(), suffix: string.exactOptional() }).passthrough(),
      z.object({ type: z.literal('text-position'), start: number, end: number, textVersion: string.exactOptional() }).passthrough(),
      z.object({ type: z.literal('block'), path: string, blockId: string.exactOptional(), blockType: z.enum([
        'paragraph', 'code', 'latex', 'mermaid', 'datatable', 'spreadsheet', 'image-preview', 'pdf-preview', 'html-preview',
      ]) }).passthrough(),
      z.object({ type: z.literal('xywh'), unit: z.enum(['pixel', 'percent']), x: number, y: number, w: number, h: number,
        page: number.exactOptional(), rotation: number.exactOptional() }).passthrough(),
      z.object({ type: z.literal('table-cell'), rowKey: z.union([string, number]), columnKey: string }).passthrough(),
    ])),
  }).passthrough(),
  intent: z.enum(['highlight', 'comment', 'question']).exactOptional(),
  status: z.enum(['pending', 'acknowledged', 'resolved', 'dismissed']).exactOptional(),
  threadRef: z.object({ threadId: string.exactOptional(), sessionId: string.exactOptional() }).passthrough().exactOptional(),
  style: z.object({ color: string.exactOptional(), opacity: number.exactOptional() }).passthrough().exactOptional(),
  meta: jsonObject.exactOptional(),
}).passthrough()

const routingMeta = z.object({
  appVersion: string.exactOptional(), buildCommit: string.exactOptional(), buildChannel: string.exactOptional(),
  buildDirty: boolean.exactOptional(), isPackaged: boolean.exactOptional(), connectionSlug: string.exactOptional(),
  providerType: string.exactOptional(), model: string.exactOptional(), requestedModel: string.exactOptional(),
  provider: string.exactOptional(), api: string.exactOptional(), contextWindow: number.exactOptional(), reason: string.exactOptional(),
  sensitivity: string.exactOptional(), policyRuleIds: strings.exactOptional(), routingDifficulty: string.exactOptional(),
  requiredCapabilities: strings.exactOptional(), routingExplanation: string.exactOptional(),
  costControl: z.object({
    turnKind: string, budgetState: string, thinkingLevel: string, contextTokensBefore: number,
    contextWindow: number.exactOptional(), compactAtTokens: number.exactOptional(), hardLimitTokens: number.exactOptional(),
    compacted: boolean.exactOptional(), compactionOutcome: z.enum([
      'succeeded', 'ineffective', 'unverified', 'failed', 'skipped-cooldown', 'skipped-not-needed',
    ]).exactOptional(),
    compactionModel: string.exactOptional(), compactionDurationMs: number.exactOptional(), contextTokensAfter: number.exactOptional(),
    reclaimedTokens: number.exactOptional(), reductionRatio: number.exactOptional(), compactionIssueCodes: strings.exactOptional(),
    hardContextLimitReached: boolean.exactOptional(),
  }).passthrough().exactOptional(),
  rejectedConnections: z.array(z.object({ slug: string, reasons: strings }).passthrough()).exactOptional(),
  budgetDecision: z.object({ status: string, exceededScopes: strings,
    projectedUsd: z.object({ session: number.exactOptional(), mission: number.exactOptional(), workspace: number.exactOptional() }).passthrough(),
  }).passthrough().exactOptional(),
  fallbackFromConnectionSlug: string.exactOptional(), fallbackReason: string.exactOptional(), estimatedCostUsd: number.exactOptional(),
  actualCostUsd: number.exactOptional(), estimatedCostEur: number.exactOptional(), actualCostEur: number.exactOptional(),
  costProvenance: z.object({
    schemaVersion: z.literal(1), source: string, sourceCurrency: string.exactOptional(), pricingCatalogVersion: string.exactOptional(),
    displayCurrency: string.exactOptional(), exchangeRate: number.exactOptional(), exchangeRateAsOf: string.exactOptional(),
    exchangeRateSource: string.exactOptional(),
  }).passthrough().exactOptional(),
  tokenUsageSource: string.exactOptional(),
} satisfies Record<keyof NonNullable<StoredMessage['routingMeta']>, z.ZodType>).passthrough()

const message = z.object({
  id: string, type: z.enum(['user', 'assistant', 'tool', 'error', 'status', 'info', 'warning', 'plan', 'auth-request']),
  content: string, timestamp: number.exactOptional(), toolName: string.exactOptional(), toolUseId: string.exactOptional(),
  toolInput: jsonObject.exactOptional(), toolResult: string.exactOptional(),
  toolStatus: z.enum(['pending', 'executing', 'completed', 'error', 'backgrounded']).exactOptional(),
  toolExecuted: boolean.exactOptional(),
  toolCheckpoint: z.object({ schemaVersion: z.literal(1), kind: z.literal('tool-call-budget'), reason: string }).passthrough().exactOptional(),
  toolDuration: number.exactOptional(), toolIntent: string.exactOptional(), toolDisplayName: string.exactOptional(),
  toolDisplayMeta: z.object({ displayName: string, iconDataUrl: string.exactOptional(), description: string.exactOptional(),
    category: z.enum(['skill', 'source', 'native', 'mcp']).exactOptional(),
  }).passthrough().exactOptional(),
  parentToolUseId: string.exactOptional(), taskId: string.exactOptional(), shellId: string.exactOptional(), elapsedSeconds: number.exactOptional(),
  isBackground: boolean.exactOptional(), isError: boolean.exactOptional(),
  attachments: z.array(z.object({
    id: string, type: z.enum(['image', 'text', 'pdf', 'office', 'audio', 'unknown']), name: string,
    mimeType: string, size: number, originalSize: number.exactOptional(), storedPath: string,
    thumbnailPath: string.exactOptional(), thumbnailBase64: string.exactOptional(), markdownPath: string.exactOptional(),
    wasResized: boolean.exactOptional(), resizedBase64: string.exactOptional(),
  }).passthrough()).exactOptional(),
  badges: z.array(z.object({
    type: z.enum(['source', 'skill', 'context', 'command', 'file', 'folder']), label: string, rawText: string,
    iconDataUrl: string.exactOptional(), start: number, end: number, collapsedLabel: string.exactOptional(), filePath: string.exactOptional(),
  }).passthrough()).exactOptional(),
  annotations: z.array(annotation).exactOptional(), isIntermediate: boolean.exactOptional(), turnId: string.exactOptional(),
  statusType: z.enum(['compacting', 'compaction_complete']).exactOptional(), routingMeta: routingMeta.exactOptional(),
  objectiveOutcome: z.object({
    state: z.enum(['complete_verified', 'blocked_human', 'blocked_policy', 'continue']),
    criteria: z.array(z.object({ id: string, satisfied: boolean, evidence: strings }).passthrough()), remainingWork: strings,
    blocker: z.object({ kind: z.enum(['credential', 'mfa', 'external_authorization', 'irreversible_authority', 'business_decision', 'policy']),
      description: string, evidence: strings,
    }).passthrough().nullable().exactOptional(),
  }).passthrough().exactOptional(),
  objectiveOutcomeError: string.exactOptional(), infoLevel: z.enum(['info', 'warning', 'error', 'success']).exactOptional(),
  errorCode: string.exactOptional(), errorTitle: string.exactOptional(), errorDetails: strings.exactOptional(), errorOriginal: string.exactOptional(),
  errorCanRetry: boolean.exactOptional(), errorActions: z.array(z.object({ key: string, label: string,
    action: z.enum(['retry', 'settings', 'reauth', 'open_url', 'reconnect_source', 'reconnect_runtime']).exactOptional(),
    url: string.exactOptional(), sourceSlug: string.exactOptional(),
  }).passthrough()).exactOptional(),
  planPath: string.exactOptional(), authRequestId: string.exactOptional(),
  authRequestType: z.enum(['credential', 'oauth', 'oauth-google', 'oauth-slack', 'oauth-microsoft']).exactOptional(),
  authSourceSlug: string.exactOptional(), authSourceName: string.exactOptional(),
  authStatus: z.enum(['pending', 'completed', 'cancelled', 'failed']).exactOptional(),
  authCredentialMode: z.enum(['bearer', 'basic', 'header', 'query', 'multi-header']).exactOptional(),
  authHeaderName: string.exactOptional(), authHeaderNames: strings.exactOptional(),
  authLabels: z.object({ credential: string.exactOptional(), username: string.exactOptional(), password: string.exactOptional() }).passthrough().exactOptional(),
  authDescription: string.exactOptional(), authHint: string.exactOptional(), authSourceUrl: string.exactOptional(),
  authPasswordRequired: boolean.exactOptional(), authError: string.exactOptional(), authEmail: string.exactOptional(), authWorkspace: string.exactOptional(),
  isQueued: boolean.exactOptional(), hidden: boolean.exactOptional(),
  internalOrigin: z.object({
    kind: z.enum(['agent-message', 'auth-result', 'auth-retry', 'browser-fallback', 'source-activation', 'spawned-session', 'automation', 'user-input']),
    objectiveId: string.exactOptional(), objectiveRevision: string.exactOptional(), sourceSlug: string.exactOptional(), sourceActivationId: string.exactOptional(),
    senderSessionId: string.exactOptional(), deliveryId: string.exactOptional(), attachmentsSha256: string.exactOptional(),
    agentMessageType: z.enum(['progress', 'result', 'question', 'decision']).exactOptional(), authenticatedTaskText: string.exactOptional(),
  }).passthrough().exactOptional(),
  providerDispatch: z.object({
    schemaVersion: z.literal(1), state: z.enum(['acceptance-unknown', 'accepted', 'retired-uncertain', 'retired-accepted']),
    messageId: string, objectiveId: string, objectiveUserMessageId: string, generation: number, cancellationEpoch: number, markedAt: number,
    acceptedAt: number.exactOptional(), userStoppedAt: number.exactOptional(), retiredAt: number.exactOptional(),
    retirementReason: z.enum(['superseded-by-new-human-objective', 'user-stop-after-provider-ack', 'explicit-retry-reconciliation', 'live-nonreplay-reconciliation']).exactOptional(),
  }).passthrough().exactOptional(),
  agentDelivery: z.object({
    id: string, status: z.enum(['queued', 'processing', 'processed', 'failed']), attempts: number,
    attachmentsSha256: string.exactOptional(), setupFailureCount: number.exactOptional(), lastSetupFailureClass: string.exactOptional(),
    setupRetryNotBefore: number.exactOptional(), setupRetryBlockedAt: number.exactOptional(), setupPersistenceFencedAt: number.exactOptional(),
    providerDispatchUncertainAt: number.exactOptional(),
  }).passthrough().exactOptional(),
} satisfies Record<keyof StoredMessage, z.ZodType>).passthrough()

const session = z.object({
  id: string, workspaceId: string.default(''), createdAt: number, lastUsedAt: number,
  sdkSessionId: string.exactOptional(), name: string.exactOptional(), isArchived: boolean.exactOptional(), isFlagged: boolean.exactOptional(),
  status: z.enum(['todo', 'in_progress', 'needs_review', 'done', 'cancelled']).exactOptional(), lastReadMessageId: string.exactOptional(),
  autonomyEvents: z.array(z.object({
    id: string, timestamp: number, phase: z.enum(['attempt', 'diagnosis', 'fallback', 'verified', 'escalated']), message: string,
    toolName: string.exactOptional(), evidence: string.exactOptional(),
    escalationReason: z.enum(['oauth_or_mfa', 'credential_required', 'business_decision_required', 'external_authorization_required', 'access_unavailable_after_fallback']).exactOptional(),
  }).passthrough()).exactOptional(),
  playbookSlug: string.exactOptional(), messages: z.array(message),
  tokenUsage: z.object({ inputTokens: number, outputTokens: number, totalTokens: number, contextTokens: number, costUsd: number,
    cacheReadTokens: number.exactOptional(), cacheCreationTokens: number.exactOptional(),
  }).passthrough(),
} satisfies Record<keyof StoredSession, z.ZodType>).passthrough()

export function parseViewerSession(value: unknown): StoredSession {
  return session.parse(value)
}
