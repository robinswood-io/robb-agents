import { type Workspace } from "@craft-agent/shared/config";
import { captureSessionPersistenceRootIdentity } from "@craft-agent/shared/sessions";
import { getSourceCredentialManager, TokenRefreshManager } from "@craft-agent/shared/sources";
import { type CreateSessionOptions } from "@craft-agent/shared/protocol";
import { type Message } from "@craft-agent/core/types";
import { type ThinkingLevel, normalizeThinkingLevel } from "@craft-agent/shared/agent/thinking-levels";
import { extractLabelId } from "@craft-agent/shared/labels";
import type { ManagedSession } from './managed-session.ts';
import { sessionLog } from './runtime-platform.ts';

export interface SpawnRouteSelection {
  llmConnection?: string
  /** True only for a host-authenticated manual/task connection choice. */
  connectionRoutePinned?: boolean
  model?: string
  thinkingLevel?: ThinkingLevel
  /** True only for a host-authenticated manual/task model choice. */
  modelRoutePinned?: boolean
  /** True only for a host-authenticated reasoning choice. */
  thinkingLevelPinned?: boolean
}

type SessionCreationRouteRequest = Pick<CreateSessionOptions,
  | 'model'
  | 'modelRoutePinned'
  | 'llmConnection'
  | 'connectionRoutePinned'
>

/**
 * Materialize the provider scope for a caller-pinned model before the session
 * is persisted. Models are connection-scoped, so retaining only the model pin
 * would let automatic connection routing silently replace the requested model.
 */
export function resolveCreateSessionRouteProvenance(
  request: SessionCreationRouteRequest | undefined,
  resolvedConnectionSlug: string | undefined,
): {
  modelRoutePinned: boolean
  llmConnection?: string
  connectionRoutePinned: boolean
} {
  const modelRoutePinned = request?.modelRoutePinned ?? request?.model !== undefined
  const hasPinnedExplicitModel = request?.model !== undefined && modelRoutePinned
  const materializesResolvedConnection = hasPinnedExplicitModel && request?.llmConnection === undefined
  const llmConnection = request?.llmConnection
    ?? (materializesResolvedConnection ? resolvedConnectionSlug : undefined)

  if (materializesResolvedConnection && !llmConnection) {
    throw new Error(
      'Cannot create a session with a pinned model without a configured LLM connection. Select a workspace or global default connection first.',
    )
  }

  return {
    modelRoutePinned,
    llmConnection,
    connectionRoutePinned: hasPinnedExplicitModel && llmConnection !== undefined
      ? true
      : (request?.connectionRoutePinned ?? request?.llmConnection !== undefined),
  }
}

/**
 * Resolve a specialist route before creating its session. Omitted fields
 * inherit the effective parent values exactly; explicitly requested fields
 * always win, including `thinkingLevel: 'off'`.
 */
export function resolveSpawnedSessionRoute(
  request: SpawnRouteSelection,
  parent: SpawnRouteSelection,
): SpawnRouteSelection {
  const changesConnection = request.llmConnection !== undefined
    && request.llmConnection !== parent.llmConnection
  const inheritsPinnedThinking = request.thinkingLevel === undefined
    && !changesConnection
    && parent.thinkingLevelPinned === true
  return {
    llmConnection: request.llmConnection ?? parent.llmConnection,
    // A model is connection-scoped. Carrying an OpenAI model into an
    // Anthropic (or another Pi-provider) connection creates a false audit
    // trail even when the backend silently chooses that connection's default.
    model: request.model ?? (changesConnection ? undefined : parent.model),
    thinkingLevel: request.thinkingLevel
      ?? (inheritsPinnedThinking ? parent.thinkingLevel : undefined),
  }
}

export function resolveExplicitSpawnedSessionRoute(_request: SpawnRouteSelection, parent: SpawnRouteSelection, _input: Record<string,unknown> = {}): SpawnRouteSelection { return {...resolveSpawnedSessionRoute({},parent),thinkingLevel:parent.thinkingLevel,connectionRoutePinned:parent.llmConnection!==undefined,modelRoutePinned:parent.model!==undefined,thinkingLevelPinned:parent.thinkingLevel!==undefined}; }

const PARENT_SESSION_LABEL_ID = 'parent-session'

/**
 * Keep the optional parent-session label aligned with the authoritative
 * structural parent edge. The label can be absent, but when present it may
 * never point at the session itself, one of its children, or an unrelated ID
 * extracted from conversation text.
 */
export function sanitizeParentSessionLabels(
  sessionId: string,
  parentSessionId: string | null | undefined,
  labels: readonly string[] | undefined,
): string[] | undefined {
  if (!labels) return undefined
  const hasParentSessionLabel = labels.some(entry => extractLabelId(entry) === PARENT_SESSION_LABEL_ID)
  if (!hasParentSessionLabel) return [...labels]

  const sanitized = labels.filter(entry => extractLabelId(entry) !== PARENT_SESSION_LABEL_ID)
  if (parentSessionId && parentSessionId !== sessionId) {
    sanitized.push(`${PARENT_SESSION_LABEL_ID}::${parentSessionId}`)
  }
  return sanitized
}

export function repairPersistedFalseCompletion(managed: ManagedSession, finalMessage?: Message): boolean {
  // Older runtimes could mark a visible final verified after exhausting
  // validation, even though its persisted receipt still says work remains.
  // Repair only a direct, same-objective contradiction. Never auto-dispatch
  // here: an external effect may have happened after the last read.
  const matchingFinals = (finalMessage ? [finalMessage] : managed.messages).filter(message =>
    message.id === managed.lastFinalMessageId
    && message.role === 'assistant'
    && message.timestamp >= (managed.activeObjective?.startedAt ?? Infinity)
  )
  const unfinishedFinal = matchingFinals.length === 1
    ? matchingFinals[0]!.objectiveOutcome : undefined
  if (managed.activeObjective?.terminalState === 'complete_verified'
    && unfinishedFinal?.state === 'continue'
    && unfinishedFinal.remainingWork.length > 0
    && unfinishedFinal.criteria.some(criterion =>
      (criterion.id === 'requested-outcome-delivered'
        || criterion.id === 'no-safe-work-remaining')
      && criterion.satisfied === false
    )) {
    managed.activeObjective = {
      ...managed.activeObjective,
      terminalState: 'exhausted',
      completedAt: undefined,
      lastOutcome: unfinishedFinal,
    }
    return true
  }
  return false
}

/**
 * Create a ManagedSession from any session-like source (SessionMetadata, SessionConfig, StoredSession).
 * Spreads all matching fields from the source so new persistent fields automatically propagate.
 * Runtime-only fields get sensible defaults.
 */
export function createManagedSession(
  source: { id: string } & Partial<ManagedSession>,
  workspace: Workspace,
  overrides?: Partial<ManagedSession>,
): ManagedSession {
  const persistenceRootIdentity = captureSessionPersistenceRootIdentity(workspace.rootPath)
  const legacyProjectMemoryRootPath = workspace.rootPath
  const s = source as Record<string, unknown>
  const sourceFields = Object.fromEntries(
    Object.entries(s).filter(([, v]) => v !== undefined)
  ) as Partial<ManagedSession>

  if ('thinkingLevel' in sourceFields) {
    // TODO: Remove legacy 'think' normalization after old persisted session
    // headers have realistically aged out across upgrades.
    const normalizedThinkingLevel = normalizeThinkingLevel(sourceFields.thinkingLevel)
    if (normalizedThinkingLevel) {
      sourceFields.thinkingLevel = normalizedThinkingLevel
    } else {
      delete sourceFields.thinkingLevel
    }
  }

  // Before pin provenance was persisted, every concrete session model came
  // from an explicit selection. Migrate conservatively: an old model must not
  // become eligible for automatic replacement merely because its boolean is
  // absent from the header.
  if (typeof sourceFields.model === 'string'
    && sourceFields.model.trim()
    && sourceFields.modelRoutePinned === undefined) {
    sourceFields.modelRoutePinned = true
  }

  const managed = {
    // Spread all session-like fields from source (id, name, permissionMode, labels, model, etc.)
    // This ensures new persistent fields automatically flow through without manual copying.
    ...sourceFields,
    // Runtime-only defaults (not persisted)
    workspace,
    agent: null,
    messages: [],
    isProcessing: false,
    lastMessageAt: (s.lastMessageAt ?? s.lastUsedAt ?? Date.now()) as number,
    streamingText: '',
    processingGeneration: 0,
    isFlagged: (s.isFlagged ?? false) as boolean,
    messageQueue: [],
    backgroundShellCommands: new Map(),
    backgroundTaskOutputs: new Map(),
    backgroundTaskRegistry: new Map(),
    messagesLoaded: false,
    tokenRefreshManager: new TokenRefreshManager(getSourceCredentialManager(), {
      log: (msg) => sessionLog.debug(msg),
    }),
    // Caller overrides (permissionMode defaults, thinkingLevel, messagesLoaded, etc.)
    ...overrides,
    // Never inherit or override this runtime identity from persisted/session
    // data. The logical workspace path remains available through `workspace`.
    persistenceRootPath: persistenceRootIdentity.workspaceRootPath,
    persistenceRootIdentity,
    legacyProjectMemoryRootPath,
  } as ManagedSession

  repairPersistedFalseCompletion(managed)

  if (managed.branchFromMessageId && !managed.branchContextStrategy) {
    managed.branchContextStrategy = managed.branchFromSdkSessionId
      ? 'sdk-fork'
      : 'seeded-fresh-session'
  }

  if (managed.branchContextStrategy === 'seeded-fresh-session' && managed.branchSeedApplied === undefined) {
    // If an SDK session ID already exists, first turn has already happened.
    managed.branchSeedApplied = !!managed.sdkSessionId
  }

  // parentSessionId is the only lineage authority. Persisted/self-referential
  // labels from older auto-label rules must not manufacture a reverse edge.
  if (managed.parentSessionId === managed.id) managed.parentSessionId = undefined
  managed.labels = sanitizeParentSessionLabels(managed.id, managed.parentSessionId, managed.labels)

  return managed
}
