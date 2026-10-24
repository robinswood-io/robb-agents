import type { Message } from "@craft-agent/core/types";
import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { detectHighStakesEvidenceDomain } from "@craft-agent/shared/agent";
import { objectiveAmendmentAuthorityText } from './amendment-authority.ts';
import { amendmentEvidenceRequests } from './amendment-intent.ts';
import { isExplicitReadOnlyClosureRequest } from './closure-intent.ts';
import { startsExplicitNewObjective } from './evidence-domain.ts';
import { boundedObjectiveRiskText, classifyObjectiveRequest } from './execution-authority.ts';
import { explicitlyRevokesExecutionAuthority, latestClauseRequestsExecution } from './execution-revocation.ts';
import { findObjectiveText } from './history-reconstruction.ts';
import { foldForIntent } from './types.ts';

/** Quote accepted context inside the objective's exact transcript window, without changing its contract. */
export function objectivePromptAmendments(objective: ActiveSessionObjective, messages?: readonly Message[]): {
  amendments: ActiveSessionObjective['amendments'];
  missingLegacyAnchor?: boolean;
} {
  const amendments = objective.amendments;
  const latestId = objective.lastUserMessageId;
  if (!messages || !latestId || latestId === objective.userMessageId) return { amendments };
  const isAcceptedPublic = (message: Message) => message.role === 'user' && !message.hidden
    && !message.internalOrigin && !message.agentDelivery && !message.isQueued && !message.isPending;
  const roots = messages.filter(message => message.id === objective.userMessageId);
  const matches = messages.filter(message => message.id === latestId);
  const root = roots[0];
  const latest = matches[0];
  if (roots.length !== 1 || matches.length !== 1 || !root || !latest
    || root.role !== 'user' || !isAcceptedPublic(latest)
    || !Number.isFinite(latest.timestamp) || latest.timestamp < objective.startedAt) {
    return { amendments, missingLegacyAnchor: true };
  }
  const rootIndex = messages.indexOf(root);
  const latestIndex = messages.indexOf(latest);
  const accepted = messages.slice(rootIndex + 1, latestIndex + 1).filter(isAcceptedPublic);
  const occurrences = new Map<string, number>();
  for (const message of messages) occurrences.set(message.id, (occurrences.get(message.id) ?? 0) + 1);
  if (latestIndex <= rootIndex || accepted.some(message => startsExplicitNewObjective(message.content)
    || occurrences.get(message.id) !== 1 || !Number.isFinite(message.timestamp) || message.timestamp < objective.startedAt)) {
    return { amendments, missingLegacyAnchor: true };
  }
  const positions = new Map(accepted.map((message, index) => [message.id, index]));
  const projected = [...new Map((amendments ?? []).map(amendment => [amendment.messageId, amendment])).values()];
  // Preserve durable amendments even if their messages were compacted locally.
  // Insert recovered instructions before the next known amendment in journal order.
  for (let index = 0; index < accepted.length; index++) {
    const message = accepted[index]!;
    const current = { messageId: message.id, text: message.content, timestamp: message.timestamp };
    const existing = projected.findIndex(amendment => amendment.messageId === message.id);
    if (existing >= 0) projected[existing] = current;
    else {
      const following = projected.findIndex(amendment => (positions.get(amendment.messageId) ?? -1) > index);
      projected.splice(following < 0 ? projected.length : following, 0, current);
    }
  }
  // Transcript order is authoritative for every available canonical message.
  // Unavailable durable amendments retain their positions relative to each other.
  let canonicalIndex = 0;
  for (let index = 0; index < projected.length; index++) {
    if (!positions.has(projected[index]!.messageId)) continue;
    const message = accepted[canonicalIndex++]!;
    projected[index] = { messageId: message.id, text: message.content, timestamp: message.timestamp };
  }
  return { amendments: projected };
}

export interface ExplicitReadOnlyAuthorityBoundary {
  messageId: string;
  text: string;
  timestamp: number;
}

/**
 * Return the current direct-user boundary only when it both withdraws mutation
 * authority and limits the remaining scope to read-only work. This is narrower
 * than the ordinary execution classifier: it is used as host-owned evidence
 * for an authority handoff after the allowed preflight has actually passed.
 * A later positive mutation instruction always supersedes the boundary.
 */
export function currentExplicitReadOnlyAuthorityBoundary(
  objective: ActiveSessionObjective,
  messages: readonly Message[],
): ExplicitReadOnlyAuthorityBoundary | undefined {
  const rootText = findObjectiveText([...messages], objective);
  if (!rootText?.trim()) return undefined;
  const promptContext = objectivePromptAmendments(objective, messages);
  if (promptContext.missingLegacyAnchor) return undefined;
  const segments: ExplicitReadOnlyAuthorityBoundary[] = [{
    messageId: objective.userMessageId,
    text: rootText,
    timestamp: objective.startedAt,
  }, ...(promptContext.amendments ?? [])];
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!;
    const authorityText = objectiveAmendmentAuthorityText(segment.text);
    if (amendmentEvidenceRequests(authorityText, objective.delegatedRole).execution
      || latestClauseRequestsExecution(authorityText, objective.delegatedRole)) return undefined;
    const normalized = foldForIntent(authorityText).replace(/-/g, ' ').replace(/\s+/g, ' ');
    const readOnlyScope = /\b(?:lecture seule|read only)\b/.test(normalized);
    const exclusiveScope = /\b(?:uniquement|seulement|strictement|exclusivement|only|strictly|exclusively)\b/.test(normalized);
    const preflightScope = /\b(?:preflight|pre flight|controle prealable|verification prealable)\b/.test(normalized);
    const comprehensiveMutationBan = /\b(?:(?:aucune|plus aucune|pas de)\s+(?:mutation|modification|ecriture|execution|operation|action)s?(?:\s+distantes?)?|(?:neffectue|ne\s+(?:fais|realise|execute))\s+(?:aucune|plus aucune)\s+(?:mutation|modification|ecriture|execution|operation|action)s?|no\s+(?:remote\s+)?(?:mutations?|modifications?|writes?|changes?)|(?:do not|dont)\s+(?:modify|change|write)\s+anything)\b/.test(normalized);
    if (readOnlyScope && exclusiveScope && preflightScope && comprehensiveMutationBan
      && explicitlyRevokesExecutionAuthority(authorityText)) return segment;
  }
  return undefined;
}

/** Bounded host-contract segments used to restore high-stakes evidence state.
 * The durable amendment journal remains authoritative across compaction, while
 * available transcript anchors are reconciled by objectivePromptAmendments. */
export function objectiveEvidenceContractSegments(
  messages: Message[],
  objective: ActiveSessionObjective,
): Array<{ messageId: string; text: string }> {
  const root = findObjectiveText(messages, objective);
  if (!root?.trim()) return [];
  const amendments = (objectivePromptAmendments(objective, messages).amendments ?? [])
    .filter(amendment => typeof amendment?.messageId === 'string' && amendment.messageId.length > 0
      && amendment.messageId.length <= 512 && typeof amendment.text === 'string' && amendment.text.trim().length > 0
      && Number.isFinite(amendment.timestamp)
      && amendment.messageId !== objective.terminalReconciliation?.messageId
      && !isExplicitReadOnlyClosureRequest(amendment.text));
  const latestSensitiveIndex = amendments.findLastIndex(amendment => (
    classifyObjectiveRequest(objectiveAmendmentAuthorityText(amendment.text)).sensitiveDomain
  ));
  const latestEvidenceDomainIndex = amendments.findLastIndex(amendment => (
    detectHighStakesEvidenceDomain(objectiveAmendmentAuthorityText(amendment.text)) !== undefined
  ));
  // Keep the full root, a bounded recent amendment window, the latest broad
  // sensitive anchor, and the latest domain the evidence gate can enforce.
  // A later production mutation must not evict an older security amendment.
  const retained = amendments.filter((_, index) => (
    index >= amendments.length - 16 || index === latestSensitiveIndex || index === latestEvidenceDomainIndex
  ));
  return [
    { messageId: objective.userMessageId,
      text: boundedObjectiveRiskText(objectiveAmendmentAuthorityText(root), 8_192) },
    ...retained.map(amendment => ({
      messageId: amendment.messageId,
      text: boundedObjectiveRiskText(objectiveAmendmentAuthorityText(amendment.text), 2_048),
    })),
  ];
}
