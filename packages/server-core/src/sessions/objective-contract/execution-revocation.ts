import { amendmentEvidenceRequests, independentInstructionClauses, withoutClauseConnector } from './amendment-intent.ts';
import { hasBoundedQuestionAnswerEnvelope } from './closure-intent.ts';
import { accessGrantDecisionDisposition, independentNonAccessMutationRequested, isObjectiveMutationRequested } from './execution-authority.ts';
import { hasNonAuthoritativeStructuredLead, matchesExecutionAuthorityRevocation } from './instruction-clause-syntax.ts';
import { isAnalyticalDecisionDiscussion } from './request-intent.ts';
import { foldForIntent } from './types.ts';

/** A comma is an instruction boundary only for the two authority transitions
 * we can prove locally: an explicit revocation followed by a direct request,
 * or any prior clause followed by an explicit revocation. Treating every comma
 * as a boundary turns examples, reported speech and analysis into authority. */
export function boundedInstructionClauses(
  text: string,
  delegatedRole?: 'worker' | 'reviewer',
): string[] {
  const clauses = independentInstructionClauses(text);
  const lastClause = clauses.at(-1);
  if (!lastClause?.includes(',')) return clauses;
  const comma = lastClause.lastIndexOf(',');
  const prefix = lastClause.slice(0, comma).trim();
  const rawTail = lastClause.slice(comma + 1).trim();
  const tail = withoutClauseConnector(rawTail);
  if (!prefix || !tail) return clauses;
  const normalizedPrefix = foldForIntent(prefix).replace(/-/g, ' ').replace(/\s+/g, ' ');
  const normalizedTail = foldForIntent(tail).replace(/-/g, ' ').replace(/\s+/g, ' ');
  const explicitTailTransition = /^(?:finalement|mais|puis|ensuite|but|finally|then)\b/iu.test(rawTail);
  const nonAuthoritativePrefix = /^(?:(?:le\s+)?(?:rapport|report|document|texte|text|message)\s+(?:dit|says?|indique|mentions?|cite)|exemple|example|citation|quote|sujet|subject|la\s+phrase\s+est)\b/.test(normalizedPrefix)
    || isAnalyticalDecisionDiscussion(prefix);
  // A short, closed conversational lead-in can introduce a direct stop after
  // a comma. Do not generalize this to arbitrary prose: that would let a
  // report, example or analysis revoke (or grant) persisted authority.
  const directRevocationLead = /^(?:finalement|non|ok|daccord|bon|s(?:il|il)\s+te\s+plait|sil\s+vous\s+plait|maintenant|en\s+fait|oui|attends)$/.test(normalizedPrefix);
  const tailRevokes = (explicitTailTransition || directRevocationLead) && !nonAuthoritativePrefix
    && matchesExecutionAuthorityRevocation(normalizedTail);
  const revokedThenDirectRequest = matchesExecutionAuthorityRevocation(normalizedPrefix)
    && amendmentEvidenceRequests(tail, delegatedRole).execution;
  if (!tailRevokes && !revokedThenDirectRequest) return clauses;
  return [...clauses.slice(0, -1), prefix, tail];
}

export function latestClauseRequestsExecution(
  text: string,
  delegatedRole?: 'worker' | 'reviewer',
): boolean {
  if (hasNonAuthoritativeStructuredLead(text)) return false;
  if (accessGrantDecisionDisposition(text) === 'non_authoritative'
    && !independentNonAccessMutationRequested(text)) return false;
  const clauses = boundedInstructionClauses(text, delegatedRole);
  if (clauses.length < 2) return false;
  const prior = foldForIntent(withoutClauseConnector(clauses.at(-2)!))
    .replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  return matchesExecutionAuthorityRevocation(prior)
    && amendmentEvidenceRequests(withoutClauseConnector(clauses.at(-1)!), delegatedRole).execution;
}

/** A direct human amendment can revoke inherited mutation authority without
 * discarding the objective, so a later explicit correction can resume it.
 * Keep this deliberately narrow: reported speech and ordinary status updates
 * do not change authority, while a mixed instruction with a new positive
 * mutation is resolved by that positive instruction in the caller. */
export function explicitlyRevokesExecutionAuthority(text: string): boolean {
  if (hasNonAuthoritativeStructuredLead(text)) return false;
  // The terminal "no external action / no file / no other task" clause of a
  // fully bounded question/answer exchange scopes that conversational check;
  // it is not a global revocation of an already active objective. Keep this
  // structural: an ordinary standalone prohibition must still revoke, while
  // extra work inserted into the exchange remains visible to the normal
  // mutation classifier instead of being erased by the contradictory limit.
  if (hasBoundedQuestionAnswerEnvelope(text)) return false;
  const normalized = foldForIntent(text).replace(/-/g, ' ').replace(/\s+/g, ' ');
  const independentClauses = boundedInstructionClauses(text);
  if (accessGrantDecisionDisposition(text) === 'non_authoritative'
    && !independentNonAccessMutationRequested(text)) {
    const revokedBeforeAccess = independentClauses.some(rawClause => {
      const clause = foldForIntent(withoutClauseConnector(rawClause))
        .replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
      return matchesExecutionAuthorityRevocation(clause)
        || /^(?:(?:analyse|analysez|analyze|review)\b[^.!?;]{0,100}\b(?:seulement|uniquement|only)|(?:analyse|analysez|analyze|review)\b[^.!?;]{0,100}\b(?:sans\s+agir|without\s+acting))\b/u.test(clause)
        || /^(?:ne\s+(?:fais|faites|faire|effectue|effectuez|execut(?:e|ez|er))\b[^.!?;]{0,50}\b(?:aucune|rien)|(?:do\s+not|dont)\s+(?:change|modify|write|execute)\s+anything)\b/u.test(clause)
        || /^(?:nouvre|ne\s+ouvre)\b[^.!?;]{0,60}\b(?:rien|pas|plus|jamais)\b/u.test(clause);
    });
    if (revokedBeforeAccess) return true;
  }
  const lastIndependentClause = independentClauses.at(-1);
  if (independentClauses.length > 1 && lastIndependentClause
    && amendmentEvidenceRequests(withoutClauseConnector(lastIndependentClause)).execution
    && !matchesExecutionAuthorityRevocation(
      foldForIntent(withoutClauseConnector(lastIndependentClause)).replace(/-/g, ' ').replace(/\s+/g, ' '),
    )) return false;
  const normalizedLastClause = lastIndependentClause
    ? foldForIntent(withoutClauseConnector(lastIndependentClause)).replace(/-/g, ' ').replace(/\s+/g, ' ').trim()
    : undefined;
  const revoked = matchesExecutionAuthorityRevocation(normalized)
    || !!normalizedLastClause && matchesExecutionAuthorityRevocation(normalizedLastClause);
  if (!revoked) return false;
  const positiveTail = /\b(?:mais|puis|ensuite|but|then)\s+(.+)$/.exec(normalized)?.[1];
  return !positiveTail || !isObjectiveMutationRequested(positiveTail);
}
