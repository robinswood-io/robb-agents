import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { parseStructuredGmailSendResumeSegment } from "@craft-agent/shared/agent";
import { isExplicitReadOnlyClosureRequest } from './closure-intent.ts';

export function objectiveAmendmentAuthorityText(text: string): string {
  // Amendments from an active SDK turn may include the host contract appended
  // after the user's text. Its defensive examples mention security, legal and
  // medical policy but are not part of the accepted human objective.
  const hostContractIndex = text.search(/\n\s*<host_objective_contract\b/iu);
  const withoutHostContract = hostContractIndex >= 0 ? text.slice(0, hostContractIndex) : text;
  // A closed email body is quoted payload data. Questions, credential names or
  // action verbs inside it must not change objective risk, mutation authority or
  // evidence gates. Only the same fully authenticated structured Gmail envelope
  // accepted by the execution gate may receive that treatment; bare or malformed
  // BODY markers remain visible to policy classification (fail closed).
  if (!parseStructuredGmailSendResumeSegment(withoutHostContract)) return withoutHostContract;
  const beginCount = withoutHostContract.match(/(?:^|\r?\n)BODY_BEGIN(?=\r?\n|$)/gu)?.length ?? 0;
  const endCount = withoutHostContract.match(/(?:^|\r?\n)BODY_END(?=\r?\n|$)/gu)?.length ?? 0;
  if (beginCount !== 1 || endCount !== 1) return withoutHostContract;
  const block = /(^|\r?\n)BODY_BEGIN\r?\n[\s\S]*?\r?\nBODY_END(?=\r?\n|$)/u;
  if (!block.test(withoutHostContract)) return withoutHostContract;
  return withoutHostContract.replace(
    block,
    '$1BODY_BEGIN\n[exact payload body omitted from objective policy classification]\nBODY_END',
  );
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
