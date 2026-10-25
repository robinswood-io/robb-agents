import { classifyAgentFailure } from "@craft-agent/shared/agent";
import { type PendingTurnRecovery } from "@craft-agent/shared/sessions";
import { generateMessageId } from "@craft-agent/shared/protocol";
import { type Message } from "@craft-agent/core/types";
import { hasTargetBoundObjectiveExecutionEvidence } from "../../objective-acceptance-criteria";
import { inspectAutonomousLineage } from "../../autonomous-session-admission";
import { type AutomaticTurnRecoveryCause } from "../../turn-recovery";
import { type AutonomyFallbackIntent } from "../../autonomy-browser-fallback";
import {
  findObjectiveText,
  objectiveRequiresExecutionEvidence,
  isExplicitReadOnlyReview,
} from "../../objective-contract";
import type { ManagedSession } from "../managed-session.ts";
import { sessionLog } from "../runtime-platform.ts";
import {
  CLEAN_RETRY_CONDITIONAL_SETUP_FAILURE_CLASSES,
  CLEAN_RETRY_NEVER_SETUP_FAILURE_CLASSES,
  CLEAN_RETRY_SETUP_FAILURE_CLASSES,
  MAX_CLEAN_RETRY_CONDITIONAL_SETUP_FAILURES,
  MAX_CLEAN_RETRY_SAFE_SETUP_FAILURES,
} from "../user-input-authority.ts";

export function providerDispatchesAwaitingColdReconciliation(managed: ManagedSession): Message[] {
    return managed.messages.filter(message => (
      message.role === 'user'
      && (message.providerDispatch?.state === 'acceptance-unknown'
        || message.providerDispatch?.state === 'accepted')
    ))
  }

export function exactProviderDispatchAcceptanceUnknown(message: Message): boolean {
    const marker = message.providerDispatch
    return marker?.schemaVersion === 1
      && (marker.state === 'acceptance-unknown' || marker.state === 'accepted'
        || marker.state === 'retired-accepted')
      && marker.messageId === message.id
      && typeof marker.objectiveId === 'string' && marker.objectiveId.length > 0
      && typeof marker.objectiveUserMessageId === 'string' && marker.objectiveUserMessageId.length > 0
      && Number.isInteger(marker.generation) && marker.generation > 0
      && Number.isInteger(marker.cancellationEpoch) && marker.cancellationEpoch >= 0
      && Number.isFinite(marker.markedAt) && marker.markedAt > 0
      && (marker.userStoppedAt === undefined
        || (Number.isFinite(marker.userStoppedAt) && marker.userStoppedAt >= marker.markedAt))
      && (marker.state === 'acceptance-unknown'
        || (Number.isFinite(marker.acceptedAt) && marker.acceptedAt! >= marker.markedAt))
      && (marker.state !== 'retired-accepted'
        || (Number.isFinite(marker.retiredAt) && marker.retiredAt! >= marker.acceptedAt!
          && Number.isFinite(marker.userStoppedAt) && marker.userStoppedAt! >= marker.acceptedAt!
          && marker.retirementReason === 'user-stop-after-provider-ack'))
  }

export function assertRetryTurnAnchor(managed: ManagedSession, userMessageId: string): Message {
    let latest = managed.messages.findLast(message => message.role === 'user'
      && !message.hidden && !message.internalOrigin && !message.isQueued && !message.isPending)
    if (!latest && managed.parentSessionId && managed.parentSessionId !== managed.id) {
      // A child can have no human-authored message of its own. Its original
      // delegation is retryable only when the durable parent and exact current
      // objective both authenticate that first request. Later internal messages
      // and clarification receipts never become independent retry authorities.
      const initial = managed.messages.find(message => message.role === 'user')
      const objective = managed.activeObjective
      if (initial && !initial.hidden && !initial.isQueued && !initial.isPending
        && initial.internalOrigin?.kind === 'spawned-session'
        && initial.internalOrigin.senderSessionId === managed.parentSessionId
        && initial.id === objective?.userMessageId && initial.id === objective.objectiveId) {
        latest = initial
      }
    }
    if (!latest && !managed.parentSessionId && managed.triggeredBy) {
      // Automation roots are host-authored user turns, not human messages.
      // Retry may reuse only the unique visible root of this exact objective;
      // queued deliveries and sessions later attached to a parent cannot gain
      // independent retry authority from the automation marker.
      const objective = managed.activeObjective
      const rootId = objective?.userMessageId
      const roots = rootId ? managed.messages.filter(message => message.id === rootId) : []
      const root = roots[0]
      if (roots.length === 1 && root?.role === 'user' && !root.hidden && !root.isQueued && !root.isPending
        && !root.agentDelivery && root.internalOrigin?.kind === 'automation'
        && root.id === objective?.objectiveId) {
        latest = root
      }
    }
    if (!latest || latest.id !== userMessageId) {
      throw new Error('Only the latest accepted user message can be retried')
    }
    return latest
  }

export function nextRecoveryDispatch(
    pending: PendingTurnRecovery,
    cause: AutomaticTurnRecoveryCause,
    origin: NonNullable<PendingTurnRecovery['recoveryDispatch']>['origin'],
    nowMs = Date.now(),
    fallbackIntent?: AutonomyFallbackIntent,
  ): NonNullable<PendingTurnRecovery['recoveryDispatch']> {
    const persistedPriorAttempt = pending.recoveryDispatch?.schemaVersion === 1
      && Number.isSafeInteger(pending.recoveryDispatch.attempt)
      && pending.recoveryDispatch.attempt > 0
      ? pending.recoveryDispatch.attempt
      : 0
    // Hosts predating recoveryDispatch persisted `lastCause=user_retry` before
    // model preparation but had no durable dispatch identity. That legacy state
    // proves one Retry dispatch beyond the automatic budget already started.
    // Reserve its sequence number so the first upgraded restart cannot recreate
    // the observed duplicate attempt label.
    const legacyUntrackedRetryAttempt = persistedPriorAttempt === 0 && pending.lastCause === 'user_retry'
      ? pending.attempts + 1
      : 0
    return {
      schemaVersion: 1,
      id: generateMessageId(),
      attempt: Math.max(pending.attempts, persistedPriorAttempt, legacyUntrackedRetryAttempt) + 1,
      cause,
      origin,
      allocatedAt: nowMs,
      phase: 'allocated',
      preToolExecutionReceiptVersion: 1,
      ...(fallbackIntent ? { fallbackIntent } : {}),
    }
  }

export function validAllocatedRecoveryDispatch(
    pending: PendingTurnRecovery,
  ): NonNullable<PendingTurnRecovery['recoveryDispatch']> | undefined {
    const dispatch = pending.recoveryDispatch
    const knownCause = !!dispatch && [
      'app_restart', 'stream_ended', 'runtime_error', 'premature_final', 'tool_checkpoint',
      'evidence_gate', 'objective_incomplete', 'objective_continue', 'user_retry',
    ].includes(dispatch.cause)
    const originMatchesCause = dispatch?.origin === 'retry'
      ? dispatch.cause === 'user_retry'
      : dispatch?.origin === 'restart'
        ? dispatch.cause !== 'user_retry'
        : dispatch?.origin === 'automatic'
          && dispatch.cause !== 'app_restart' && dispatch.cause !== 'user_retry'
    const fallbackIntentValid = !dispatch?.fallbackIntent || (
      dispatch.cause === 'runtime_error'
      && (dispatch.fallbackIntent.kind === 'browser_fallback'
        || dispatch.fallbackIntent.kind === 'structured_fallback')
      && /^[A-Za-z0-9_.:-]{1,160}$/.test(dispatch.fallbackIntent.failedToolName)
    )
    const cleanContinuationValid = !dispatch?.cleanContinuationId || (
      !dispatch.fallbackIntent
      && /^clean-continuation-v1-[a-f0-9]{24}$/.test(dispatch.cleanContinuationId)
    )
    const setupFailureCount = dispatch?.setupFailureCount
    const setupFailureLimit = dispatch?.lastSetupFailureClass
      && CLEAN_RETRY_NEVER_SETUP_FAILURE_CLASSES.has(dispatch.lastSetupFailureClass)
      ? 1
      : dispatch?.lastSetupFailureClass
        && CLEAN_RETRY_CONDITIONAL_SETUP_FAILURE_CLASSES.has(dispatch.lastSetupFailureClass)
        ? MAX_CLEAN_RETRY_CONDITIONAL_SETUP_FAILURES
        : MAX_CLEAN_RETRY_SAFE_SETUP_FAILURES
    const setupFailureValid = setupFailureCount === undefined
      ? dispatch?.lastSetupFailureClass === undefined && dispatch?.setupRetryNotBefore === undefined
        && dispatch?.setupRetryBlockedAt === undefined
      : Number.isSafeInteger(setupFailureCount) && setupFailureCount > 0
        && setupFailureCount <= MAX_CLEAN_RETRY_SAFE_SETUP_FAILURES
        && typeof dispatch?.lastSetupFailureClass === 'string'
        && CLEAN_RETRY_SETUP_FAILURE_CLASSES.has(dispatch.lastSetupFailureClass)
        && (setupFailureCount >= setupFailureLimit
          ? dispatch.setupRetryNotBefore === undefined
            && Number.isFinite(dispatch.setupRetryBlockedAt) && dispatch.setupRetryBlockedAt! > 0
          : dispatch.setupRetryBlockedAt === undefined
            && Number.isFinite(dispatch.setupRetryNotBefore) && dispatch.setupRetryNotBefore! > 0)
    const setupPersistenceFenceValid = dispatch?.setupPersistenceFencedAt === undefined
      || Number.isFinite(dispatch.setupPersistenceFencedAt) && dispatch.setupPersistenceFencedAt > 0
    return dispatch?.schemaVersion === 1 && dispatch.phase === 'allocated' && knownCause
      && typeof dispatch.id === 'string' && dispatch.id.trim().length > 0 && Number.isSafeInteger(dispatch.attempt)
      && dispatch.attempt > 0 && dispatch.attempt >= pending.attempts
      && Number.isFinite(dispatch.allocatedAt) && dispatch.allocatedAt > 0
      && originMatchesCause && fallbackIntentValid && cleanContinuationValid && setupFailureValid
      && setupPersistenceFenceValid
      ? dispatch
      : undefined
  }

export function classifyAutomaticRecoveryWorkForSession(managed: ManagedSession, cause: AutomaticTurnRecoveryCause, validationGaps?: readonly string[], objectiveText = findObjectiveText(managed.messages, managed.activeObjective)) {
    if (managed.activeObjective?.terminalReconciliation || isExplicitReadOnlyReview(objectiveText ?? '')) return 'read-only-verification' as const;
    if (cause !== 'objective_incomplete' && cause !== 'evidence_gate') return 'substantive' as const;
    const objective = managed.activeObjective;
    if (!objective || (objectiveRequiresExecutionEvidence(objective, objectiveText) && !hasTargetBoundObjectiveExecutionEvidence(objective, managed.messages, managed.id))) return 'substantive' as const;
    const gaps = validationGaps?.map(gap => gap.trim()).filter(Boolean) ?? [];
    if (gaps.length && gaps.every(gap => /^(duplicate criterion|unknown criterion)\s*:/.test(gap))) return 'receipt-repair' as const;
    if (gaps.length && gaps.every(gap => /^(missing structured objective outcome receipt|multiple objective outcome receipts|objective outcome receipt must be the final response element|malformed objective outcome receipt|missing criterion|criterion lacks observed evidence|Business criterion lacks matching post-action evidence|Cited review receipt is missing exact host criterion IDs|authoritative evidence has not been inspected|no authoritative or first-party|continue requires|complete_verified cannot include|The review|A passing review|The requested revision)/i.test(gap))) return 'read-only-verification' as const;
    return 'substantive' as const;
  }

export function cleanSetupRetryDelayMs(
    dispatch: PendingTurnRecovery['recoveryDispatch'] | undefined,
    nowMs = Date.now(),
  ): number {
    if (!dispatch?.cleanContinuationId || !Number.isFinite(dispatch.setupRetryNotBefore)) return 0
    return Math.max(0, dispatch.setupRetryNotBefore! - nowMs)
  }

export function cleanRetrySetupFailureSignal(error: unknown): Parameters<typeof classifyAgentFailure>[0] {
    const records: Record<string, unknown>[] = []
    const seen = new Set<object>()
    const queue: Array<{ value: unknown; depth: number }> = [{ value: error, depth: 0 }]
    while (queue.length && records.length < 8) {
      const { value, depth } = queue.shift()!
      if (!value || typeof value !== 'object' || seen.has(value)) continue
      seen.add(value)
      const record = value as Record<string, unknown>
      records.push(record)
      if (depth >= 3) continue
      queue.push({ value: record.cause, depth: depth + 1 })
      queue.push({ value: record.response, depth: depth + 1 })
    }
    const messages = [error instanceof Error ? error.message : String(error)]
    for (const record of records) {
      if (typeof record.message === 'string' && !messages.includes(record.message)) messages.push(record.message)
    }
    const rawStatus = records.map(record => record.httpStatus ?? record.status ?? record.statusCode)
      .find(status => (
        typeof status === 'number'
          ? Number.isFinite(status) && status >= 400 && status <= 599
          : typeof status === 'string' && /^[45]\d\d$/.test(status.trim())
      ))
    let httpStatus = typeof rawStatus === 'number' && Number.isFinite(rawStatus)
      ? rawStatus
      : typeof rawStatus === 'string' && /^[45]\d\d$/.test(rawStatus.trim())
        ? Number(rawStatus.trim())
        : undefined
    if (httpStatus === undefined) {
      const match = messages.join(' ').match(/\bstatus(?:\s+code)?\s*[:=]?\s*([45]\d\d)\b/i)
      if (match?.[1]) httpStatus = Number(match[1])
    }
    const rawCode = records.map(record => record.code).find(code => (
      typeof code === 'string' || typeof code === 'number'
    ))
    let retryAfterMs = records.map(record => record.retryAfterMs).find(value => (
      typeof value === 'number' && Number.isFinite(value) && value >= 0
    )) as number | undefined
    if (retryAfterMs === undefined) {
      for (const record of records) {
        const headers = record.headers
        let retryAfter: unknown
        try {
          retryAfter = headers && typeof headers === 'object' && 'get' in headers
            && typeof (headers as { get?: unknown }).get === 'function'
            ? (headers as { get(name: string): unknown }).get('retry-after')
            : headers && typeof headers === 'object'
              ? (headers as Record<string, unknown>)['retry-after']
                ?? (headers as Record<string, unknown>)['Retry-After']
              : undefined
        } catch (headerError) {
          sessionLog.warn('Ignored an unreadable Retry-After header while classifying provider setup', {
            error: headerError instanceof Error ? headerError.message : String(headerError),
          })
        }
        if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0) {
          retryAfterMs = retryAfter * 1_000
          break
        }
        if (typeof retryAfter === 'string') {
          const seconds = Number(retryAfter.trim())
          if (Number.isFinite(seconds) && seconds >= 0) {
            retryAfterMs = seconds * 1_000
            break
          }
          const retryDate = Date.parse(retryAfter)
          if (Number.isFinite(retryDate)) {
            retryAfterMs = Math.max(0, retryDate - Date.now())
            break
          }
        }
      }
    }
    return {
      message: messages.join(' | '),
      ...(rawCode !== undefined ? { code: String(rawCode) } : {}),
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(retryAfterMs !== undefined
        ? { retryAfterMs }
        : {}),
    }
  }

export function isImmutableAutomaticRecoveryBlock(
    reason: ReturnType<typeof inspectAutonomousLineage>['reason'],
  ): boolean {
    return reason === 'terminal' || reason === 'parent_changed' || reason === 'missing_parent'
      || reason === 'cross_workspace' || reason === 'cycle' || reason === 'depth'
  }

/** A claimed machine-inbox row is consumed only by provider output or by a
   * later, host-authenticated human supersession. The claimed row itself and
   * other queued machine deliveries are never consumption evidence. */
export function isDurableProviderActivityOrHumanSupersession(
    managed: ManagedSession,
    candidate: Message,
  ): boolean {
    if (candidate.role === 'assistant' || candidate.role === 'tool'
      || candidate.role === 'error' || candidate.role === 'plan'
      || candidate.role === 'auth-request') return true
    if (candidate.role !== 'user' || candidate.isPending || candidate.agentDelivery) return false
    if (!candidate.hidden && !candidate.internalOrigin) return true
    return candidate.hidden === true
      && candidate.internalOrigin?.kind === 'user-input'
      && managed.userInputRequests?.some(request => (
        request.status === 'answered'
        && request.responseMessageId === candidate.id
        && request.sessionId === managed.id
        && request.originWorkspaceId === managed.workspace.id
      )) === true
  }

/** Recovered receipts retain transcript order even when a later durable
   * machine delivery was already present in the in-memory FIFO. */
export function enqueueRecoveredMessageInTranscriptOrder(
    managed: ManagedSession,
    item: ManagedSession['messageQueue'][number],
  ): void {
    if (item.messageId && managed.messageQueue.some(queued => queued.messageId === item.messageId)) return
    const messageIndex = item.messageId
      ? managed.messages.findIndex(message => message.id === item.messageId)
      : -1
    if (messageIndex < 0) {
      managed.messageQueue.push(item)
      return
    }
    const laterQueueIndex = managed.messageQueue.findIndex(queued => {
      if (!queued.messageId) return false
      const queuedMessageIndex = managed.messages.findIndex(message => message.id === queued.messageId)
      return queuedMessageIndex > messageIndex
    })
    if (laterQueueIndex < 0) managed.messageQueue.push(item)
    else managed.messageQueue.splice(laterQueueIndex, 0, item)
  }
