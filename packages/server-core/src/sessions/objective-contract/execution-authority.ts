import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { detectHighStakesEvidenceDomain } from "@craft-agent/shared/agent";
import { classifyObjectiveMutationRisk } from "@craft-agent/shared/config";
import { objectiveAmendmentAuthorityText, objectiveAuthorityAmendments } from './amendment-authority.ts';
import { hasNonAuthoritativeStructuredLead, matchesExecutionAuthorityRevocation } from './instruction-clause-syntax.ts';
import { ACCESS_GRANT_DECISION_PATTERN, ACTION_STATE_QUESTION_PATTERN, canonicalizeObjectiveArtifactMutations, isAnalyticalDecisionDiscussion } from './request-intent.ts';
import { foldForIntent } from './types.ts';

function awaitsFutureExecutionAuthority(candidate: string): boolean {
  if (/^(?:en\s+principe|in\s+principle)\b/u.test(candidate)) return true;
  const conditionalLead = /^(?:(?:seulement\s+|uniquement\s+|only\s+)?(?:si|if)\b|(?:des\s+que|des\s+obtention\b|une\s+fois(?:\s+que)?|as\s+soon\s+as|once)\b|(?:a\s+condition\s+(?:que|davoir)|sous\s+reserve\b|pourvu\s+que|provided\s+that|subject\s+to\b)|(?:(?:uniquement|seulement)\s+avec|only\s+with|pas\s+avant|not\s+before)\b|(?:a\s+reception\s+de|upon\s+receipt\s+of|pending\s+receipt\b)|(?:apres|en\s+attente\s+de|after|pending)\b|(?:quand|lorsque|when)\b)/u.test(candidate);
  if (!conditionalLead) return false;
  const directlyVerifiable = /^(?:(?:si|if)\s+(?:necessaire|needed)\b|(?:si|if)\s+cela\b[^.!?;]{0,40}\bdebloque\b|(?:si|if)\s+(?:tout\s+est\s+bon|everything\s+is\s+(?:ready|good|ok))\b)/u.test(candidate);
  const volitionalDecision = /\b(?:souhait\w*|veut|veulent|want\w*|demand\w*|request\w*|estim\w*|jug\w*|decid\w*|convien\w*|accord|aval|feu\s+vert|go[- ]?ahead|oppos\w*|objection)\b/u.test(candidate);
  const validationDecision = /\b(?:confirm\w*|valid\w*|appr(?:ouv|ob)\w*|autoris\w*|accept\w*)\b/u.test(candidate);
  const passiveValidator = /\b(?:est|sont|a\s+ete|ont\s+ete|is|are|was|were|has\s+been|have\s+been)\s+(?:confirm\w*|valid\w*|appr(?:ouv|ob)\w*)\s+(?:par|by)\s+(?:(?:le|la|les|the)\s+)?([^.!?;,]{1,60})/u.exec(candidate)?.[1];
  const passiveHumanValidator = passiveValidator !== undefined
    && !/^(?:pipeline|job|script|tests?|systeme|automatisation|ci|github\s+actions)\b/u.test(passiveValidator.trim());
  const validationAsObservableState = /\b(?:est|sont|a\s+ete|ont\s+ete|is|are|was|were|has\s+been|have\s+been)\s+(?:confirm\w*|valid\w*|appr(?:ouv|ob)\w*)\b/u.test(candidate);
  const explicitTechnicalValidator = /\bautomatiq\w*\b/u.test(candidate)
    || /\b(?:par|by)\s+(?:(?:le|la|les|the)\s+)?(?:pipeline|job|script|tests?|systeme|automatisation|ci|github\s+actions)\b/u.test(candidate)
    || /^(?:(?:si|if)\s+|(?:des\s+que|une\s+fois\s+que|as\s+soon\s+as|once|quand|lorsque|when)\s+)(?:(?:le|la|les|the)\s+)?(?:pipeline|job|script|tests?|systeme|automatisation|ci|github\s+actions)\s+(?:(?:a|has)\s+)?(?:confirm\w*|valid\w*|appr(?:ouv|ob)\w*)\b/u.test(candidate);
  const opinionActor = /^(?:(?:si|if)\s+|(?:des\s+que|une\s+fois\s+que|as\s+soon\s+as|once|quand|lorsque|when)\s+)(?:(?:le|la|les|the)\s+)?([^.!?;,]{1,60}?)\s+(?:dit|says?|repond|responds?|trouve|finds?|considere|considers?)\b/u.exec(candidate)?.[1];
  const humanOpinion = opinionActor !== undefined
    && !/^(?:pipeline|job|script|tests?|systeme|automatisation|ci|github\s+actions|service|[ld]?api|endpoint)\b/u.test(opinionActor.trim());
  // Confirmation/validation verbs are human authority by default, regardless
  // of a person's name or role. Only an explicit automated technical actor can
  // turn them into an observable condition.
  if (volitionalDecision || humanOpinion || passiveHumanValidator
    || validationDecision && !validationAsObservableState && !explicitTechnicalValidator) return true;
  const technicalSubject = /\b(?:script|tests?|controle|verification|build|job|pipeline|ci|github\s+actions|service|[ld]?api|endpoint|chemins?|fichier|dossier|permissions?|configuration|procedure|revision|version|hash|checksum|certificat|commit|branche|conteneur|route|ports?|reponse\s+http|deploiement|synchronisation|migration|processus|systeme|automatisation)\b/u.test(candidate);
  const observableTechnicalState = /\b(?:automatiq\w*|fini\w*|termin\w*|reussi\w*|passe\w*|vert|green|ok|bon|ready|correct\w*|valid\w*|appr(?:ouv|ob)\w*|execut\w*|deploy\w*|disponible|actif|sain|ouvert\w*|accessibl\w*|conform\w*|contien\w*|vaut|retourn\w*|repond\w*|correspond\w*|existe\w*|absent\w*)\b/u.test(candidate);
  // A conditional access sentence is not immediate execution authority unless
  // its condition is explicitly host-verifiable. Unknown or human conditions
  // remain non-authoritative without trying to enumerate every way to say yes.
  return !(directlyVerifiable || technicalSubject && observableTechnicalState);
}

export function accessGrantDecisionDisposition(
  text: string,
): 'affirmative' | 'non_authoritative' | undefined {
  const containsAccessDecisionLine = text.split(/\r?\n/u)
    .some(line => ACCESS_GRANT_DECISION_PATTERN.test(foldForIntent(line.trim())));
  if (containsAccessDecisionLine && (
    hasNonAuthoritativeStructuredLead(text)
    || /```[\s\S]*?```/u.test(text)
    || /^\s*>/mu.test(text)
  )) return 'non_authoritative';

  const clauses = text.match(/[^.!?;\n]+[.!?;]?/gu) ?? [];
  let sawAffirmativeDecision = false;
  for (const [clauseIndex, rawClause] of clauses.entries()) {
    const clause = foldForIntent(rawClause);
    const decision = ACCESS_GRANT_DECISION_PATTERN.exec(clause);
    if (decision) {
      const tail = clause.slice(decision[0].length).trim();
      const normalizedTail = tail
        .replace(/^[,\s]+/u, '')
        .replace(/^(?:mais|toutefois|cependant|pourtant|but|however)\s+/u, '')
        .trim();
      const confirmationTail = normalizedTail.replace(/-/gu, ' ');
      const asksForConfirmation = /\?\s*$/u.test(rawClause)
        || /\b(?:nest[- ]ce pas|ou pas|non|right|cest bien ca|c est bien ca)\s*[.!]?\s*$/u.test(clause)
        || /\b(?:ou bien\s+)?(?:faut[- ]il|doit[- ]on|devons[- ]nous|est[- ]ce)\b/u.test(tail)
        || /^(?:(?:tu|vous)\s+confirm\w*|confirm\w*\s+moi|(?:tu|vous)\s+(?:en\s+)?(?:es|etes)\s+sur(?:e|s|es)?|vraiment|daccord|on\s+est\s+daccord|correct|certain(?:e|s|es)?|sure|really|agreed|right)\s*[.!]?$/u.test(confirmationTail);
      const awaitsFutureAuthority = awaitsFutureExecutionAuthority(normalizedTail);
      const revokesExecution = matchesExecutionAuthorityRevocation(normalizedTail)
        || /\b(?:mais|but|however)\s+(?:(?:ne|n)\s+)?(?:le\s+)?(?:fais|faites|faire|execute|executez|executer|ouvre|ouvrez|ouvrir)\b[^.!?;]{0,60}\b(?:pas|plus|jamais)\b/u.test(tail)
        || /\b(?:sans|without)\s+(?:(?:le|l)\s+)?(?:faire|executer|ouvrir|doing|executing|opening)\b/u.test(tail);
      const priorRevokesExecution = clauses.slice(0, clauseIndex).some(priorRawClause => {
        const priorClause = foldForIntent(priorRawClause).replace(/-/gu, ' ').trim();
        return matchesExecutionAuthorityRevocation(priorClause)
          || /^(?:(?:analyse|analysez|analyze|review)\b[^.!?;]{0,100}\b(?:seulement|uniquement|only)|(?:analyse|analysez|analyze|review)\b[^.!?;]{0,100}\b(?:sans\s+agir|without\s+acting))\b/u.test(priorClause)
          || /^(?:ne\s+(?:fais|faites|faire|effectue|effectuez|execut(?:e|ez|er))\b[^.!?;]{0,50}\b(?:aucune|rien)|(?:do\s+not|dont)\s+(?:change|modify|write|execute)\s+anything)\b/u.test(priorClause)
          || /^(?:nouvre|ne\s+ouvre)\b[^.!?;]{0,60}\b(?:rien|pas|plus|jamais)\b/u.test(priorClause);
      });
      if (asksForConfirmation || awaitsFutureAuthority || revokesExecution || priorRevokesExecution) return 'non_authoritative';
      sawAffirmativeDecision = true;
      continue;
    }
    if (sawAffirmativeDecision) {
      const laterClause = clause
        .replace(/-/gu, ' ')
        .replace(/^(?:mais|toutefois|cependant|pourtant|but|however)\s+/u, '')
        .trim();
      const normalizedLaterConfirmation = laterClause.replace(/-/gu, ' ');
      const laterQuestion = (
        /\?\s*$/u.test(rawClause) && (
          /\b(?:faire|ouvrir|acces|droits?|attendre|confirm\w*|recommand\w*)\b/u.test(laterClause)
            && /^(?:(?:faut il|doit on|devons nous|est ce|cest ce)\b|(?:peux tu|pouvez vous|tu|vous)\b[^.!?;]{0,60}\bconfirm\w*)/u.test(laterClause)
          || /^(?:(?:tu|vous)\s+(?:en\s+)?(?:es|etes)\s+sur(?:e|s|es)?|vraiment|daccord|on\s+est\s+daccord|correct|certain(?:e|s|es)?|sure|really|agreed|right)$/u.test(laterClause)
        )) || /^(?:(?:tu|vous)\s+confirm\w*|confirm\w*\s+moi|(?:tu|vous)\s+(?:en\s+)?(?:es|etes)\s+sur(?:e|s|es)?|vraiment|daccord|on\s+est\s+daccord|correct|certain(?:e|s|es)?|sure|really|agreed|right)\s*[.!]?$/u.test(normalizedLaterConfirmation);
      const laterRevocation = matchesExecutionAuthorityRevocation(laterClause)
        || /^(?:ne\s+le\s+fais|nouvre|ne\s+ouvre|ne\s+louvre)\b[^.!?;]{0,60}\b(?:pas|plus|jamais|rien)\b/u.test(laterClause);
      if (laterQuestion || awaitsFutureExecutionAuthority(laterClause) || laterRevocation) {
        return 'non_authoritative';
      }
    }
  }
  return sawAffirmativeDecision ? 'affirmative' : undefined;
}

export function independentNonAccessMutationRequested(text: string): boolean {
  const clauses = text.match(/[^.!?;\n]+[.!?;]?/gu) ?? [];
  return clauses.some(rawClause => {
    if (ACCESS_GRANT_DECISION_PATTERN.test(foldForIntent(rawClause))) return false;
    const canonicalClause = canonicalizeObjectiveArtifactMutations(rawClause.trim());
    return canonicalClause.length > 0 && classifyObjectiveMutationRisk(canonicalClause, {
      authorityText: canonicalClause,
    }).mutationRequested;
  });
}

export function classifyObjectiveRequest(text: string, riskContext?: string) {
  // Questions about whether an existing change still applies are observations,
  // even though generic routing vocabulary also contains "apply"/"correct".
  // Consume the whole question so appended instructions retain normal parsing.
  const canonicalAuthority = ACTION_STATE_QUESTION_PATTERN.test(text.trim())
    ? 'Inspect whether the referenced change is still applicable.'
    : canonicalizeObjectiveArtifactMutations(text);
  const contextualText = riskContext?.trim()
    ? `${canonicalAuthority}\n${riskContext}`
    : canonicalAuthority;
  const classification = classifyObjectiveMutationRisk(contextualText, { authorityText: canonicalAuthority });
  // Access-authority punctuation and confirmation wording must be interpreted
  // from the authenticated human text. Artifact canonicalization deliberately
  // maps English `correct` to `create`, which would otherwise turn the
  // conversational tail "correct." into a mutation command.
  const accessGrantDecision = accessGrantDecisionDisposition(text);
  if (accessGrantDecision !== undefined) {
    return {
      ...classification,
      mutationRequested: accessGrantDecision === 'affirmative'
        || independentNonAccessMutationRequested(text),
    };
  }
  return isAnalyticalDecisionDiscussion(canonicalAuthority)
    ? { ...classification, mutationRequested: false }
    : classification;
}

/** Resolve only the evidence subject of an authoritative mutation. Domain
 * words alone (for example in a negated/read-only amendment) cannot replace a
 * persisted gate, while the host classifier's full mutation vocabulary covers
 * fix/rotate/configure and other verbs beyond the legacy evidence parser. */
export function classifyAuthorizedObjectiveEvidenceDomain(text: string) {
  return classifyObjectiveRequest(text).mutationRequested
    ? detectHighStakesEvidenceDomain(text)
    : undefined;
}

export function boundedObjectiveRiskText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const headChars = Math.floor(maxChars / 2);
  return `${text.slice(0, headChars)}\n${text.slice(-(maxChars - headChars))}`;
}

export function objectiveRiskContext(objective: ActiveSessionObjective): string {
  const root = boundedObjectiveRiskText(objectiveAmendmentAuthorityText(objective.originalText ?? ''), 8_192);
  const amendments = objectiveAuthorityAmendments(objective);
  const latestSensitiveId = [...amendments].reverse().find(amendment => (
    classifyObjectiveRequest(objectiveAmendmentAuthorityText(amendment.text)).sensitiveDomain
  ))?.messageId;
  const retainedAmendments = amendments.filter((amendment, index) => (
    index >= amendments.length - 4 || amendment.messageId === latestSensitiveId
  )).map(amendment => boundedObjectiveRiskText(objectiveAmendmentAuthorityText(amendment.text), 2_048));
  return [root, ...retainedAmendments].filter(Boolean).join('\n');
}

export function isObjectiveMutationRequested(text: string): boolean {
  return classifyObjectiveRequest(text).mutationRequested;
}
