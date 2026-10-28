import type { Message } from "@craft-agent/core/types";
import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { isObjectiveToolExecutedSuccessfully, findObjectiveText } from "../objective-contract.ts";
import { gmailIdentityTerms, messagesForObjective } from './declaration.ts';

function identityAnagram(value: string): string | undefined {
  return /^[a-z]{6,32}$/.test(value) ? [...value].sort().join('') : undefined;
}

/** Terms that are structurally identity-like, rather than ordinary subject
 * vocabulary: an email/domain label or an all-caps/camel-case brand. */
function gmailExplicitIdentityTerms(value: string): Set<string> {
  const result = new Set<string>();
  const addTerms = (candidate: string) => {
    for (const term of gmailIdentityTerms(candidate)) result.add(term);
  };
  for (const match of value.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:[A-Z0-9-]+\.)+[A-Z]{2,}/gi)) {
    addTerms(match[0]);
  }
  for (const match of value.matchAll(/\b(?:[A-ZÀ-ÖØ-Þ]{4,}|[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ0-9]+[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ0-9]*)\b/g)) {
    addTerms(match[0]);
  }
  return result;
}

/**
 * Bind a negative inbox observation only through a stable identity. Generic
 * workflow words ("production", "status", "access", …) are deliberately not
 * identities. Two distinctive terms are enough for a subject phrase; a single
 * exact brand/domain token (or a long brand/domain anagram such as
 * AGIRIS/isagri) is also sufficient.
 */
function stronglyMatchingGmailIdentity(leftText: string, rightText: string): boolean {
  const left = gmailIdentityTerms(leftText);
  const right = gmailIdentityTerms(rightText);
  const leftExplicit = gmailExplicitIdentityTerms(leftText);
  const rightExplicit = gmailExplicitIdentityTerms(rightText);
  const exact = [...left].filter(value => right.has(value));
  if (exact.length >= 2 || exact.some(value => value.length >= 6
    && (leftExplicit.has(value) || rightExplicit.has(value)))) return true;
  return [...left].some(value => {
    const fingerprint = identityAnagram(value);
    if (!fingerprint) return false;
    return [...right].some(candidate => identityAnagram(candidate) === fingerprint
      && (leftExplicit.has(value) || rightExplicit.has(candidate)));
  });
}

function gmailTargetInputText(message: Message): string {
  const input = message.toolInput ?? {};
  return [input["to"], input["cc"], input["bcc"], input["subject"], input["body"],
    input["expectedTo"], input["expectedCc"], input["expectedSubject"]]
    .filter((value): value is string => typeof value === 'string' && value.length <= 16_000)
    .join('\n');
}

export function gmailNegativeSearchBoundToObjective(
  message: Message, objective: ActiveSessionObjective, messages: readonly Message[],
): boolean {
  if (message.toolName !== 'mcp__google-contacts__gmail_search_exact') return false;
  const query = message.toolInput?.["query"];
  if (typeof query !== 'string' || query.length === 0 || query.length > 2_048
    || message.toolResult?.trim() !== `Aucun message Gmail trouvé pour : « ${query} »`) return false;
  const objectiveText = [
    findObjectiveText([...messages], objective) ?? '',
    ...(objective.amendments ?? []).map(amendment => amendment.text),
  ].join('\n');
  if (stronglyMatchingGmailIdentity(query, objectiveText)) return true;

  // A public brand in the objective can differ from its recipient domain.
  // Preserve that legitimate binding without trusting `_intent`: a prior
  // successful Gmail send in this objective must bridge objective terms and
  // exact search-target terms. Historical sends are outside the scope.
  const priorMessages = messagesForObjective([...messages], objective.userMessageId);
  const searchIndex = priorMessages.findIndex(candidate => candidate === message || candidate.id === message.id);
  return searchIndex > 0 && priorMessages.slice(0, searchIndex).some(candidate => {
    if (candidate.role !== 'tool' || !isObjectiveToolExecutedSuccessfully(candidate)
      || !/^mcp__google-contacts__gmail_(?:send|verify_sent_message)$/.test(candidate.toolName ?? '')) {
      return false;
    }
    const priorTarget = gmailTargetInputText(candidate);
    return stronglyMatchingGmailIdentity(priorTarget, objectiveText)
      && stronglyMatchingGmailIdentity(priorTarget, query);
  });
}
