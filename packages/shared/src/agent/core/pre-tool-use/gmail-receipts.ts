import { createHash } from "node:crypto";
import { contextualGmailReplyPreflightAttestationFromObjective } from "../sensitive-external-action.ts";
import type { PendingDependencyKind } from './dependency-guards.ts';
import { hostObservedResolvedThirdPartyDependencies, hostObservedThirdPartyDependencies } from './dependency-guards.ts';
import { observedResolvedThirdPartyDependencies, observedThirdPartyDependencies } from './dependency-state.ts';
import { maybeFinalizeContextualGmailSessionCleanup } from './gmail-cleanup.ts';
import { canonicalGmailEmailSet, contextualGmailBindingExpiresAt, contextualGmailObjectiveFingerprint, contextualGmailObjectiveProvidesClosedExactHumanAnchor, contextualGmailPreflightIntentsMatch, contextualGmailToolReceipt, exactObservedGmailMessageId, hasConclusiveContextualGmailExactEffectReconciliation } from './gmail-evidence.ts';
import { CONTEXTUAL_GMAIL_BOUND_REPLY_TOOLS, CONTEXTUAL_GMAIL_PREFLIGHT_ATTESTATION_TTL_MS, CONTEXTUAL_GMAIL_PREFLIGHT_TOOLS, contextualGmailPreflightAttestations, contextualGmailPreflightGenerations, contextualGmailToolUseClaims, inFlightContextualGmailReplies, observedContextualGmailReads, pendingContextualGmailPreflights, reservedContextualGmailReplyAttestations } from './gmail-state.ts';

/** Promote only successful, host-observed Gmail read/preflight tool results. */
export function recordContextualGmailToolResult(input: {
  sessionId: string;
  toolUseId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  executed?: boolean;
  objectiveAuthorizationSegments?: readonly string[];
}): void {
  const { sessionId, toolUseId, toolName, toolInput, result } = input;
  if (!toolUseId || !toolName) return;
  const now = Date.now();
  for (const [key, pending] of pendingContextualGmailPreflights) {
    if (pending.expiresAt <= now) pendingContextualGmailPreflights.delete(key);
  }
  for (const [key, reserved] of reservedContextualGmailReplyAttestations) {
    if (reserved.expiresAt <= now) reservedContextualGmailReplyAttestations.delete(key);
  }
  const pendingKey = `${sessionId}:${toolUseId}`;
  const terminalPending = CONTEXTUAL_GMAIL_PREFLIGHT_TOOLS.has(toolName)
    ? pendingContextualGmailPreflights.get(pendingKey)
    : undefined;
  if (CONTEXTUAL_GMAIL_PREFLIGHT_TOOLS.has(toolName)) {
    // A preflight call has one terminal result. Failed, blocked and malformed
    // results must consume the pending intent just like successful receipts.
    pendingContextualGmailPreflights.delete(pendingKey);
  }
  const objectiveSegments = input.objectiveAuthorizationSegments ?? [];
  const objectiveFingerprint = contextualGmailObjectiveFingerprint(objectiveSegments);
  if (result && !input.isError && input.executed !== false) {
    const dependencies = hostObservedThirdPartyDependencies(toolName, result);
    const resolvedDependencies = hostObservedResolvedThirdPartyDependencies(toolName, result);
    if (dependencies.length > 0 || resolvedDependencies.length > 0) {
      const previous = observedThirdPartyDependencies.get(sessionId);
      const mergedByParty = new Map<string, Set<PendingDependencyKind>>();
      for (const dependency of previous && previous.expiresAt > Date.now()
          && previous.objectiveFingerprint === objectiveFingerprint
          ? previous.dependencies : []) {
        const kinds = mergedByParty.get(dependency.party) ?? new Set<PendingDependencyKind>();
        for (const kind of dependency.kinds) kinds.add(kind);
        mergedByParty.set(dependency.party, kinds);
      }
      for (const resolved of resolvedDependencies) {
        const kinds = mergedByParty.get(resolved.party);
        for (const kind of resolved.kinds) kinds?.delete(kind);
        if (kinds?.size === 0) mergedByParty.delete(resolved.party);
      }
      for (const dependency of dependencies) {
        const kinds = mergedByParty.get(dependency.party) ?? new Set<PendingDependencyKind>();
        for (const kind of dependency.kinds) kinds.add(kind);
        mergedByParty.set(dependency.party, kinds);
      }
      if (mergedByParty.size === 0) {
        observedThirdPartyDependencies.delete(sessionId);
      } else {
        observedThirdPartyDependencies.set(sessionId, {
          expiresAt: Date.now() + CONTEXTUAL_GMAIL_PREFLIGHT_ATTESTATION_TTL_MS,
          objectiveFingerprint,
          dependencies: [...mergedByParty].map(([party, kinds]) => ({ party, kinds })),
        });
      }

      const previousResolved = observedResolvedThirdPartyDependencies.get(sessionId);
      const resolvedByParty = new Map<string, Set<PendingDependencyKind>>();
      for (const dependency of previousResolved && previousResolved.expiresAt > Date.now()
          && previousResolved.objectiveFingerprint === objectiveFingerprint
          ? previousResolved.dependencies : []) {
        resolvedByParty.set(dependency.party, new Set(dependency.kinds));
      }
      for (const dependency of dependencies) {
        const kinds = resolvedByParty.get(dependency.party);
        for (const kind of dependency.kinds) kinds?.delete(kind);
        if (kinds?.size === 0) resolvedByParty.delete(dependency.party);
      }
      for (const dependency of resolvedDependencies) {
        const kinds = resolvedByParty.get(dependency.party) ?? new Set<PendingDependencyKind>();
        for (const kind of dependency.kinds) kinds.add(kind);
        resolvedByParty.set(dependency.party, kinds);
      }
      if (resolvedByParty.size === 0) {
        observedResolvedThirdPartyDependencies.delete(sessionId);
      } else {
        observedResolvedThirdPartyDependencies.set(sessionId, {
          expiresAt: Date.now() + CONTEXTUAL_GMAIL_PREFLIGHT_ATTESTATION_TTL_MS,
          objectiveFingerprint,
          dependencies: [...resolvedByParty].map(([party, kinds]) => ({ party, kinds })),
        });
      }
    }
  }
  if (CONTEXTUAL_GMAIL_BOUND_REPLY_TOOLS.has(toolName)) {
    const reservationKey = `${sessionId}:${toolUseId}`;
    const claim = contextualGmailToolUseClaims.get(reservationKey);
    const inFlight = inFlightContextualGmailReplies.get(sessionId);
    if (inFlight?.toolUseId === toolUseId) {
      // Runtime-correlated reservations are released only by their exact host
      // ticket or a confirmed teardown. A delayed terminal event carries no
      // runtime identity and therefore must never erase a newer runtime's
      // reservation that happens to reuse the same SDK tool id.
      if (inFlight.runtimeId !== undefined) {
        inFlight.possiblyExecuted ||= input.executed !== false;
        return;
      }
      // Once a host id collides, its terminal events are indistinguishable.
      // Never count or guess which occurrence completed: retain the poisoned
      // lock until runtime teardown, then require a fresh exact reconciliation.
      if (inFlight.poisoned || claim?.phase === 'poisoned') return;
      inFlight.possiblyExecuted ||= input.executed !== false;
      inFlightContextualGmailReplies.delete(sessionId);
    } else if (claim?.phase === 'poisoned') {
      return;
    }
    if (claim) claim.phase = 'terminal';
    const reserved = reservedContextualGmailReplyAttestations.get(reservationKey);
    reservedContextualGmailReplyAttestations.delete(reservationKey);
    const active = contextualGmailPreflightAttestations.get(sessionId);
    if (active && (active.expiresAt <= now
      || active.generation !== contextualGmailPreflightGenerations.get(sessionId))) {
      contextualGmailPreflightAttestations.delete(sessionId);
    }
    const definitelyNotExecuted = inFlight?.toolUseId === toolUseId
      ? !inFlight.possiblyExecuted
      : input.executed === false;
    if (reserved && definitelyNotExecuted
      && reserved.expiresAt > now
      && reserved.objectiveFingerprint === objectiveFingerprint
      && reserved.generation === contextualGmailPreflightGenerations.get(sessionId)
      && !contextualGmailPreflightAttestations.has(sessionId)) {
      contextualGmailPreflightAttestations.set(sessionId, reserved);
    }
    maybeFinalizeContextualGmailSessionCleanup(sessionId);
    return;
  }
  if (!result || input.isError || input.executed === false) return;
  const receipt = contextualGmailToolReceipt(result);
  if (!receipt) return;

  const observedMessageId = exactObservedGmailMessageId(toolName, toolInput, receipt);
  if (observedMessageId) {
    observedContextualGmailReads.set(sessionId, {
      expiresAt: Date.now() + CONTEXTUAL_GMAIL_PREFLIGHT_ATTESTATION_TTL_MS,
      messageId: observedMessageId,
      toolUseId,
      objectiveFingerprint,
    });
    const existing = contextualGmailPreflightAttestations.get(sessionId);
    if (existing && existing.value.messageId !== observedMessageId) {
      contextualGmailPreflightAttestations.delete(sessionId);
    }
    return;
  }

  if (!CONTEXTUAL_GMAIL_PREFLIGHT_TOOLS.has(toolName)) return;
  const preflightClaim = contextualGmailToolUseClaims.get(pendingKey);
  if (preflightClaim?.phase === 'poisoned') return;
  if (preflightClaim) preflightClaim.phase = 'terminal';
  const pending = terminalPending;
  if (!pending || pending.expiresAt <= Date.now()
    || pending.objectiveFingerprint !== objectiveFingerprint
    || pending.generation !== contextualGmailPreflightGenerations.get(sessionId)) return;
  const resultIntent = toolInput
    ? contextualGmailReplyPreflightAttestationFromObjective(
      toolName,
      toolInput,
      pending.policySegments,
    )
    : undefined;
  if (!resultIntent || !contextualGmailPreflightIntentsMatch(resultIntent, pending.intent)) return;
  const read = observedContextualGmailReads.get(sessionId);
  const matchingRead = read && read.expiresAt > Date.now()
    && read.objectiveFingerprint === objectiveFingerprint
    && read.messageId === pending.intent.messageId
    ? read
    : undefined;
  // The exact-effect preflight itself performs the target-bound
  // gmail_threads_get_full read. It can therefore supply the anchor evidence
  // only when the same authenticated human objective fully closes one
  // recipient-bound plain-text reply and names this exact message. Deictic or
  // partial objectives still require a distinct host-observed Gmail read.
  const exactHumanAnchor = contextualGmailObjectiveProvidesClosedExactHumanAnchor(
    pending.policySegments,
    pending.intent,
  );
  if (!matchingRead && !exactHumanAnchor) return;
  const binding = typeof receipt.recipientBinding === 'string'
    ? receipt.recipientBinding.trim().toLowerCase()
    : '';
  const resolved = receipt.resolvedRecipients && typeof receipt.resolvedRecipients === 'object'
    ? receipt.resolvedRecipients as Record<string, unknown>
    : undefined;
  const resolvedTo = Array.isArray(resolved?.to) ? resolved.to : [];
  const resolvedCc = Array.isArray(resolved?.cc) ? resolved.cc : [];
  const recipientsAreStrings = [...resolvedTo, ...resolvedCc]
    .every(value => typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value));
  const bodySha256 = createHash('sha256').update(pending.intent.body, 'utf8').digest('hex');
  const bindingExpiresAtMs = contextualGmailBindingExpiresAt(
    binding,
    receipt.bindingExpiresInSeconds,
    now,
  );
  const receiptMatches = receipt.ok === true
    && receipt.willSend === false
    && receipt.messageId === pending.intent.messageId
    && receipt.bodySha256 === bodySha256
    && receipt.isHtml === pending.intent.isHtml
    && (pending.intent.expectedSenderEmail === undefined
      ? receipt.expectedSenderEmail === undefined
        && (receipt.primarySenderEmail === undefined
          || typeof receipt.primarySenderEmail === 'string'
            && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(receipt.primarySenderEmail))
      : receipt.expectedSenderEmail === pending.intent.expectedSenderEmail
        && receipt.primarySenderEmail === pending.intent.expectedSenderEmail)
    && bindingExpiresAtMs !== undefined
    && recipientsAreStrings
    && resolvedTo.length + resolvedCc.length > 0
    && (pending.intent.expectedSubject === undefined
      || receipt.subject === pending.intent.expectedSubject)
    && (pending.intent.expectedCc === undefined
      || JSON.stringify([...resolvedCc].sort())
        === JSON.stringify(canonicalGmailEmailSet(pending.intent.expectedCc)))
    && (pending.intent.scope === 'reply-all'
      ? receipt.replyAll === true
      : receipt.replyAll === false
        && receipt.expectedRecipientEmail === pending.intent.expectedRecipientEmail
        && resolvedTo.length === 1
        && resolvedTo[0] === pending.intent.expectedRecipientEmail
        && resolvedCc.length === 0)
    && (!pending.intent.requiresExactEffectReconciliation
      || hasConclusiveContextualGmailExactEffectReconciliation(receipt));
  if (!receiptMatches || bindingExpiresAtMs === undefined) return;
  const anchorEvidence = matchingRead
    ? { anchorEvidence: 'gmail-read' as const, readToolUseId: matchingRead.toolUseId }
    : { anchorEvidence: 'exact-human-objective' as const };
  contextualGmailPreflightAttestations.set(sessionId, {
    expiresAt: bindingExpiresAtMs,
    generation: pending.generation,
    value: {
      ...pending.intent,
      recipientBinding: binding,
      bindingExpiresAtMs,
      preflightToolUseId: toolUseId,
      ...anchorEvidence,
    },
    objectiveFingerprint,
  });
}
