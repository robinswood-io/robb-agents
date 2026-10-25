import {
  beginObjectiveEvidenceGate,
  checkObjectiveEvidenceBeforeMutation,
  clearObjectiveEvidenceGate,
  recordObjectiveEvidence,
  detectHighStakesEvidenceDomain,
} from "@craft-agent/shared/agent";
import {
  objectiveEvidenceContractSegments,
  classifyAuthorizedObjectiveEvidenceDomain,
  hasObjectiveSubstantiveToolResult,
  isObjectiveEvidenceInvalidatingMutation,
  isObjectiveToolExecutedSuccessfully,
  objectiveReviewBinding,
} from "../../objective-contract";
import type { ManagedSession } from "../managed-session.ts";
import { isTerminalReviewSession } from "../review-lifecycle.ts";

export function rehydrateObjectiveEvidence(managed: ManagedSession): void {
    const objective = managed.activeObjective
    const contractSegments = objective ? objectiveEvidenceContractSegments(managed.messages, objective) : []
    const objectiveText = contractSegments.map(segment => segment.text).join('\n')
    if (!objective || !objectiveText || isTerminalReviewSession(managed)) {
      clearObjectiveEvidenceGate(managed.id)
      return
    }
    // New contracts persist their subject separately from authority. Legacy
    // contracts first recover an authoritative mutation subject, then a
    // read-only subject that a later deictic correction may retain.
    let domain = objective.evidenceDomain
    let domainAnchorId = objective.userMessageId
    if (domain) {
      for (let index = contractSegments.length - 1; index >= 0; index--) {
        if (detectHighStakesEvidenceDomain(contractSegments[index]!.text) !== domain) continue
        domainAnchorId = contractSegments[index]!.messageId
        break
      }
    } else {
      for (let index = contractSegments.length - 1; index >= 0 && !domain; index--) {
        domain = classifyAuthorizedObjectiveEvidenceDomain(contractSegments[index]!.text)
        if (domain) domainAnchorId = contractSegments[index]!.messageId
      }
      for (let index = contractSegments.length - 1; index >= 0 && !domain; index--) {
        domain = detectHighStakesEvidenceDomain(contractSegments[index]!.text)
        if (domain) domainAnchorId = contractSegments[index]!.messageId
      }
    }
    beginObjectiveEvidenceGate(managed.id, objective.userMessageId, objectiveText, {
      risk: objective.risk,
      evidenceRequirement: objective.evidenceRequirement,
      domain,
    })
    const domainAnchorMatches = managed.messages
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => candidate.id === domainAnchorId)
    const domainAnchor = domainAnchorMatches[0]?.candidate
    const acceptedDirectAnchor = !!domainAnchor && domainAnchor.role === 'user' && !domainAnchor.hidden
      && !domainAnchor.internalOrigin && !domainAnchor.agentDelivery && !domainAnchor.isQueued && !domainAnchor.isPending
    const acceptedDelegatedRoot = !!domainAnchor && domainAnchorId === objective.userMessageId
      && domainAnchor.role === 'user' && !domainAnchor.hidden && !domainAnchor.agentDelivery
      && !domainAnchor.isQueued && !domainAnchor.isPending
      && domainAnchor.internalOrigin?.kind === 'spawned-session'
      && domainAnchor.internalOrigin.senderSessionId === managed.parentSessionId
    const acceptedAutomationRoot = !!domainAnchor && domainAnchorId === objective.userMessageId
      && domainAnchor.role === 'user' && !domainAnchor.hidden && !domainAnchor.agentDelivery
      && !domainAnchor.isQueued && !domainAnchor.isPending && domainAnchor.internalOrigin?.kind === 'automation'
      && !!managed.triggeredBy
    const objectiveIndex = domainAnchorMatches.length === 1
      && (acceptedDirectAnchor || acceptedDelegatedRoot || acceptedAutomationRoot)
      ? domainAnchorMatches[0]!.index
      : -1
    if (objectiveIndex < 0) return
    for (const prior of managed.messages.slice(objectiveIndex + 1)) {
      // Replay the same chronology as the live pre-tool gate. Otherwise a
      // persisted PASS followed by a successful mutation is rehydrated as if
      // the review still covered the final target. A successful mutation can
      // legitimately have an empty result (for example Bash `sed -i`), so it
      // must invalidate before the substantive-evidence filter below.
      if (isObjectiveToolExecutedSuccessfully(prior) && isObjectiveEvidenceInvalidatingMutation(prior)) {
        checkObjectiveEvidenceBeforeMutation(managed.id, prior.toolName ?? 'tool')
      }
      if (!hasObjectiveSubstantiveToolResult(prior)) continue
      const sessionIds = prior.toolInput?.sessionIds
      recordObjectiveEvidence(managed.id, prior.toolName ?? 'tool', prior.toolResult!, false, {
        ...objectiveReviewBinding(objective),
        ...(Array.isArray(sessionIds) && sessionIds.every(id => typeof id === 'string') ? { sessionIds } : {}),
      }, prior.toolInput)
    }
  }
