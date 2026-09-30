import type { Message } from '@craft-agent/core'
import type { TodoItem } from './TurnCard'
import type { AssistantTurn, Turn } from './turn-utils'
import { describeJourneyActivity, safeActivityText, type JourneyActivity } from './journey-activity'

export interface ConversationPresentationOptions {
  /** Processing state of this session, separately from delegated work. */
  isProcessing: boolean
  sessionId?: string
  parentSessionId?: string
  hasActiveDescendants?: boolean
  /** Read-only subset of the host contract; keeps the viewer independent of server modules. */
  activeObjective?: {
    objectiveId?: string
    userMessageId: string
    lastUserMessageId?: string
    startedAt: number
    originalText?: string
    terminalState: 'active' | 'complete_verified' | 'blocked_human' | 'blocked_policy' | 'exhausted'
    lastOutcome?: { remainingWork?: string[] }
    interruptedTurnRecovery?: {
      objectiveId: string
      userMessageId: string
      recovery: {
        lastCause?: string
        continuationOrigin?: 'objective_continue'
        continuationWork?: string[]
      }
    }
  }
  pendingTurnRecovery?: unknown
  awaitingInput?: boolean
}

export interface ConversationProgress {
  state: 'running' | 'recovering' | 'waiting'
  phase: 'preparing' | 'working' | 'checking' | 'finishing'
  steps: TodoItem[]
  activity?: JourneyActivity
}

export interface ConversationOutcome {
  objectiveText: string
  state: 'succeeded' | 'failed' | 'interrupted' | 'blocked' | 'unverified'
  remainingWork: string[]
  /** Current host rejection reasons, displayed as bounded plain diagnostic text. */
  validationGaps?: string[]
  hasFinalResponse: boolean
  /** Existing accepted request to resume; never a hidden recovery or a queued message. */
  retryUserMessageId?: string
  steps?: TodoItem[]
}

export interface ConversationPresentation {
  turns: Turn[]
  progress?: ConversationProgress
  outcome?: ConversationOutcome
}

const PLAN_TOOL = /^(?:(?:functions\.)|mcp__session__|session__)?(?:TodoWrite|todo_write|update_plan)$/i
const COORDINATION_TOOL = /^(?:mcp__session__|session__)?(?:send_agent_message|spawn_session|wait_sessions|list_sessions|get_session_info|list_background_tasks)$/
const CHECKING = /(?:^|[\s_:/.-])(?:check|verify|validate|test|lint|typecheck|inspect|review|vérifi\w*|verifi\w*|contrôle\w*|controle\w*|teste\w*)(?:$|[\s_:/.-])/i
const INTERRUPTION = /\b(?:interrupted|interruption|cancelled|canceled|interrompue?|annulée?)\b/i
const LEGACY_VALIDATION_FAILURE = /^Automatic continuation stopped because the completion contract still could not be validated within the retry limit\./

function displayValidationGaps(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.slice(0, 16).map(gap => safeActivityText(gap, 500)).filter((gap): gap is string => !!gap))]
}

// Older source-activation retries persisted the appended host prompt as user
// text. Match its exact envelope and a known user ID, never arbitrary XML.
const LEGACY_CONTRACT_HEADER = /^<host_objective_contract objective_user_message_id="(msg-\d+-[a-z0-9]+)" orchestration="(?:direct|mission)" risk="(?:standard|high-stakes)">\r?\nCompletion criteria: (?:requested-outcome-delivered|relevant-checks-passed|no-safe-work-remaining|independent-review-passed)(?:, (?:requested-outcome-delivered|relevant-checks-passed|no-safe-work-remaining|independent-review-passed))*\.\r?\n/
const LEGACY_CONTRACT_CLASSIFICATION = '\nBefore ending, evaluate the objective as exactly one of: complete_verified, blocked_human, blocked_policy, continue.'
const LEGACY_ACTIVATION_SUFFIX = /^\s*(?:\[[a-z0-9][a-z0-9_-]* activated\]\s*)*$/

function insideMarkdownFence(prefix: string): boolean {
  let fence: string | undefined
  for (const line of prefix.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (!marker) continue
    if (!fence) fence = marker[1]!
    else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined
  }
  return !!fence
}

function legacyUserText(content: string, knownUserIds: Set<string>): string {
  let visible = content
  // Repeated source activation could append more than one complete envelope.
  while (true) {
    const start = visible.lastIndexOf('<host_objective_contract')
    if (start < 0) return visible
    const prefix = visible.slice(0, start)
    if ((start > 0 && !/\r?\n\r?\n$/.test(prefix)) || insideMarkdownFence(prefix)) return visible
    const body = visible.slice(start)
    const header = LEGACY_CONTRACT_HEADER.exec(body)
    if (!header || !knownUserIds.has(header[1]!)) return visible
    const end = body.indexOf('\n</host_objective_contract>')
    if (end < 0 || !body.slice(0, end).replace(/\r\n/g, '\n').includes(LEGACY_CONTRACT_CLASSIFICATION)) return visible
    const suffix = body.slice(end + '\n</host_objective_contract>'.length)
    if (!LEGACY_ACTIVATION_SUFFIX.test(suffix)) return visible
    // Keep the human prefix byte-for-byte, removing only the injected separator.
    visible = prefix.replace(/\r?\n\r?\n$/, '')
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function isPublic(message: Message): boolean {
  return !message.hidden && !message.internalOrigin && !message.parentToolUseId
}

/** Match the host's narrow fallback for children with no accepted human request. */
function initialDelegationRetryAnchor(messages: Message[], options: ConversationPresentationOptions): Message | undefined {
  const initial = messages.find(message => message.role === 'user')
  const objective = options.activeObjective
  return options.sessionId && options.parentSessionId && options.parentSessionId !== options.sessionId
    && initial && !initial.hidden && !initial.isQueued && !initial.isPending
    && initial.internalOrigin?.kind === 'spawned-session'
    && initial.internalOrigin.senderSessionId === options.parentSessionId
    && initial.id === objective?.userMessageId && initial.id === objective?.objectiveId
    ? initial : undefined
}

function isFinal(message: Message): boolean {
  return isPublic(message) && message.role === 'assistant'
    && !message.isIntermediate && !message.isStreaming && !message.isPending
    && !!message.content.trim() && !message.objectiveOutcomeError
    && message.objectiveOutcome?.state !== 'continue'
}

function finalTurn(message: Message): AssistantTurn {
  return {
    type: 'assistant', turnId: message.turnId ?? message.id,
    activities: [], isStreaming: false, isComplete: true, timestamp: message.timestamp,
    response: { text: message.content, messageId: message.id, isStreaming: false, annotations: message.annotations },
  }
}

/** A failed or checkpointed plan update never replaces the last confirmed plan. */
function confirmedPlan(message: Message): TodoItem[] | undefined {
  if (!isPublic(message) || message.role !== 'tool' || !PLAN_TOOL.test(message.toolName ?? '')
    || message.toolStatus !== 'completed' || message.isError || message.toolExecuted === false
    || message.toolCheckpoint || message.isPending || message.isStreaming
    || !message.toolResult?.trim()) return undefined
  const input = message.toolInput
  const values = input?.todos ?? input?.plan
  if (!Array.isArray(values)) return undefined
  const steps: TodoItem[] = []
  for (const value of values) {
    const item = record(value)
    const content = item?.content ?? item?.step
    const status = item?.status
    if (typeof content !== 'string' || !content.trim()
      || (status !== 'pending' && status !== 'in_progress' && status !== 'completed')) return undefined
    steps.push({ content, status, ...(typeof item?.activeForm === 'string' ? { activeForm: item.activeForm } : {}) })
  }
  return steps
}

function phaseFor(messages: Message[], steps: TodoItem[], recovering: boolean): ConversationProgress['phase'] {
  const activeStep = steps.find(step => step.status === 'in_progress')
  if (activeStep) return CHECKING.test(activeStep.content) ? 'checking' : 'working'
  if (steps.length > 0 && steps.every(step => step.status === 'completed')) return 'finishing'
  const relevant = messages.filter(message => isPublic(message) && !COORDINATION_TOOL.test(message.toolName ?? ''))
  if (relevant.some(message => message.role === 'assistant' && !message.isIntermediate)) return 'finishing'
  // Once a semantic check was reached, later reads or compactions cannot make
  // the phase oscillate. Raw provider statuses and intents are never displayed.
  if (relevant.some(message => message.role === 'tool' && CHECKING.test(message.toolName ?? '')) || recovering) return 'checking'
  if (messages.some(message => isPublic(message) && message.role === 'tool'
    && !PLAN_TOOL.test(message.toolName ?? '') && !COORDINATION_TOOL.test(message.toolName ?? ''))) return 'working'
  return 'preparing'
}

/**
 * Display-only projection. The persisted transcript remains the audit source;
 * only a host-validated objective can produce a succeeded outcome.
 */
export function projectConversation(
  messages: Message[],
  options: ConversationPresentationOptions,
): ConversationPresentation {
  const ordered = [...messages].sort((left, right) => left.timestamp - right.timestamp)
  const knownUserIds = new Set(ordered.filter(message => isPublic(message) && message.role === 'user').map(message => message.id))
  if (options.activeObjective) knownUserIds.add(options.activeObjective.userMessageId)
  const userIndexes = ordered.flatMap((message, index) => isPublic(message) && message.role === 'user' ? [index] : [])
  const acceptedUserIndexes = userIndexes.filter(index => !ordered[index]!.isQueued && !ordered[index]!.isPending)
  const lastUserIndex = acceptedUserIndexes[acceptedUserIndexes.length - 1] ?? userIndexes[userIndexes.length - 1] ?? -1
  const lastUser = ordered[lastUserIndex]
  const retryAnchor = acceptedUserIndexes.length
    ? ordered[acceptedUserIndexes[acceptedUserIndexes.length - 1]!]
    : initialDelegationRetryAnchor(messages, options)
  const offeredObjective = options.activeObjective
  // During optimistic sends the DTO can still describe the previous request.
  // Do not carry its success, response or plan into the new visible request.
  const objective = offeredObjective && (!lastUser
    || lastUser.id === offeredObjective.userMessageId
    || lastUser.id === offeredObjective.lastUserMessageId) ? offeredObjective : undefined
  const interruptedContinuation = objective?.terminalState === 'exhausted'
    && objective.interruptedTurnRecovery
    && objective.interruptedTurnRecovery.objectiveId === (objective.objectiveId ?? objective.userMessageId)
    && objective.interruptedTurnRecovery.userMessageId === (objective.lastUserMessageId ?? objective.userMessageId)
    && (objective.interruptedTurnRecovery.recovery.continuationOrigin === 'objective_continue'
      || (objective.interruptedTurnRecovery.recovery.lastCause === 'objective_continue'
        && !!objective.interruptedTurnRecovery.recovery.continuationWork?.length))
    ? objective.interruptedTurnRecovery.recovery : undefined
  const rootIndex = objective ? ordered.findIndex(message => isPublic(message)
    && message.role === 'user' && message.id === objective.userMessageId) : -1
  let scopeStart = rootIndex >= 0 ? rootIndex : Math.max(0, lastUserIndex)
  if (objective && lastUserIndex < 0) {
    const firstCurrent = ordered.findIndex(message => message.timestamp >= objective.startedAt)
    scopeStart = firstCurrent >= 0 ? firstCurrent : ordered.length
  }
  const scoped = ordered.slice(scopeStart)
  const scopedPublic = scoped.filter(isPublic)
  const recovery = record(options.pendingTurnRecovery)
  const recoveryRoot = recovery?.userMessageId
  const recoveryMatches = typeof recoveryRoot === 'string'
    && (recoveryRoot === objective?.userMessageId || recoveryRoot === objective?.lastUserMessageId
      || recoveryRoot === lastUser?.id)
  const terminal = objective && objective.terminalState !== 'active'
  const lastSignal = [...scopedPublic].reverse().find(message =>
    (!lastUser || message.timestamp >= lastUser.timestamp)
    && (message.role === 'error' || (message.role === 'auth-request' && message.authStatus === 'failed')
      || (message.role === 'info' && INTERRUPTION.test(message.content))))
  const lastAcceptedFinal = (!objective || objective.terminalState === 'complete_verified')
    ? [...scopedPublic].reverse().find(isFinal) : undefined
  const latestSignal = lastSignal && (!lastAcceptedFinal || lastSignal.timestamp >= lastAcceptedFinal.timestamp)
    ? lastSignal : undefined
  // A durable retry marker is intent, not evidence that a worker is running.
  // Once the host is idle, an error/stop after its last attempt must remain
  // actionable even if the marker could not be cleared (for example ENOSPC).
  const stoppedRecovery = !options.isProcessing && !!latestSignal
    && (typeof recovery?.lastAttemptAt !== 'number' || latestSignal.timestamp >= recovery.lastAttemptAt)
  const recovering = !terminal && !stoppedRecovery && recoveryMatches && !recovery?.exhaustedAt
    && (typeof recovery?.lastCause === 'string' || recovery?.continuationRequired === true
      || (typeof recovery?.attempts === 'number' && recovery.attempts > 0))
  const pendingAuth = scopedPublic.some(message => message.role === 'auth-request' && message.authStatus === 'pending')
  const lastSubmittedPlan = scopedPublic.map(message => message.role === 'plan').lastIndexOf(true)
  const pendingPlan = lastSubmittedPlan >= 0 && !scopedPublic.slice(lastSubmittedPlan + 1).some(message =>
    message.role === 'user' || message.role === 'tool' || isFinal(message) || message.role === 'error' || (message.role === 'auth-request' && message.authStatus === 'failed')
    || (message.role === 'info' && INTERRUPTION.test(message.content)))
  const waiting = options.awaitingInput === true || (!terminal && !stoppedRecovery && (pendingAuth || pendingPlan))
  const active = options.isProcessing || options.hasActiveDescendants === true || recovering || waiting
  let steps: TodoItem[] = []
  for (const message of scoped) {
    const plan = confirmedPlan(message)
    if (plan) steps = plan
  }

  // Every human request is a history segment. The current host objective merges
  // its clarification segments for progress; completed text is preserved below.
  const finalBySegment = new Map<number, { message: Message; index: number }>()
  const planBySegment = new Map<number, Message>()
  const requestSegmentByIndex: number[] = []
  let requestSegment = -1
  let segment = -1
  ordered.forEach((message, index) => {
    if (isPublic(message) && message.role === 'user' && !message.isQueued) segment = requestSegment = index
    requestSegmentByIndex.push(requestSegment)
    if (index >= scopeStart) segment = scopeStart
    if (isFinal(message)) finalBySegment.set(segment, { message, index })
    if (isPublic(message) && message.role === 'plan') planBySegment.set(segment, message)
  })
  let currentFinal = finalBySegment.get(scopeStart)
  // A receipt printed before further work or a recovery nudge is provisional.
  // Internal report delivery by itself does not stale an existing final.
  const workAfterFinal = currentFinal && scoped.some((message, offset) => scopeStart + offset > currentFinal!.index
    && !message.internalOrigin && !message.parentToolUseId && (
      (message.role === 'tool' && !COORDINATION_TOOL.test(message.toolName ?? ''))
      || (message.role === 'assistant' && message.isIntermediate)
      || (message.role === 'user' && message.hidden)
      || message.role === 'error'
      || (message.role === 'auth-request' && message.authStatus === 'failed')
      || (message.role === 'info' && INTERRUPTION.test(message.content))
    ))
  const showBlockedQuestion = waiting && !options.isProcessing && !recovering
    && (objective?.terminalState === 'blocked_human' || objective?.terminalState === 'blocked_policy')
  // A finished parent response remains readable while a child is active or an
  // old recovery marker awaits cleanup. The progress state still communicates
  // ongoing work; displaying prose does not validate its claimed outcome.
  const showFinishedParentResponse = !options.isProcessing && !waiting && !workAfterFinal
  if ((active && !showBlockedQuestion && !showFinishedParentResponse)
    || (workAfterFinal && objective?.terminalState !== 'complete_verified')) {
    finalBySegment.delete(scopeStart)
    currentFinal = undefined
  }
  // A rejected machine receipt must not erase the human explanation when work
  // has stopped. This is a readable report, never proof of objective success.
  if (!options.isProcessing && !currentFinal) {
    for (let index = ordered.length - 1; index >= Math.max(scopeStart, lastUserIndex); index--) {
      const message = ordered[index]!
      if (isPublic(message) && message.role === 'assistant' && !message.isStreaming && !message.isPending
        && !!message.content.trim() && (message.objectiveOutcomeError || message.objectiveOutcome)) {
        const resumedAfterReport = active && ordered.slice(index + 1).some(next =>
          !next.internalOrigin && !next.parentToolUseId && (
            (next.role === 'user' && next.hidden)
            || (next.role === 'tool' && !COORDINATION_TOOL.test(next.toolName ?? ''))
            || (next.role === 'assistant' && next.isIntermediate)))
        if (resumedAfterReport) break
        currentFinal = { message, index }
        finalBySegment.set(scopeStart, currentFinal)
        break
      }
    }
  }
  const visibleFinalIds = new Set([...finalBySegment.values()].map(item => item.message.id))
  // A completed response can contain the deliverable itself. Reclassifying its
  // receipt for further verification must not erase that text while working,
  // or replace it with a later short validation summary. Preserve its original
  // history position after new requests too, deduplicating only within each
  // human request. Receipt metadata only identifies produced text here; the
  // current host objective still owns the progress/outcome.
  const producedTextsBySegment = new Map<number, Set<string>>()
  for (const { message, index } of finalBySegment.values()) {
    producedTextsBySegment.set(requestSegmentByIndex[index]!, new Set([message.content]))
  }
  for (let index = ordered.length - 1; index >= 0; index--) {
    const message = ordered[index]!
    const requestSegment = requestSegmentByIndex[index]!
    const producedTexts = producedTextsBySegment.get(requestSegment) ?? new Set<string>()
    if (!isPublic(message) || message.role !== 'assistant' || message.isStreaming || message.isPending
      || !message.content.trim()
      || (!message.objectiveOutcomeError && message.objectiveOutcome?.state !== 'complete_verified')
      || producedTexts.has(message.content)) continue
    producedTexts.add(message.content)
    producedTextsBySegment.set(requestSegment, producedTexts)
    visibleFinalIds.add(message.id)
  }
  const visiblePlanIds = new Set([...planBySegment.values()].map(message => message.id))
  const turns: Turn[] = []
  for (const message of ordered) {
    if (!isPublic(message)) continue
    if (message.role === 'user') {
      const content = legacyUserText(message.content, knownUserIds)
      turns.push({ type: 'user', message: content === message.content ? message : { ...message, content }, timestamp: message.timestamp })
    }
    else if (message.role === 'auth-request' && message.authStatus === 'pending' && scoped.includes(message))
      turns.push({ type: 'auth-request', message, timestamp: message.timestamp })
    // Retain the latest terminal error and its retry/reconnect actions. Routine
    // historical errors stay out of the quiet view once a new request starts.
    else if (!active && message === latestSignal && message.role === 'error')
      turns.push({ type: 'system', message, timestamp: message.timestamp })
    else if (message.role === 'plan' && visiblePlanIds.has(message.id)) turns.push({
      type: 'assistant', turnId: message.turnId ?? message.id, isComplete: true, isStreaming: false,
      timestamp: message.timestamp,
      activities: [{ id: message.id, type: 'plan', status: 'completed', content: message.content,
        messageId: message.id, annotations: message.annotations, timestamp: message.timestamp }],
    })
    else if (visibleFinalIds.has(message.id)) turns.push(finalTurn(message))
  }

  if (active) return { turns, progress: {
    state: waiting ? 'waiting' : recovering ? 'recovering' : 'running',
    phase: phaseFor(scoped, steps, recovering), steps,
    activity: describeJourneyActivity(scoped, steps),
  } }

  const interrupted = !!interruptedContinuation || latestSignal?.role === 'info'
  const failed = latestSignal?.role === 'error' || latestSignal?.authStatus === 'failed' || (recoveryMatches && !!recovery?.exhaustedAt)
  // Legacy/direct conversations already have their answer. Missing host proof
  // metadata alone is no reason to append a warning or repeat the request.
  if (!objective && currentFinal && isFinal(currentFinal.message) && !failed && !interrupted && !steps.length) return { turns }
  const hasWork = scopedPublic.some(message => message.role === 'tool' || message.role === 'assistant')
  const shouldSummarize = !!terminal || !!currentFinal || failed || interrupted || hasWork
  if (!shouldSummarize) return { turns }
  const explicitFailure = latestSignal?.role === 'error' || latestSignal?.authStatus === 'failed'
  const state: ConversationOutcome['state'] = interrupted ? 'interrupted' : explicitFailure ? 'failed'
    : objective?.terminalState === 'complete_verified' ? 'succeeded'
    : objective?.terminalState === 'blocked_human' || objective?.terminalState === 'blocked_policy' ? 'blocked'
    : objective?.terminalState === 'exhausted' || failed ? 'failed'
    : interrupted || !currentFinal ? 'interrupted' : 'unverified'
  const typedValidationFailure = latestSignal?.role === 'error' && latestSignal.errorCode === 'objective_validation_failed'
  // Old snapshots carry the diagnostic only on the recovery marker. A merged
  // objective can include a newer clarification: require its own marker or a
  // validation attempt observed after that clarification before reusing gaps.
  const recoveryDiagnosticsAreCurrent = recoveryMatches && (!lastUser || recoveryRoot === lastUser.id
    || (typeof recovery?.lastAttemptAt === 'number' && recovery.lastAttemptAt >= lastUser.timestamp))
  const legacyValidationFailure = (!latestSignal && objective?.terminalState === 'exhausted')
    || (latestSignal?.role === 'error' && !latestSignal.errorCode && LEGACY_VALIDATION_FAILURE.test(latestSignal.content))
  const validationGaps = state === 'failed' || state === 'unverified'
    ? typedValidationFailure ? displayValidationGaps(latestSignal.errorDetails)
      : legacyValidationFailure && recoveryDiagnosticsAreCurrent
        && (recovery?.lastCause === 'objective_incomplete' || recovery?.lastCause === 'evidence_gate')
        ? displayValidationGaps(recovery?.validationGaps) : []
    : []
  return { turns, outcome: {
    objectiveText: legacyUserText(objective?.originalText ?? (rootIndex >= 0 ? ordered[rootIndex]?.content : lastUser?.content) ?? '', knownUserIds),
    state, remainingWork: [...(objective?.lastOutcome?.remainingWork
      ?? interruptedContinuation?.continuationWork ?? [])],
    ...(validationGaps.length ? { validationGaps } : {}),
    hasFinalResponse: !!currentFinal,
    ...(retryAnchor && (state === 'failed' || state === 'interrupted')
      ? { retryUserMessageId: retryAnchor.id } : {}),
    ...(steps.length ? { steps: steps.map(step => step.status === 'in_progress' ? { ...step, status: 'interrupted' as const } : step) } : {}),
  } }
}
