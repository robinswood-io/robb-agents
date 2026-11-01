import type { Message, ObjectiveAcceptanceCriterion } from "@craft-agent/core/types";
import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { isObjectiveToolExecutedSuccessfully, isObjectiveEvidenceInvalidatingMutation, isObjectiveMutationTool } from "../objective-contract.ts";
import { type LegacyGscSiteIdentity } from "../legacy-gsc-site-identity.ts";
import { DISTINCT_OPAQUE_TARGET_KEY_PATTERN, canonicalToolName, criterionTargetIdentities, inputTargetIdentities } from './criterion-identities.ts';
import { criterionInputMatchesToolInput, exactRegisteredShellObservation, gmailSendConfirmsPreflightCriterion } from './gmail-preflight.ts';

export function mutationMayAffectCriterion(
  message: Message,
  criterion: ObjectiveAcceptanceCriterion,
  criteria: readonly ObjectiveAcceptanceCriterion[],
): boolean {
  if (!isObjectiveEvidenceInvalidatingMutation(message)) return false;
  if (gmailSendConfirmsPreflightCriterion(message, criterion)) return false;
  // Exact registered shell observations do not stale their sibling checks.
  // This exemption is available only after the immutable invocation matches;
  // arbitrary or detected-mutating shell commands remain fail-closed.
  if (exactRegisteredShellObservation(message, criteria)) return false;
  // A registered observation command may be more expressive than the generic
  // Safe-mode shell allow-list (for example a dedicated validation script).
  // Do not let that exact successful invocation invalidate itself; all later
  // unknown/mutating commands remain conservative.
  if (!isObjectiveMutationTool(message)
    && isObjectiveToolExecutedSuccessfully(message)
    && canonicalToolName(message.toolName ?? '') === canonicalToolName(criterion.toolName)
    && criterionInputMatchesToolInput(criterion, message.toolInput)) {
    return false;
  }
  const expected = criterionTargetIdentities(criterion);
  const actual = inputTargetIdentities(message.toolInput);
  const sharedKeys = [...expected.keys()].filter(key => actual.has(key));
  if (sharedKeys.length > 0) {
    // A matching opaque identity is authoritative even if another, broader
    // partition field is inconsistent. Only wholly disjoint opaque identities
    // prove a different entity. Human-readable hosts, paths, URLs and resources
    // can alias each other and therefore remain conservative.
    const opaqueKeys = sharedKeys.filter(key => DISTINCT_OPAQUE_TARGET_KEY_PATTERN.test(key));
    const matchingOpaqueIdentity = opaqueKeys.some(key => (
      [...expected.get(key)!].some(value => actual.get(key)!.has(value))
    ));
    if (matchingOpaqueIdentity) return true;
    if (opaqueKeys.length > 0) return false;
  }
  return true;
}

interface ObservationBoundary {
  afterMessageIndex: number;
  timestamp: number;
  strictTimestamp?: boolean;
}

export function observationBoundary(
  objective: ActiveSessionObjective,
  binding: LegacyGscSiteIdentity | undefined,
  messages: readonly Message[],
  rootIndex: number,
): ObservationBoundary {
  // Modern criteria are immutable exact target/result predicates. Reuse an
  // already successful observation from this objective instead of asking the
  // model to repeat it merely because registration happened later. The narrow
  // legacy identity repair keeps its attested historical boundary.
  if (binding) return { afterMessageIndex: rootIndex, timestamp: objective.acceptanceRegisteredAt ?? objective.startedAt };
  // A direct user amendment creates a new semantic target. Reuse observations
  // made after that authenticated amendment (even before registration), never
  // evidence from the superseded revision. Older persisted revisions without
  // the amendment journal keep the conservative registration boundary.
  if (objective.acceptanceRevision && objective.acceptanceRevision !== objective.userMessageId) {
    const revisionIndexes = messages.flatMap((message, index) => message.role === 'user'
      && message.id === objective.acceptanceRevision && !message.hidden && !message.internalOrigin
      && !message.agentDelivery && !message.isQueued && !message.isPending ? [index] : []);
    if (revisionIndexes.length === 1 && revisionIndexes[0]! > rootIndex) {
      return { afterMessageIndex: revisionIndexes[0]!, timestamp: objective.startedAt };
    }
    return { afterMessageIndex: rootIndex, timestamp: objective.acceptanceRegisteredAt ?? objective.startedAt,
      strictTimestamp: true };
  }
  return { afterMessageIndex: rootIndex, timestamp: objective.startedAt };
}

export function observationIsAfterBoundary(message: Message, messageIndex: number, boundary: ObservationBoundary): boolean {
  return messageIndex > boundary.afterMessageIndex
    && (boundary.strictTimestamp ? message.timestamp > boundary.timestamp : message.timestamp >= boundary.timestamp);
}
