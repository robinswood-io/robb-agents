import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { parseStructuredGmailSendResumeSegment } from "@craft-agent/shared/agent";
import { isExplicitReadOnlyClosureRequest } from './closure-intent.ts';

export function objectiveAmendmentAuthorityText(text: string): string {
  // Amendments from an active SDK turn may include the host contract appended
  // after the user's text. Its defensive examples mention security, legal and
  // medical policy but are not part of the accepted human objective.
  let hostContractIndex = -1;
  for (const match of text.matchAll(/<host_objective_contract\b/giu)) {
    for (let index = match.index - 1; index >= 0 && /\s/u.test(text.charAt(index)); index--) {
      if (text[index] === '\n') hostContractIndex = index;
    }
    if (hostContractIndex >= 0) break;
  }
  const withoutHostContract = hostContractIndex >= 0 ? text.slice(0, hostContractIndex) : text;
  // A closed email body is quoted payload data. Questions, credential names or
  // action verbs inside it must not change objective risk, mutation authority or
  // evidence gates. Only the same fully authenticated structured Gmail envelope
  // accepted by the execution gate may receive that treatment; bare or malformed
  // BODY markers remain visible to policy classification (fail closed).
  if (!parseStructuredGmailSendResumeSegment(withoutHostContract)) return withoutHostContract;
  const beginnings = [...withoutHostContract.matchAll(/(?:^|\r?\n)BODY_BEGIN(?=\r?\n|$)/gu)];
  const endings = [...withoutHostContract.matchAll(/(?:^|\r?\n)BODY_END(?=\r?\n|$)/gu)];
  const begin = beginnings[0];
  const end = endings[0];
  if (beginnings.length !== 1 || endings.length !== 1 || !begin || !end) return withoutHostContract;
  const markerStart = begin.index + begin[0].length - 'BODY_BEGIN'.length;
  const afterMarker = begin.index + begin[0].length;
  const bodyStart = afterMarker + (withoutHostContract[afterMarker] === '\r' ? 2 : 1);
  if (bodyStart > end.index) return withoutHostContract;
  return withoutHostContract.slice(0, markerStart)
    + 'BODY_BEGIN\n[exact payload body omitted from objective policy classification]\nBODY_END'
    + withoutHostContract.slice(end.index + end[0].length);
}

/**
 * A terminal reconciliation is durable prompt context, not fresh authority.
 * Keep its constraints visible to the agent while excluding its quoted
 * receipts, payload and tool names from every authority/evidence projection.
 * Re-evaluate the text as well as the marker so the exclusion survives a
 * later ordinary continuation that no longer owns the current marker.
 */
export function objectiveAuthorityAmendments(objective: ActiveSessionObjective) {
  return (objective.amendments ?? []).filter(amendment => (
    amendment.messageId !== objective.terminalReconciliation?.messageId
      && !isExplicitReadOnlyClosureRequest(amendment.text)
  ));
}
