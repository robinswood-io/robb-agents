import { NON_AUTHORIZING_INFORMATION_PREFIX, NON_AUTHORIZING_QUESTION_PREFIX, normalizeForMatch } from './target-syntax.ts';
import type { SensitiveConditionalTargetKind, SensitiveExternalAction } from './types.ts';

export function containsPhrase(normalizedText: string, phrase: string): boolean {
  const normalizedPhrase = normalizeForMatch(phrase);
  return normalizedPhrase.length > 0 && ` ${normalizedText} `.includes(` ${normalizedPhrase} `);
}

export function containsNonNegatedPhrase(normalizedText: string, phrase: string): boolean {
  const phraseTokens = normalizeForMatch(phrase).split(' ').filter(Boolean);
  const textTokens = normalizedText.split(' ').filter(Boolean);
  if (phraseTokens.length === 0 || textTokens.length < phraseTokens.length) return false;
  for (let index = 0; index <= textTokens.length - phraseTokens.length; index += 1) {
    if (!phraseTokens.every((token, offset) => textTokens[index + offset] === token)) continue;
    const before = textTokens.slice(Math.max(0, index - 4), index);
    const after = textTokens.slice(index + phraseTokens.length, index + phraseTokens.length + 3);
    const beforeText = before.join(' ');
    const directlyNegated = /(?:^|\s)(?:aucun|aucune|jamais|never|no|not|pas|pas de|sans(?: (?:aucun|aucune|un|une))?|without(?: (?:a|any))?)$/.test(beforeText)
      || before.slice(-2).join(' ') === 'don t';
    const frenchWrappedNegation = before.some(token => token === 'ne' || token === 'n')
      && after.some(token => ['jamais', 'pas', 'plus'].includes(token));
    if (!directlyNegated && !frenchWrappedNegation) return true;
  }
  return false;
}

export function targetIsNamed(rawRequest: string, target: string): boolean {
  const trimmed = target.trim();
  if (!trimmed) return false;
  const escaped = trimmed
    .split(/\s+/)
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('(?:\\s+|[-_.]+)');
  // Keep structured punctuation inside the token boundary. This rejects
  // api.example.com.evil, alice@example.com.evil, widgets-fork and
  // main-backup while still allowing prose around the exact target.
  return new RegExp(
    `(?:^|[\\s/([{\"'“,:;])${escaped}(?=$|\\s|[)\\]}\"'”,;!?]|[.:](?=$|\\s))`,
    'iu',
  ).test(rawRequest);
}

export function requestClauses(rawRequest: string): string[] {
  return rawRequest
    .split(/(?:[!?;]+|\.(?=\s|$)|[\r\n]+)/u)
    .map(clause => clause.trim())
    .filter(Boolean);
}

/** A target mention is authority only when the local clause does not exclude it. */
export function targetIsNegatedInClause(rawClause: string, target: string): boolean {
  const trimmed = target.trim();
  if (!trimmed) return true;
  const escaped = trimmed
    .split(/\s+/)
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('(?:\\s+|[-_.]+)');
  const expression = new RegExp(
    `(?:^|[\\s/([{"'“,:;])(${escaped})(?=$|\\s|[)\\]}"'”,;!?]|[.:](?=$|\\s))`,
    'giu',
  );
  for (const match of rawClause.matchAll(expression)) {
    const targetStart = (match.index ?? 0) + match[0].lastIndexOf(match[1]!);
    const before = normalizeForMatch(rawClause.slice(Math.max(0, targetStart - 120), targetStart));
    const after = normalizeForMatch(rawClause.slice(targetStart + match[1]!.length, targetStart + match[1]!.length + 120));
    const clause = normalizeForMatch(rawClause);
    const excludedBefore = /(?:^|\s)(?:pas|non|not|never|jamais|sauf|sans|except|excluding|exclude|excludes|excluded|exclure|exclus|exclue|hors|without)(?:\s+(?:only|uniquement|seulement))?(?:\s+(?:a|to|pour|for|de))?(?:\s+(?:le|la|les|l|the|un|une))?(?:\s+(?:contrat|contract|document|envelope|enveloppe|recipient|destinataire|cible|target))?\s*$/.test(before)
      || /(?:^|\s)(?:a l exception de|a l exclusion de|rather than|instead of|plutot que|plutot de)\s*$/.test(before)
      || /(?:^|\s)(?:ne|n)\s+(?:envoie|adresse|transmet|transfere|paie|paye|publie|deploie|redemarre|inclue|inclus|send|email|notify|transfer|pay|publish|deploy|restart|include)\w*\s+pas(?:\s+(?:a|to|pour|vers))?\s*$/.test(before)
      || /(?:^|\s)(?:do not|don t|never)\s+(?:send|email|notify|address|deliver|transfer|pay|publish|deploy|restart|include)(?:\s+(?:to|on|into))?\s*$/.test(before);
    const excludedAfter = /^(?:\s)*(?:(?:n|ne)\s+(?:est|reste)\s+pas\s+(?:autorise|autorisee)|(?:is|are)\s+not\s+(?:allowed|authorized)|(?:(?:est|reste|is|remains)\s+)?(?:strictement\s+)?(?:interdit|interdite|interdits|interdites|forbidden|excluded|exclu|exclue))\b/.test(after);
    const excludedAround = /(?:^|\s)(?:leave|omit|laisse|laisser)\s*$/.test(before)
      && /^(?:out|de cote|excluded|exclu|exclue)\b/.test(after);
    const negativeClause = /^(?:pas|jamais|never|not|sauf|sans|except|excluding|without)\b/.test(clause);
    if (!excludedBefore && !excludedAfter && !excludedAround && !negativeClause) return false;
  }
  return true;
}

const CONDITIONAL_TARGET_TERMS: Readonly<Record<SensitiveConditionalTargetKind, readonly string[]>> = {
  contract: ['contract', 'contrat'],
  document: ['document'],
  envelope: ['envelope', 'enveloppe'],
};

export function explicitConditionalTargetValues(
  rawRequest: string,
  kind: SensitiveConditionalTargetKind,
): string[] {
  const comparableRequest = rawRequest
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const terms = CONDITIONAL_TARGET_TERMS[kind].join('|');
  const values: string[] = [];
  const expression = new RegExp(
    `\\b(?:${terms})\\b\\s*(?:(?:[_-]?id|number|numero|no|n[°º]?)\\s*[:=#-]?\\s*([a-z0-9][a-z0-9._:-]*)|[:=#]\\s*([a-z0-9][a-z0-9._:-]*)|([a-z0-9._:-]*[0-9][a-z0-9._:-]*))`,
    'giu',
  );
  for (const match of comparableRequest.matchAll(expression)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value) values.push(value);
  }
  return [...new Set(values)];
}

function requestHasExplicitConditionalTarget(rawRequest: string): boolean {
  return (['contract', 'document', 'envelope'] as const)
    .some(kind => explicitConditionalTargetValues(rawRequest, kind).length > 0);
}

export function isNonAuthorizingRequest(rawRequest: string, normalizedRequest: string): boolean {
  if (/[?？]/.test(rawRequest)) return true;

  const withoutPoliteness = normalizedRequest.replace(
    /^(?:please|s il te plait|s il vous plait|merci de)\s+/,
    '',
  );
  return NON_AUTHORIZING_QUESTION_PREFIX.test(withoutPoliteness)
    || NON_AUTHORIZING_INFORMATION_PREFIX.test(withoutPoliteness)
    || /\b(?:how to|comment faire|instructions? (?:to|pour))\b/.test(withoutPoliteness);
}

const RETARGETING_MARKER = /\b(?:actually|change|changed|correction|correct|finally|finalement|instead|plutot|rather|replace|remplace|wrong)\b/;

const TARGET_FIELD_RETARGET = /\b(?:account|audience|branch|canal|channel|cible|compte|contract|contrat|customer|destinataire|destination|document|envelope|enveloppe|environment|environnement|host|merchant|org|organization|recipient|remote|repo|repository|service|target|team)\b/;

const DEICTIC_RETARGET = /\b(?:actually|finally|finalement)\s+(?:a|dans|pour|sur|to|vers)\s+(?:le |la |l |the )?[a-z0-9][a-z0-9._/@:-]*\b/;

const ALTERNATIVE_RETARGET = /\b(?:a|dans|pour|sur|to|vers)\s+(?:le |la |l |the )?[a-z0-9][a-z0-9._/@:-]*(?:\s+[a-z0-9._/@:-]+){0,2}\s+(?:instead|plutot|rather)\b/;

/**
 * A terse amendment may change only the target ("Actually, to Bob instead")
 * without repeating the action verb. It must still own the authority boundary:
 * otherwise an older action+target authorization can incorrectly survive.
 */
export function requestExplicitlyRetargets(
  action: SensitiveExternalAction,
  rawRequest: string,
  normalizedRequest: string,
): boolean {
  const hasStructuredTarget = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(rawRequest)
    || /https?:\/\/[^\s]+/i.test(rawRequest)
    || /(?:^|\s)@[A-Za-z0-9_.-]+\b/.test(rawRequest)
    || requestHasExplicitConditionalTarget(rawRequest);
  const explicitlyExcludedTarget = action.targetCandidates.some(target => (
    targetIsNamed(rawRequest, target) && targetIsNegatedInClause(rawRequest, target)
  )) || requestHasExplicitConditionalTarget(rawRequest)
    && /\b(?:interdit|interdite|forbidden|pas|sauf|sans|except|excluding|without)\b/.test(normalizedRequest);
  if (explicitlyExcludedTarget) return true;
  if (hasStructuredTarget
    && /^(?:(?:contract|contrat|document|envelope|enveloppe|recipient|destinataire|to|a|use|utilise)(?:\s+final)?\b)/.test(normalizedRequest)) {
    const structuredActionTargets = action.targetCandidates.filter(target => /[@/:.]/.test(target));
    if (requestHasExplicitConditionalTarget(rawRequest)) return true;
    return !structuredActionTargets.some(target => targetIsNamed(rawRequest, target));
  }
  if (/^[a-z0-9._/@:-]+(?:\s+[a-z0-9._/@:-]+){0,2}\s+(?:instead|plutot)$/.test(normalizedRequest)) {
    return true;
  }
  if (!RETARGETING_MARKER.test(normalizedRequest)) return false;
  if (hasStructuredTarget) return true;
  return TARGET_FIELD_RETARGET.test(normalizedRequest)
    || DEICTIC_RETARGET.test(normalizedRequest)
    || ALTERNATIVE_RETARGET.test(normalizedRequest);
}

const OBJECTIVE_EMAIL_ADDRESS_SOURCE = String.raw`[A-Z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}`;

/** Resolve only the explicit requester of a direct invoice-email fulfillment
 * delegation. This is intentionally not a generic reported-speech rule: it
 * requires a top-level handling order, an embedded resend request, invoice +
 * PDF + email scope, and a uniquely recoverable sender address. */
export function directInvoiceEmailFulfillmentRequester(rawRequest: string): string | undefined {
  if (!rawRequest.trim() || rawRequest.length > 4_000) return undefined;
  const normalized = normalizeForMatch(rawRequest);
  const directHandling = /^(?:(?:merci de|please)\s+)?(?:traite|traitez|traiter|prends?\s+en\s+charge|prenez\s+en\s+charge|prendre\s+en\s+charge|occupe\s+toi\s+de|occupez\s+vous\s+de|handle|process|fulfil|fulfill)\b/u.test(normalized);
  const embeddedResendRequest = /\b(?:(?:qui\s+)?(?:demande|demandant)\s+(?:de\s+|le\s+)?(?:renvoi|renvoie|renvoyer|reexpedition|reexpedie|reexpedier)|(?:asks?|asking|request(?:s|ed|ing)?)\s+(?:you\s+)?(?:to\s+)?(?:resend|send\s+(?:it\s+)?again))\b/u.test(normalized);
  const invoicePdfEmail = /\b(?:facture|invoice)\b/u.test(normalized)
    && /\bpdf\b/u.test(normalized)
    && /\b(?:e\s+mail|email|mail)\b/u.test(normalized);
  const explicitRevocation = /\b(?:(?:ne|n)\s+(?:(?:la|le|les|lui)\s+)?(?:renvoie|reexpedie|envoie|transmets)\b[^.!?;]{0,80}\b(?:pas|plus|rien|jamais)|(?:do\s+not|dont|never)\s+(?:resend|send|forward)|sans\s+(?:renvoi|renvoyer|envoi|envoyer)|without\s+(?:resending|sending|forwarding))\b/u.test(normalized);
  if (!directHandling || !embeddedResendRequest || !invoicePdfEmail || explicitRevocation) {
    return undefined;
  }

  const labelledSender = new RegExp(
    String.raw`(?:^|[\r\n])\s*(?:from|de|exp[ée]diteur)\s*:\s*(?:[^\r\n<>]{0,120}<)?(${OBJECTIVE_EMAIL_ADDRESS_SOURCE})>?\s*$`,
    'imu',
  ).exec(rawRequest)?.[1];
  const pastedSender = new RegExp(
    String.raw`(?:^|[\r\n])[^\r\n<>]{1,160}<(${OBJECTIVE_EMAIL_ADDRESS_SOURCE})>[^\r\n]*\r?\n(?:[^\r\n]*\r?\n){0,3}\s*(?:[ÀA]|To)\s+(?:[^\r\n]*<)?${OBJECTIVE_EMAIL_ADDRESS_SOURCE}>?`,
    'imu',
  ).exec(rawRequest)?.[1];
  const inlineSender = new RegExp(
    String.raw`\b(?:from|de\s+la\s+part\s+de|exp[ée]diteur)\s+(?:[^\r\n<>]{0,100}<)?(${OBJECTIVE_EMAIL_ADDRESS_SOURCE})>?`,
    'iu',
  ).exec(rawRequest)?.[1];
  const captured = labelledSender ?? pastedSender ?? inlineSender;
  if (captured) return captured.toLowerCase();

  const allEmails = [...rawRequest.matchAll(new RegExp(OBJECTIVE_EMAIL_ADDRESS_SOURCE, 'giu'))]
    .map(match => match[0]!.toLowerCase());
  const uniqueEmails = [...new Set(allEmails)];
  return uniqueEmails.length === 1 ? uniqueEmails[0] : undefined;
}

export const EXPLICIT_STOP_BEFORE_EXTERNAL_ACTION = /\b(?:wait|attends?|attendez|arrete(?:z)?(?:\s+toi)?|stop)\b[^.!?;\n]{0,140}\b(?:before|avant)\b[^.!?;\n]{0,100}\b(?:send|sending|publish|deploy|restart|payment|envoi|envoyer|publication|deploiement|redemarrage|paiement)\b/u;

export const EXPLICIT_ACTION_AFTER_CONFIRMATION = /(?:^|[.!?;]\s*)\b(?:after|apres)\s+(?:the\s+|la\s+)?(?:confirmation|approval|autorisation)\b\s*[,:-]?\s*(?:send|publish|deploy|restart|pay|envoie|envoyer|publie|publier|deploie|deployer|redemarre|redemarrer|paie|payer)\b/u;

const GLOBAL_EXTERNAL_ACTION_REVOCATION_CORE = /^(?:non|no|actually\s+no|finalement\s+non|n\s+y\s+va\s+pas|ne\s+continue\s+pas|(?:(?:non|no)\s+)?(?:(?:actually|finalement)\s+)?(?:abort|annule|annuler|arrete(?:z)?(?:\s+toi)?|cancel|do not do it|do nothing|dont do it|forget it|laisse tomber|ne fais(?:\s+surtout)?\s+rien|ne le fais pas|never mind|oublie ca|stop)(?:\s+(?:ca|cela|this|that))?)$/u;

const EXTERNAL_ACTION_REVOCATION_POLITENESS_PREFIX = /^(?:please|s il te plait|s il vous plait|stp|svp)\s+/u;

const EXTERNAL_ACTION_REVOCATION_SUFFIX = /\s+(?:immediately|immediatement|maintenant|now|please|s il te plait|s il vous plait|stp|svp|tout de suite)$/u;

const GENERIC_EXTERNAL_CONFIRMATION_CONTINUATION = /^(?:(?:ok|oui|yes)\s+)?(?:send|envoi|envoie|envoyer|transmets?|transmettre)(?:\s+(?:it|la|le))?$/u;

const TARGETED_EXTERNAL_CONFIRMATION_CONTINUATION = /^(?:(?:ok|oui|yes)\s+)?(?:send|envoi|envoie|envoyer|transmets?|transmettre)\s+(?:(?:the|le|la|l)\s+)?(?:(?:(?:e\s+)?mail|email|invitation|message)\s+)?(?:to|a|vers)\s+([a-z0-9][a-z0-9-]*)$/u;

/** A short answer such as “Envoyer maintenant” is not execution authority.
 * It may only resume an older exact stop-before-action contract so the host can
 * display its scoped prompt. An optional human alias is checked against that
 * same target-bearing objective segment before the boundary is accepted. */
export function externalConfirmationContinuationAlias(
  normalizedRequest: string,
): { matched: true; alias?: string } | undefined {
  const withoutTemporalSuffix = normalizedRequest.replace(/\s+(?:maintenant|now)$/, '');
  if (GENERIC_EXTERNAL_CONFIRMATION_CONTINUATION.test(withoutTemporalSuffix)) {
    return { matched: true };
  }
  const match = TARGETED_EXTERNAL_CONFIRMATION_CONTINUATION.exec(withoutTemporalSuffix);
  const alias = match?.[1]?.trim();
  if (!alias) return undefined;
  return alias ? { matched: true, alias } : { matched: true };
}

export function hasGlobalExternalActionRevocation(rawRequest: string): boolean {
  return requestClauses(rawRequest).some(rawClause => {
    let clause = normalizeForMatch(rawClause)
      .replace(EXTERNAL_ACTION_REVOCATION_POLITENESS_PREFIX, '');
    let previous = '';
    while (clause !== previous) {
      previous = clause;
      clause = clause.replace(EXTERNAL_ACTION_REVOCATION_SUFFIX, '');
    }
    return GLOBAL_EXTERNAL_ACTION_REVOCATION_CORE.test(clause);
  });
}
