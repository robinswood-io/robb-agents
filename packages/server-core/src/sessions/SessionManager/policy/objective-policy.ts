import { type ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { type Message } from "@craft-agent/core/types";
import {
  findObjectiveText,
  isHostSyntheticObjectiveMessage,
  isHostSyntheticObjectiveText,
  isLegacyContextualObjectiveRoot,
  isLegacyPlanImplementationRequest,
  objectiveRequiresExecutionEvidence,
  projectLegacyObjectiveCompletionRequirements,
  transitionObjectiveContract,
} from "../../objective-contract";
import type { ManagedSession } from "../managed-session.ts";
import {
  isExactContextLimitNextStepQuestion,
  legacyUserInputAnswerMessageContent,
  userInputAnswerMessageContent,
} from "../user-input-authority.ts";

export function boundObjectiveForCleanHandoff(
    managed: ManagedSession,
    objective: ActiveSessionObjective,
  ): { objective: ActiveSessionObjective; objectiveText: string } {
    const rawObjectiveText = (findObjectiveText(managed.messages, objective) ?? objective.originalText ?? '').trim()
    const boundedObjectiveText = rawObjectiveText.length > 16_000
      ? `${rawObjectiveText.slice(0, 12_000)}\n...\n${rawObjectiveText.slice(-3_990)}`
      : rawObjectiveText
    const rawAmendments = (objective.amendments ?? [])
      .filter(amendment => (
        typeof amendment?.messageId === 'string' && amendment.messageId.trim().length > 0
        && typeof amendment?.text === 'string' && amendment.text.trim().length > 0
      ))
      .slice(-16)
    const maxAmendmentChars = Math.min(4_000, Math.max(256, Math.floor(16_000 / Math.max(1, rawAmendments.length))))
    const headChars = Math.floor(maxAmendmentChars * 0.75)
    const tailChars = Math.max(32, maxAmendmentChars - headChars - 10)
    const boundedAmendments = rawAmendments.map(amendment => {
      const trimmed = amendment.text.trim()
      return {
        ...amendment,
        text: trimmed.length > maxAmendmentChars
          ? `${trimmed.slice(0, headChars)}\n...\n${trimmed.slice(-tailChars)}`
          : trimmed,
      }
    })
    return {
      objective: {
        ...objective,
        originalText: boundedObjectiveText || objective.originalText,
        ...(objective.amendments ? { amendments: boundedAmendments } : {}),
      },
      objectiveText: boundedObjectiveText,
    }
  }

/**
   * An objective root is authority only when it is backed by one exact accepted
   * human turn, or by the authenticated root of a delegated/automation session.
   * Older builds could persist source-activation fallback text as an ordinary
   * visible user row; never let that transport artifact survive as authority.
   */
export function hasAuthenticatedObjectiveRoot(
    managed: ManagedSession,
    objective = managed.activeObjective,
  ): boolean {
    if (!objective) return true
    const roots = managed.messages.filter(message => message.id === objective.userMessageId)
    const root = roots[0]
    if (roots.length !== 1 || !root || root.role !== 'user'
      || root.hidden || root.isQueued || root.isPending || root.agentDelivery
      || isHostSyntheticObjectiveMessage(root)) return false
    if (!root.internalOrigin) return true
    if (root.internalOrigin.kind === 'spawned-session') {
      return !!managed.parentSessionId
        && managed.parentSessionId !== managed.id
        && managed.messages.find(message => message.role === 'user')?.id === root.id
        && root.internalOrigin.senderSessionId === managed.parentSessionId
        && (objective.objectiveId ?? objective.userMessageId) === root.id
    }
    return root.internalOrigin.kind === 'automation'
      && !managed.parentSessionId
      && !!managed.triggeredBy
      && (objective.objectiveId ?? objective.userMessageId) === root.id
  }

/** Project the two known pre-classifier objective schemas from their durable
   * root before a human transition. The new turn itself must never supply the
   * missing authority or completion obligations of the existing objective. */
export function projectLegacyObjectiveForUserTransition(
    managed: ManagedSession,
  ): ActiveSessionObjective | undefined {
    const objective = managed.activeObjective
    if (!objective) return undefined
    return projectLegacyObjectiveCompletionRequirements(
      objective,
      findObjectiveText(managed.messages, objective),
    )
  }

/**
   * Older objective transitions could promote a channel-only correction (for
   * example "use the API, not the UI") or a bare "Résout" to the durable root.
   * Recover only the immediately preceding, directly accepted human mission,
   * or an independently actionable accepted replay after the last verified
   * completion. The old root and its already-bound amendments remain constraints
   * only within that completion boundary; unrelated transcript turns are never
   * replayed as authority.
   */
export function repairLegacyContextualObjectiveAuthority(managed: ManagedSession): boolean {
    const previous = managed.activeObjective
    if (!previous || previous.terminalState === 'complete_verified') return false

    const rootMatches = managed.messages.filter(message => message.id === previous.userMessageId)
    const root = rootMatches[0]
    if (rootMatches.length !== 1 || !root || root.role !== 'user'
      || root.hidden || root.isQueued || root.isPending || root.agentDelivery
      || root.internalOrigin || isHostSyntheticObjectiveMessage(root)) return false
    const rootText = previous.originalText ?? root.content
    if (previous.originalText !== undefined && previous.originalText !== root.content) return false
    if (!isLegacyContextualObjectiveRoot(rootText)) return false

    const rootIndex = managed.messages.indexOf(root)
    let candidate: Message | undefined
    for (let index = rootIndex - 1; index >= 0; index -= 1) {
      const message = managed.messages[index]!
      if (message.role !== 'user' || message.hidden || message.isQueued || message.isPending
        || message.agentDelivery || message.internalOrigin || isHostSyntheticObjectiveMessage(message)) continue
      // Duplicate IDs make the provenance ambiguous even when both rows carry
      // the same text. Fail closed instead of manufacturing a root that cannot
      // subsequently be authenticated against one exact transcript row.
      if (managed.messages.filter(row => row.id === message.id).length !== 1) return false
      const proposed = transitionObjectiveContract({
        messageId: message.id,
        text: message.content,
        nowMs: message.timestamp,
        lifetimeCostUsd: previous.budgetBaselineUsd,
        lifetimeTokens: previous.tokenBaseline,
      })
      // The nearest public human turn must itself define concrete work. Do not
      // walk through a different conversational request to recover older power.
      if (!objectiveRequiresExecutionEvidence(proposed) && !proposed.requiresObservationEvidence) return false
      candidate = message
      break
    }
    if (!candidate) return false

    const candidateIndex = managed.messages.indexOf(candidate)

    const lineageIds = new Set<string>([
      previous.userMessageId,
      ...(previous.amendments ?? []).map(amendment => amendment.messageId),
      ...(previous.lastUserMessageId ? [previous.lastUserMessageId] : []),
    ])
    const replayRows = new Map<string, { messageId: string; text: string; timestamp: number; order: number }>()
    replayRows.set(root.id, {
      messageId: root.id,
      text: root.content,
      timestamp: root.timestamp,
      order: rootIndex,
    })
    for (const amendment of previous.amendments ?? []) {
      if (isHostSyntheticObjectiveText(amendment.text)) continue
      const matches = managed.messages.filter(message => message.id === amendment.messageId)
      const transcript = matches.length === 1 ? matches[0] : undefined
      const transcriptIndex = transcript ? managed.messages.indexOf(transcript) : -1
      // Durable objective metadata is not human authority. Replay an
      // amendment only when one exact accepted public row after the corrupted
      // root still backs it; an older unrelated transcript row cannot be
      // relabelled as a later amendment by persisted metadata.
      if (!transcript || transcript.role !== 'user' || transcript.hidden || transcript.isQueued
        || transcript.isPending || transcript.agentDelivery || transcript.internalOrigin
        || transcript.content !== amendment.text || isHostSyntheticObjectiveMessage(transcript)
        || transcriptIndex <= rootIndex) continue
      replayRows.set(amendment.messageId, {
        messageId: amendment.messageId,
        text: amendment.text,
        timestamp: amendment.timestamp,
        order: transcriptIndex,
      })
    }
    if (previous.lastUserMessageId && lineageIds.has(previous.lastUserMessageId)
      && !replayRows.has(previous.lastUserMessageId)) {
      const matches = managed.messages.filter(message => message.id === previous.lastUserMessageId)
      const transcript = matches.length === 1 ? matches[0] : undefined
      const transcriptIndex = transcript ? managed.messages.indexOf(transcript) : -1
      if (transcript?.role === 'user' && !transcript.hidden && !transcript.isQueued
        && !transcript.isPending && !transcript.agentDelivery && !transcript.internalOrigin
        && !isHostSyntheticObjectiveMessage(transcript) && transcriptIndex > rootIndex) {
        replayRows.set(transcript.id, {
          messageId: transcript.id,
          text: transcript.content,
          timestamp: transcript.timestamp,
          order: transcriptIndex,
        })
      }
    }

    const orderedReplayRows = [...replayRows.values()].sort((left, right) => (
      left.order - right.order || left.timestamp - right.timestamp
    ))
    const replayEndIndex = Math.max(
      rootIndex,
      ...orderedReplayRows.map(row => row.order),
    )
    let lastVerifiedCompletionIndex = -1
    for (let index = candidateIndex + 1; index <= replayEndIndex; index += 1) {
      const message = managed.messages[index]
      if (message?.role === 'assistant' && message.objectiveOutcome?.state === 'complete_verified') {
        lastVerifiedCompletionIndex = index
      }
    }

    let recoveryRoot = {
      messageId: candidate.id,
      text: candidate.content,
      timestamp: candidate.timestamp,
      order: candidateIndex,
    }
    if (lastVerifiedCompletionIndex >= 0 && !isLegacyPlanImplementationRequest(rootText)) {
      // A verified completion permanently closes all earlier authority. A later
      // accepted human replay may become the root only when it defines concrete
      // work on its own; a deictic "continue" cannot reopen the completed goal.
      const postCompletionRoot = orderedReplayRows.find(row => {
        if (row.order <= lastVerifiedCompletionIndex) return false
        const proposed = transitionObjectiveContract({
          messageId: row.messageId,
          text: row.text,
          nowMs: row.timestamp,
          lifetimeCostUsd: previous.budgetBaselineUsd,
          lifetimeTokens: previous.tokenBaseline,
        })
        return objectiveRequiresExecutionEvidence(proposed) || !!proposed.requiresObservationEvidence
      })
      if (!postCompletionRoot) return false
      recoveryRoot = postCompletionRoot
    }

    let recovered = transitionObjectiveContract({
      messageId: recoveryRoot.messageId,
      text: recoveryRoot.text,
      nowMs: recoveryRoot.timestamp,
      lifetimeCostUsd: previous.budgetBaselineUsd,
      lifetimeTokens: previous.tokenBaseline,
    })
    for (const amendment of orderedReplayRows) {
      if (amendment.order <= recoveryRoot.order) continue
      recovered = transitionObjectiveContract({
        existing: recovered,
        messageId: amendment.messageId,
        text: amendment.text,
        nowMs: amendment.timestamp,
      })
    }

    const recoveredLineageIds = new Set([
      recovered.userMessageId,
      recovered.lastUserMessageId,
      ...(recovered.amendments ?? []).map(amendment => amendment.messageId),
    ].filter((id): id is string => !!id))
    // A business question is part of this same human objective when the
    // repaired legacy root is replayed as an exact authenticated amendment.
    // Move a pending binding, or an answered binding backed by one exact host
    // response, to the recovered root so its queued replay/authority remains
    // usable. The legacy hard-limit prompt deliberately keeps its old dispatch
    // anchor: the bounded clean-Retry proof consumes it by that exact
    // provenance rather than turning it into ordinary authority.
    if (recovered.userMessageId !== previous.userMessageId
      && recoveredLineageIds.has(previous.userMessageId)) {
      for (const request of managed.userInputRequests ?? []) {
        if (request.sessionId !== managed.id
          || request.originWorkspaceId !== managed.workspace.id
          || request.objectiveUserMessageId !== previous.userMessageId
          || isExactContextLimitNextStepQuestion(request)) continue
        const unansweredPending = request.status === 'pending'
          && !request.responseMessageId && !request.answers
        const exactAnsweredResponse = (() => {
          if (request.status !== 'answered' || !request.responseMessageId
            || !request.answers?.length) return false
          const matches = managed.messages.filter(message => message.id === request.responseMessageId)
          const response = matches[0]
          return matches.length === 1 && !!response
            && response.role === 'user' && response.hidden === true
            && !response.isPending && !response.agentDelivery
            && response.internalOrigin?.kind === 'user-input'
            && [
              userInputAnswerMessageContent(request.id, request.questions, request.answers),
              legacyUserInputAnswerMessageContent(request.id, request.questions, request.answers),
            ].includes(response.content)
        })()
        if (!unansweredPending && !exactAnsweredResponse) continue
        request.objectiveUserMessageId = recovered.userMessageId
      }
    }
    const registrationRevision = previous.acceptanceRegisteredRevision ?? previous.acceptanceRevision
    const preserveAcceptance = !!previous.acceptanceCriteria?.length
      && !!registrationRevision
      && recoveredLineageIds.has(registrationRevision)
      && (!previous.acceptanceRevision || recoveredLineageIds.has(previous.acceptanceRevision))
    managed.activeObjective = {
      ...recovered,
      budgetBaselineUsd: previous.budgetBaselineUsd,
      tokenBaseline: previous.tokenBaseline,
      terminalState: previous.terminalState,
      ...(previous.completedAt !== undefined ? { completedAt: previous.completedAt } : {}),
      ...(previous.lastOutcome ? { lastOutcome: previous.lastOutcome } : {}),
      ...(previous.automaticModelTier
        ? { automaticModelTier: previous.automaticModelTier } : {}),
      ...(previous.model ? { model: previous.model } : {}),
      ...(previous.thinkingLevel ? { thinkingLevel: previous.thinkingLevel } : {}),
      ...(previous.procedure ? { procedure: previous.procedure } : {}),
      ...(preserveAcceptance ? {
        requiresAcceptanceCriteria: true,
        acceptanceCriteria: previous.acceptanceCriteria,
        ...(previous.acceptanceRegisteredAt !== undefined
          ? { acceptanceRegisteredAt: previous.acceptanceRegisteredAt } : {}),
        ...(previous.acceptanceRegisteredAtById
          ? { acceptanceRegisteredAtById: previous.acceptanceRegisteredAtById } : {}),
        ...(previous.acceptanceRevision ? { acceptanceRevision: previous.acceptanceRevision } : {}),
        ...(previous.acceptanceRegisteredRevision
          ? { acceptanceRegisteredRevision: previous.acceptanceRegisteredRevision } : {}),
        ...(previous.acceptanceNeedsReview !== undefined
          ? { acceptanceNeedsReview: previous.acceptanceNeedsReview } : {}),
        ...(previous.acceptanceHistory ? { acceptanceHistory: previous.acceptanceHistory } : {}),
      } : {}),
      ...(preserveAcceptance && recovered.terminalReconciliation ? {
        terminalReconciliation: {
          messageId: recovered.terminalReconciliation.messageId,
          timestamp: recovered.terminalReconciliation.timestamp,
          ...(previous.terminalReconciliation?.messageId === recovered.terminalReconciliation.messageId
            && previous.terminalReconciliation.initialAcceptanceRegistrationRequired === true
            ? { initialAcceptanceRegistrationRequired: true as const } : {}),
        },
      } : {}),
    }
    if (managed.pendingTurnRecovery
      && !recoveredLineageIds.has(managed.pendingTurnRecovery.userMessageId)) {
      managed.pendingTurnRecovery = undefined
    }
    return true
  }

export function isLegacyHostObjectiveContractEnabled(_managed: ManagedSession): boolean {
    return process.env.ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT === '1'
  }
