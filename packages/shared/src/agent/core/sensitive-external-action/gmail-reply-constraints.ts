import { gmailBodyEnvelopeSpans } from './gmail-body-envelopes.ts';
import type { ContextualGmailReplyObjective, ContextualGmailReplyScope } from './gmail-reply-parsing.ts';
import { CONTEXTUAL_REPLY_STRUCTURED_IMMUTABLE_PAYLOAD, contextualGmailBodyMaskedText, contextualGmailExactBody, contextualGmailExpectedSenderEmails, contextualGmailMessageIds, contextualGmailRoutingText, contextualGmailStructuredImmutableControlText, contextualGmailTargetEmails } from './gmail-reply-parsing.ts';
import { requestClauses } from './request-authorization.ts';
import { normalizeForMatch } from './target-syntax.ts';

function contextualGmailExpectedSubjects(rawRequest: string): string[] {
  const routingText = contextualGmailBodyMaskedText(rawRequest);
  const subjects: string[] = [];
  for (const match of routingText.matchAll(
    /\b(?:sujet|subject)(?:[ \t]{1,256}exact)?[ \t]{0,256}(?::|=)?[ \t]{0,256}(?:«([^«»\r\n]{1,998})»|“([^“”\r\n]{1,998})”|"([^"\r\n]{1,998})"|`([^`\r\n]{1,998})`)/giu,
  )) {
    const subject = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? '').trim();
    if (subject) subjects.push(subject);
  }
  // An unquoted subject is accepted only behind the explicit `subject exact`
  // label and before another exact field on the same line. This keeps the
  // boundary structural instead of guessing where ordinary prose ends.
  for (const match of routingText.matchAll(
    /\b(?:sujet|subject)[ \t]{1,256}exact[ \t]{0,256}(?::|=)[ \t]{0,256}(?![«“"`])([^\r\n]{1,998}?)(?=(?:[ \t]*[.;][ \t]*|[ \t]*\r?\n[ \t]*)(?:(?:corps|body|texte|text|message)[ \t]{1,256}exact|exact[ \t]{1,256}(?:body|text|message))\b)/giu,
  )) {
    const subject = (match[1] ?? '').trim();
    if (subject) subjects.push(subject);
  }
  // A structured immutable payload makes each field value exact even when
  // the individual label omits the word "exact".
  if (CONTEXTUAL_REPLY_STRUCTURED_IMMUTABLE_PAYLOAD.test(routingText)) {
    for (const match of routingText.matchAll(
      /(?:^|\r?\n)[ \t]*[-*][ \t]*(?:sujet|subject)[ \t]*:[ \t]*([^\r\n]{1,998})/giu,
    )) {
      const subject = (match[1] ?? '').trim();
      if (subject) subjects.push(subject);
    }
  }
  return [...new Set(subjects)];
}

function contextualGmailExpectedCc(rawRequest: string): string | undefined {
  const routingText = contextualGmailRoutingText(rawRequest);
  const explicitFields = [...routingText.matchAll(
    /(?:^|\r?\n)[ \t]*[-*]?[ \t]*(?:cc|copie)[ \t]*(?::|=)[ \t]*([^\r\n]{1,500})/giu,
  )];
  const explicitEmails = explicitFields.flatMap(match => (
    match[1]?.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu)
      ?.map(email => email.toLowerCase()) ?? []
  ));
  if (explicitEmails.length) return [...new Set(explicitEmails)].sort().join(', ');
  const explicitlyEmpty = /\b(?:cc|copie)\s*(?::|=)?\s*(?:vide|empty|none|aucune?|sans\s+destinataire)\b/iu.test(routingText)
    || /(?:^|\r?\n)[ \t]*[-*][ \t]*(?:cc|copie)[ \t]*:[ \t]*\[\][ \t]*(?=$|\r?\n)/iu.test(routingText);
  if (explicitlyEmpty) {
    return '';
  }
  const field = /\bcc\s*(?::|=)\s*([^.;\r\n]{1,500})/iu.exec(routingText)?.[1];
  if (!field) return undefined;
  const emails = field.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu)
    ?.map(email => email.toLowerCase()) ?? [];
  return emails.length ? [...new Set(emails)].sort().join(', ') : undefined;
}

function contextualGmailHasSingleEmptyStructuredAudienceField(
  rawRequest: string,
  field: 'cc' | 'bcc',
): boolean {
  const routingText = contextualGmailRoutingText(rawRequest);
  const pattern = field === 'cc'
    ? /(?:^|\r?\n)[ \t]*[-*][ \t]*(?:cc|copie)[ \t]*:[ \t]*([^\r\n]*)/giu
    : /(?:^|\r?\n)[ \t]*[-*][ \t]*(?:bcc|cci)[ \t]*:[ \t]*([^\r\n]*)/giu;
  const values = [...routingText.matchAll(pattern)].map(match => match[1]?.trim() ?? '');
  return values.length === 1 && values[0] === '[]';
}

export function contextualGmailExactConstraintSegment(rawRequest: string): boolean {
  const routingText = contextualGmailRoutingText(rawRequest);
  const exactBody = contextualGmailExactBody(rawRequest);
  const exactBodyApplies = exactBody !== undefined && (
    /\b(?:corps\s+exact|exact\s+body|exactement\s+(?:ce|le)\s+corps|exactly\s+(?:this|the)\s+body)\b/iu.test(routingText)
    || /\b(?:gmail|e-?mail|courriel|reply|reponse|repond|fil\s+gmail|messageid)\b/iu.test(routingText)
  );
  return exactBodyApplies
    || contextualGmailExpectedSubjects(rawRequest).length > 0
    || contextualGmailExpectedCc(rawRequest) !== undefined
    || contextualGmailExpectedSenderEmails(rawRequest).length > 0
    || /\b(?:cible\s+exacte|destinataire\s+exact|exact\s+(?:target|recipient)|messageid\s*(?::|=)|ancre\s+exacte|exact\s+anchor)\b/iu.test(routingText)
    || /(?:^|[\s,;])to\s*(?::|=)\s*[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(routingText);
}

function contextualGmailHasNegatedExactField(rawRequest: string): boolean {
  const routingText = contextualGmailRoutingText(rawRequest);
  const field = /\b(?:message\s*id|messageid|ancre|anchor|fil\s+gmail|gmail\s+(?:thread|message)|cible\s+exacte|destinataire\s+exact|exact\s+(?:target|recipient)|from|sender|expediteur|cc|copie|sujet|subject|corps\s+exact|body\s+exact|exact\s+body)\b/u;
  const negative = /\b(?:do\s+not\s+use|don\s+t\s+use|must\s+not\s+use|never\s+use|n\s+utilise\s+pas|ne\s+pas\s+utiliser|interdit|interdite|forbidden|prohibited|exclude|exclure)\b/u;
  return requestClauses(routingText).some(clause => {
    const normalized = normalizeForMatch(clause);
    return field.test(normalized) && negative.test(normalized);
  });
}

function contextualGmailHasUnsupportedExactEffectRequirement(rawRequest: string): boolean {
  const structuredImmutablePayload = CONTEXTUAL_REPLY_STRUCTURED_IMMUTABLE_PAYLOAD.test(
    contextualGmailRoutingText(rawRequest),
  );
  const structuredControlText = contextualGmailStructuredImmutableControlText(rawRequest, false);
  const exactStructuredAttachments = [
    ...structuredControlText.matchAll(
      /(?:^|\r?\n)[ \t]*[-*][ \t]*(?:pi[eè]ces?\s+jointes?|attachments?)[ \t]*:[ \t]*\[\][ \t]*(?=$|\r?\n)/giu,
    ),
  ];
  const allStructuredAttachments = [
    ...structuredControlText.matchAll(
      /(?:^|\r?\n)[ \t]*[-*][ \t]*(?:pi[eè]ces?\s+jointes?|attachments?)[ \t]*:[^\r\n]*(?=$|\r?\n)/giu,
    ),
  ];
  const exactStructuredSignatures = [
    ...structuredControlText.matchAll(
      /(?:^|\r?\n)[ \t]*[-*][ \t]*signature[ \t]*:[ \t]*(?:aucune|none)(?:[ \t]*,[ \t]*(?:ni\s+automatique\s+ni\s+manuelle|neither\s+automatic\s+nor\s+manual))?[ \t]*(?=$|\r?\n)/giu,
    ),
  ];
  const allStructuredSignatures = [
    ...structuredControlText.matchAll(
      /(?:^|\r?\n)[ \t]*[-*][ \t]*signature[ \t]*:[^\r\n]*(?=$|\r?\n)/giu,
    ),
  ];
  const exactStructuredPlainText = [
    ...structuredControlText.matchAll(
      /(?:^|\r?\n)[ \t]*[-*][ \t]*(?:texte\s+brut\s+uniquement|plain\s+text\s+only)[ \t]*(?:\([ \t]*`?isHtml=false`?[ \t]*\)|`?isHtml=false`?)[ \t]*(?=$|\r?\n)/giu,
    ),
  ];
  const allStructuredPlainText = [
    ...structuredControlText.matchAll(
      /(?:^|\r?\n)[ \t]*[-*][ \t]*(?:texte\s+brut\s+uniquement|plain\s+text\s+only)[^\r\n]*(?=$|\r?\n)/giu,
    ),
  ];
  const invalidStructuredPayload = structuredImmutablePayload && (
    exactStructuredAttachments.length !== 1
    || allStructuredAttachments.length !== 1
    || exactStructuredSignatures.length !== 1
    || allStructuredSignatures.length !== 1
    || exactStructuredPlainText.length !== 1
    || allStructuredPlainText.length !== 1
    || !contextualGmailHasSingleEmptyStructuredAudienceField(rawRequest, 'bcc')
  );
  const routingText = structuredControlText
    .replace(/(?:^|\r?\n)[ \t]*[-*][ \t]*(?:pi[eè]ces?\s+jointes?|attachments?)[ \t]*:[ \t]*\[\][ \t]*(?=$|\r?\n)/giu, ' ')
    .replace(/(?:^|\r?\n)[ \t]*[-*][ \t]*signature[ \t]*:[ \t]*(?:aucune|none)(?:[ \t]*,[ \t]*(?:ni\s+automatique\s+ni\s+manuelle|neither\s+automatic\s+nor\s+manual))?[ \t]*(?=$|\r?\n)/giu, ' ')
    .replace(/(?:^|\r?\n)[ \t]*[-*][ \t]*(?:texte\s+brut\s+uniquement|plain\s+text\s+only)[ \t]*(?:\([ \t]*`?isHtml=false`?[ \t]*\)|`?isHtml=false`?)[ \t]*(?=$|\r?\n)/giu, ' ');
  let normalized = normalizeForMatch(routingText);
  normalized = normalized
    .replace(/\b(?:sans|without|no)\s+(?:aucune?\s+|any\s+)?(?:pieces?\s+jointes?|attachments?|fichiers?\s+joints?)\b/gu, ' ')
    .replace(/\baucune?\s+(?:pieces?\s+jointes?|attachments?)\s+n\s+est\s+autorisee?\b/gu, ' ')
    .replace(/\babsence\s+de\s+(?:pieces?\s+jointes?|attachments?|fichiers?\s+joints?)\b/gu, ' ')
    .replace(/\b(?:sans|without|no)\s+(?:aucune?\s+|any\s+)?(?:signature|signature\s+automatique)\b/gu, ' ')
    .replace(/\baucune?\s+signature(?:\s+automatique)?\s+n\s+est\s+(?:ajoutee?|autorisee?)\b/gu, ' ')
    .replace(/\babsence\s+de\s+signature(?:\s+automatique)?\b/gu, ' ');
  return invalidStructuredPayload
    || /\b(?:pieces?\s+jointes?|attachments?|attach(?:ed|ment)?|joindre|joins?|fichiers?\s+joints?)\b/u.test(normalized)
    || /\bsignature\b/u.test(normalized)
    || /\b(?:is\s*html|format\s+html|html\s+format|au\s+format\s+html|corps\s+html|html\s+body)\b/u.test(normalized);
}

export function contextualGmailHasStrictClosedFields(rawRequest: string): boolean {
  const routingText = contextualGmailRoutingText(rawRequest);
  const normalized = normalizeForMatch(routingText);
  const structuredImmutablePayload = CONTEXTUAL_REPLY_STRUCTURED_IMMUTABLE_PAYLOAD.test(normalized);
  const strictAnchor = /\b(?:message\s*id|messageid|ancre(?:\s+exacte?)?|anchor(?:\s+exact)?|fil\s+gmail|gmail\s+(?:thread|message))\b(?:\s+(?:exacte?|exact))?\s*(?:sur|on)?\s*(?::|=|#|-)?\s*`?[0-9a-f]{12,32}`?/iu.test(routingText);
  const strictRecipient = /\b(?:cible\s+exacte|destinataire\s+exact|exact\s+(?:target|recipient))\s*(?::|=)?\s*[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(routingText)
    || /(?:^|[\s,;])to\s*(?::|=)\s*[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(routingText)
    || /\b(?:reply|respond|answer|write\s+back|send|r[ée]ponds?|r[ée]pondez|r[ée]pondre|envoie|envoyer|transmets?|transmettre)\b[^.!?;\r\n]{0,120}\b(?:to|[àa]|vers)\s+[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(routingText);
  const strictSender = contextualGmailExpectedSenderEmails(rawRequest).length === 1;
  const strictEmptyCc = contextualGmailExpectedCc(rawRequest) === ''
    && (!structuredImmutablePayload
      || contextualGmailHasSingleEmptyStructuredAudienceField(rawRequest, 'cc'));
  const strictEmptyBcc = !structuredImmutablePayload
    || contextualGmailHasSingleEmptyStructuredAudienceField(rawRequest, 'bcc');
  const strictSubject = /\b(?:sujet|subject)\s+exact\b/u.test(normalized)
    || structuredImmutablePayload && contextualGmailExpectedSubjects(rawRequest).length === 1;
  const strictBody = /\b(?:corps\s+exact|exact\s+body|body\s+exact|exactement\s+(?:ce|le)\s+corps|exactly\s+(?:this|the)\s+body)\b/u.test(normalized)
    || structuredImmutablePayload
      && gmailBodyEnvelopeSpans(rawRequest)?.length === 1;
  return strictAnchor && strictRecipient && strictSender && strictEmptyCc && strictEmptyBcc
    && strictSubject && strictBody
    && !contextualGmailHasNegatedExactField(rawRequest)
    && !contextualGmailHasUnsupportedExactEffectRequirement(rawRequest);
}

interface ContextualGmailResolvedConstraints {
  requests: readonly string[];
  objectiveRequest: string;
  messageIds: readonly string[];
  recipients: readonly string[];
  senders: readonly string[];
  subjects: readonly string[];
  cc?: string;
  body?: string;
  invalid: boolean;
}

export function contextualGmailResolvedConstraints(
  requested: ContextualGmailReplyObjective,
): ContextualGmailResolvedConstraints {
  const requests = [requested.rawRequest, ...requested.constraintRequests];
  const unique = (values: readonly string[]) => [...new Set(values)];
  const messageIds = unique(requests.flatMap(contextualGmailMessageIds)
    .map(value => value.toLowerCase()));
  const recipients = unique(requests.flatMap(contextualGmailTargetEmails));
  const senders = unique(requests.flatMap(contextualGmailExpectedSenderEmails));
  const subjects = unique(requests.flatMap(contextualGmailExpectedSubjects));
  const ccValues = unique(requests
    .map(contextualGmailExpectedCc)
    .filter((value): value is string => value !== undefined));
  const parsedBodies = requests.map(contextualGmailExactBody);
  const bodyValues = unique(parsedBodies
    .filter((value): value is string => typeof value === 'string'));
  const invalid = parsedBodies.some(value => value === null)
    || requests.some(contextualGmailHasNegatedExactField)
    || requests.some(contextualGmailHasUnsupportedExactEffectRequirement)
    || messageIds.length > 1
    || recipients.length > 1
    || senders.length > 1
    || subjects.length > 1
    || ccValues.length > 1
    || bodyValues.length > 1;
  return {
    requests,
    // This key is internal and binds a preflight receipt to every applicable
    // authenticated amendment, not just to the older segment naming reply.
    objectiveRequest: JSON.stringify(requests),
    messageIds,
    recipients,
    senders,
    subjects,
    ...(ccValues.length === 1 ? { cc: ccValues[0] } : {}),
    ...(bodyValues.length === 1 ? { body: bodyValues[0] } : {}),
    invalid,
  };
}

/**
 * Exact externally visible fields explicitly fixed by the current authenticated
 * contextual Gmail objective. Omitted fields are genuinely unspecified; they
 * must not be invented by a completion check. The anchor is a Gmail message
 * id, not a model-selected thread id, so the connector can prove that the
 * candidate sent message belongs to the anchor's actual thread.
 */
export interface ContextualGmailExactEffectExpectation {
  scope: ContextualGmailReplyScope;
  anchorMessageId?: string;
  expectedRecipientEmail?: string;
  expectedSenderEmail?: string;
  expectedCc?: string;
  expectedSubject?: string;
  expectedBody?: string;
  expectedIsHtml?: boolean;
}
