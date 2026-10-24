import type { AutonomyEvent, Message } from "@craft-agent/core/types";
import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { isObjectiveToolExecutedSuccessfully } from "../objective-contract.ts";
import { isStructuredAuthenticationReceiptTool, matchingAuthenticationPoll, structuredAuthenticationPollBlocker, structuredAuthenticationStartReceipt, structuredAuthenticationSurface, structuredAuthenticationToolName, successfulAuthenticationPollReceipt } from './authentication.ts';
import type { CurrentObjectiveBlockerObservation } from './blocker-identities.ts';
import { blockerKindsForFailureSignal, failureBlockerKinds, sameToolRequest, toolAliasDescriptor } from './blocker-identities.ts';
import type { ObjectiveBlockerKind } from './declaration.ts';
import { messagesForObjective, normalizedToolName } from './declaration.ts';
import { gmailNegativeSearchBoundToObjective } from './gmail-negative-search.ts';

/**
 * Some connectors return a successful transport receipt whose business result
 * is explicitly pending/negative (for example an OAuth device-code poll).
 * Browser snapshots can likewise prove that a credential form is currently
 * blocking progress. Admit only bounded, machine-shaped negatives or an exact
 * interactive authentication surface; arbitrary successful prose is never a
 * blocker.
 */
function completedToolBlockerKinds(
  message: Message, objective?: ActiveSessionObjective, messages: readonly Message[] = [],
): ObjectiveBlockerKind[] {
  if (!isObjectiveToolExecutedSuccessfully(message) || !message.toolResult) return [];
  const text = message.toolResult.trim();
  if (!text) return [];

  if (objective && gmailNegativeSearchBoundToObjective(message, objective, messages)) {
    return ['external_authorization'];
  }

  if (isStructuredAuthenticationReceiptTool(message.toolName)) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const value = parsed as Record<string, unknown>;
        const toolName = structuredAuthenticationToolName(message.toolName);
        const pollOperation = !!toolName
          && /(?:^|_)(?:poll|status|check|wait|receipt)(?:_|$)/i.test(toolName.operation);
        // Poll blockers use a strict machine-state parser and a non-empty flow
        // binding. Generic failure-text classification must never admit or
        // retire an auth poll independently of that binding.
        if (pollOperation) return structuredAuthenticationPollBlocker(message)
          ? ['external_authorization']
          : [];
        const explicitlyNegative = value.pending === true || value.ok === false || value.success === false;
        const rawCode = [value.code, value.error, value.status]
          .find((candidate): candidate is string => typeof candidate === 'string' && candidate.length <= 256);
        const rawMessage = [value.message, value.error, value.code]
          .filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length <= 4_096)
          .join(' ');
        if (explicitlyNegative && rawMessage) {
          const classified = blockerKindsForFailureSignal(message, rawMessage, rawCode);
          if (classified.length > 0) return classified;
        }
        if (value.pending === true) return ['external_authorization'];
        // A device-code/auth start can succeed at the transport layer while
        // explicitly handing the next step to a human. Require a strict,
        // machine-shaped receipt from an allowlisted connector operation so a
        // generic successful JSON object or arbitrary prose cannot become a
        // blocker.
        if (structuredAuthenticationStartReceipt(message)) return ['external_authorization'];
      }
    } catch { /* A browser observation is intentionally plain text. */ }
  }

  if (!/(?:^|_)browser_tool$/i.test(normalizedToolName(message.toolName))) return [];
  const folded = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const authenticationSurface = structuredAuthenticationSurface(text);
  if (!authenticationSurface) return [];
  const accountChooser = /\[button\]/.test(folded)
    && /\[(?:heading|list)\]/.test(folded)
    && /\b(?:choisir|selectionner|select|choose|pick)\s+(?:un |an )?(?:compte|account)\b/.test(folded)
    && /\b(?:utiliser un autre compte|use another account|se connecter avec le compte|sign in with (?:the )?account)\b/.test(folded);
  if (accountChooser) return ['credential'];
  if (!/\[(?:textbox|input)\]/.test(folded)) return [];
  if (/\b(?:mfa|2fa|two[- ]factor|deux\s+facteurs|verification code|code de verification)\b/.test(folded)) {
    return ['mfa'];
  }
  if (/password|mot de passe/.test(folded)) return ['credential'];
  return [];
}

function objectiveBlockerKinds(
  message: Message, objective?: ActiveSessionObjective, messages: readonly Message[] = [],
): ObjectiveBlockerKind[] {
  return message.isError || message.toolStatus === 'error'
    ? failureBlockerKinds(message)
    : completedToolBlockerKinds(message, objective, messages);
}

function matchingAuthResolved(
  scoped: readonly Message[], failure: Message, failureIndex: number, success: Message, successIndex: number,
): boolean {
  if (!failure.authRequestId) return true;
  if (success.authRequestId === failure.authRequestId) return true;
  return scoped.slice(failureIndex + 1, successIndex + 1).some(message => (
    message.role === 'auth-request'
    && message.authRequestId === failure.authRequestId
    && message.authStatus === 'completed'
  ));
}

/**
 * Host-observed blockers that are still current. A later success retires a
 * tool failure only when its native/exact tool identity and complete request
 * match; an auth-bound failure additionally needs the same resolved auth.
 */
export function currentObjectiveBlockerObservations(
  messages: readonly Message[], objective: ActiveSessionObjective,
): CurrentObjectiveBlockerObservation[] {
  const scoped = messagesForObjective([...messages], objective.userMessageId);
  const observations: CurrentObjectiveBlockerObservation[] = [];
  for (const [index, message] of scoped.entries()) {
    // A real follow-up from the user re-opens the objective and asks the host
    // to reassess its environment. A tool/auth failure observed before that
    // boundary is historical evidence, not proof that the blocker still
    // exists. Hidden recovery prompts do not retire anything: only a new,
    // authenticated user turn forces the fresh observation.
    const supersededByUserTurn = scoped.slice(index + 1).some(candidate => (
      candidate.role === 'user' && !candidate.hidden && !candidate.internalOrigin
    ));
    if (supersededByUserTurn) continue;
    if (message.role === 'auth-request' && message.authStatus === 'pending') {
      const stillPending = !message.authRequestId || !scoped.slice(index + 1).some(candidate => (
        candidate.role === 'auth-request'
        && candidate.authRequestId === message.authRequestId
        && candidate.authStatus !== 'pending'
      ));
      if (stillPending) {
        observations.push({ kind: 'credential', message, messageIndex: index });
        if (/\b(?:mfa|2fa|two[- ]factor|deux\s+facteurs)\b/i.test(message.content)) {
          observations.push({ kind: 'mfa', message, messageIndex: index });
        }
      }
      continue;
    }
    if (message.role !== 'tool') continue;
    const kinds = objectiveBlockerKinds(message, objective, messages);
    if (!kinds.length) continue;
    const authStart = structuredAuthenticationStartReceipt(message);
    const authPollBlocker = authStart ? undefined : structuredAuthenticationPollBlocker(message);
    if (authStart && Date.now() >= authStart.expiresAtMs) continue;
    const resolved = scoped.slice(index + 1).some((candidate, offset) => {
      const candidateIndex = index + 1 + offset;
      const pollReceipt = authStart || authPollBlocker
        ? successfulAuthenticationPollReceipt(candidate)
        : undefined;
      const matchingSuccess = authStart
        ? pollReceipt !== undefined && matchingAuthenticationPoll(authStart, candidate, pollReceipt)
        : authPollBlocker
          ? pollReceipt !== undefined && matchingAuthenticationPoll(authPollBlocker, candidate, pollReceipt)
          : isObjectiveToolExecutedSuccessfully(candidate)
            && objectiveBlockerKinds(candidate, objective, messages).length === 0
            && sameToolRequest(message, candidate);
      return matchingSuccess
        && matchingAuthResolved(scoped, message, index, candidate, candidateIndex);
    });
    if (!resolved) {
      observations.push(...kinds.map(kind => ({ kind, message, messageIndex: index })));
    }
  }
  return observations;
}

export function currentAutonomyBlockerEvents(
  events: readonly AutonomyEvent[], objective: ActiveSessionObjective, messages: readonly Message[],
): AutonomyEvent[] {
  const scoped = events.filter(event => event.timestamp >= objective.startedAt);
  return scoped.filter((event, index) => {
    if (event.phase !== 'escalated' || !event.escalationReason) return false;
    if (event.escalationReason === 'business_decision_required') {
      // A subsequent real user turn may carry the missing decision. Require
      // the host to reassess rather than treating the historical event as a
      // durable terminal blocker receipt.
      return !messages.some(message => message.role === 'user'
        && message.id !== objective.userMessageId && message.timestamp >= event.timestamp
        && !message.hidden && !message.internalOrigin);
    }
    if (!event.toolName) return true;
    const toolKey = toolAliasDescriptor(event.toolName).key;
    return !scoped.slice(index + 1).some(candidate => candidate.phase === 'verified'
      && !!candidate.toolName && toolAliasDescriptor(candidate.toolName).key === toolKey);
  });
}

export function addAutonomyBlockerRefs(
  blockers: Record<ObjectiveBlockerKind, Set<string>>,
  currentEvents: readonly AutonomyEvent[],
): void {
  for (const event of currentEvents) {
    // Tool/auth escalation events lack the persisted target/request/auth
    // identity needed to prove that a blocker is still current. They remain a
    // conservative completion gate below, but cannot be cited as terminal
    // blocker evidence. A business decision is host-owned and stays current
    // only until the next real user turn.
    if (event.escalationReason === 'business_decision_required') blockers.business_decision.add(event.id);
  }
}
