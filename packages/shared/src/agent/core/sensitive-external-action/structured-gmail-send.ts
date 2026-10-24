import { hasGlobalExternalActionRevocation, requestClauses } from './request-authorization.ts';
import { GENERIC_CONTINUATIONS, isBoundedSessionPdfAttachmentPath, isCanonicalEmailAddress, normalizeForMatch } from './target-syntax.ts';

export interface StructuredGmailSendResumePayload {
  from: string;
  to: string;
  subject: string;
  body: string;
  attachmentPaths: string[];
}

export type StructuredGmailSendAuthorizationDecision =
  | 'not-applicable'
  | 'invalid'
  | 'authorized';

/** Fixed, non-sensitive reasons why a structured Gmail payload was rejected.
 * These labels intentionally never contain tool input or objective values. */
export type StructuredGmailSendMismatchCategory =
  | 'authenticated-contract-unavailable'
  | 'authorization-boundary'
  | 'unexpected-from'
  | 'unexpected-replyTo'
  | 'unknown-fields'
  | 'to'
  | 'sendAsEmail'
  | 'subject'
  | 'body'
  | 'isHtml'
  | 'attachmentPaths'
  | 'cc'
  | 'bcc'
  | 'optional-guard-types'
  | 'metadata-types';

export interface StructuredGmailSendAuthorizationDiagnostic {
  decision: StructuredGmailSendAuthorizationDecision;
  mismatchCategories: readonly StructuredGmailSendMismatchCategory[];
}

const STRUCTURED_GMAIL_SEND_MARKER = /^\[robb-resume:[A-Za-z0-9][A-Za-z0-9:._-]{1,300}\]$/gmu;

const STRUCTURED_GMAIL_SEND_PAYLOAD_HEADER = /^(?:Payload autoris(?:e|é)|Authorized payload)[ \t]*:[ \t]*$/gimu;

const STRUCTURED_GMAIL_SEND_DIRECT_IMPERATIVE = /\b(?:envoie|envoyez|envoyer|execute|executez|executer|effectue|effectuez|effectuer|realise|realisez|realiser|procede|procedez|proceder|send|execute|perform|dispatch|deliver)\b[^.!?;\n]{0,240}\b(?:e mail|email|gmail|mail|message|envoi|send|sending)\b/u;

const STRUCTURED_GMAIL_SEND_NO_SEND_DIRECTIVE = /\b(?:(?:n|ne)\s+(?:envoie|envoyez|envoyer|transmets|transmettez|transmettre|expedie|expediez|expedier)\s+(?:rien|pas|plus)|(?:do\s+not|don\s+t|never)\s+(?:send|deliver|dispatch|transmit)|sans\s+(?:envoyer|envoi|transmettre)|without\s+(?:sending|delivery|dispatch))\b/u;

const STRUCTURED_GMAIL_SEND_SAFE_ABSENCE_GUARD = /^(?:si|seulement\s+si|if|only\s+if)\b[^.!?;\n]{0,260}\b(?:ambiguite|ambiguous|candidate|draft|brouillon|duplicate|doublon|pagination|sent)\b/u;

const STRUCTURED_GMAIL_SEND_RETARGET = /\b(?:autre\s+(?:destinataire|recipient)|change\s+(?:le\s+)?destinataire|different\s+recipient|instead|mauvais\s+destinataire|plutot|rather|retarget|wrong\s+recipient)\b/u;

function exactlyOneStructuredField(
  text: string,
  pattern: RegExp,
): RegExpMatchArray | undefined {
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) return undefined;
  const match = matches[0]!;
  if (match[1] !== undefined) match[1] = match[1].trim();
  return match;
}

function structuredGmailSendAttachmentPaths(value: string): string[] | undefined {
  if (value === '[]') return [];
  const match = /^\[([^\[\],\r\n]+)\]$/u.exec(value);
  const path = match?.[1];
  return isBoundedSessionPdfAttachmentPath(path) ? [path] : undefined;
}

/** Parse one authenticated restart segment as a closed Gmail send contract.
 *
 * The body is isolated before directive analysis: questions, email addresses,
 * or quoted instructions inside BODY_BEGIN/BODY_END are payload data only.
 * Every authority-bearing label remains single, literal, and outside the body.
 */
export function parseStructuredGmailSendResumeSegment(
  segment: string,
): StructuredGmailSendResumePayload | undefined {
  if (typeof segment !== 'string' || /\0/u.test(segment)) return undefined;
  const marker = exactlyOneStructuredField(segment, STRUCTURED_GMAIL_SEND_MARKER);
  const payloadHeader = exactlyOneStructuredField(segment, STRUCTURED_GMAIL_SEND_PAYLOAD_HEADER);
  const bodyBegin = exactlyOneStructuredField(segment, /^BODY_BEGIN$/gmu);
  const bodyEnd = exactlyOneStructuredField(segment, /^BODY_END$/gmu);
  if (!marker || !payloadHeader || !bodyBegin || !bodyEnd
    || (segment.match(/\[robb-resume[^\]\[\r\n]*\]/giu)?.length ?? 0) !== 1
    || bodyBegin.index === undefined || bodyEnd.index === undefined
    || payloadHeader.index === undefined
    || payloadHeader.index >= bodyBegin.index
    || bodyBegin.index >= bodyEnd.index) return undefined;

  const bodyStart = bodyBegin.index + bodyBegin[0].length;
  if (segment[bodyStart] !== '\n' || segment[bodyEnd.index - 1] !== '\n') return undefined;
  const body = segment.slice(bodyStart + 1, bodyEnd.index - 1);
  if (!body || /\0/u.test(body)) return undefined;

  const withoutBody = `${segment.slice(0, bodyStart + 1)}[authorized body omitted]\n${segment.slice(bodyEnd.index)}`;
  const from = exactlyOneStructuredField(withoutBody, /^-[ \t]*From[ \t]*:[ \t]*([^ \t\r\n][^\r\n]*)$/gimu);
  const to = exactlyOneStructuredField(withoutBody, /^-[ \t]*To[ \t]*:[ \t]*([^ \t\r\n][^\r\n]*)$/gimu);
  const cc = exactlyOneStructuredField(withoutBody, /^-[ \t]*CC[ \t]*:[ \t]*\[\][ \t]*$/gimu);
  const bcc = exactlyOneStructuredField(withoutBody, /^-[ \t]*BCC[ \t]*:[ \t]*\[\][ \t]*$/gimu);
  const subject = exactlyOneStructuredField(
    withoutBody,
    /^-[ \t]*(?:Subject|Sujet)[ \t]*:[ \t]*([^ \t\r\n][^\r\n]*)$/gimu,
  );
  const bodyDeclaration = exactlyOneStructuredField(
    withoutBody,
    /^-[ \t]*(?:Texte du message|Message body)[ \t]*:[ \t]*([^ \t\r\n][^\r\n]*)$/gimu,
  );
  const attachments = exactlyOneStructuredField(
    withoutBody,
    /^-[ \t]*(?:Attachments?|Pieces jointes|Pièces jointes)[ \t]*:[ \t]*([^ \t\r\n][^\r\n]*)$/gimu,
  );
  const signature = exactlyOneStructuredField(
    withoutBody,
    /^-[ \t]*Signature[ \t]*:[ \t]*([^ \t\r\n][^\r\n]*)$/gimu,
  );
  const attachmentPaths = attachments?.[1]
    ? structuredGmailSendAttachmentPaths(attachments[1])
    : undefined;
  if (!from?.[1] || !to?.[1] || !cc || !bcc || !subject?.[1]
    || !bodyDeclaration?.[1] || !attachments || !signature?.[1]
    || !attachmentPaths
    || !isCanonicalEmailAddress(from[1]) || !isCanonicalEmailAddress(to[1])) return undefined;

  const payloadPrelude = segment.slice(
    payloadHeader.index + payloadHeader[0].length,
    bodyBegin.index,
  );
  const allowedPayloadLine = /^-\s*(?:(?:From|To|CC|BCC|Subject|Sujet|Attachments?|Pieces jointes|Pièces jointes)\s*:|(?:Texte du message|Message body)\s*:|Signature\s*:)/iu;
  const payloadLines = payloadPrelude.split('\n').map(line => line.trim()).filter(Boolean);
  if (payloadLines.length !== 8 || payloadLines.some(line => !allowedPayloadLine.test(line))) {
    return undefined;
  }

  const normalizedOutsideBody = normalizeForMatch(withoutBody);
  if (!STRUCTURED_GMAIL_SEND_DIRECT_IMPERATIVE.test(normalizedOutsideBody)) return undefined;
  const hasRevocation = hasGlobalExternalActionRevocation(withoutBody)
    || requestClauses(withoutBody).some(clause => {
      const normalizedClause = normalizeForMatch(clause);
      return STRUCTURED_GMAIL_SEND_NO_SEND_DIRECTIVE.test(normalizedClause)
        && !STRUCTURED_GMAIL_SEND_SAFE_ABSENCE_GUARD.test(normalizedClause);
    });
  if (hasRevocation) return undefined;

  // The body is data, but every other line is authority-bearing control text.
  // Exactly the declared From and To addresses may occur once outside BODY;
  // an extra/repeated address or a retarget hidden on a payload annotation is
  // a conflicting boundary and must not be discarded with the declaration.
  const outsideBodyEmails = [...withoutBody.matchAll(
    /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}\b/giu,
  )].map(match => match[0]);
  if (outsideBodyEmails.length !== 2
    || outsideBodyEmails.filter(email => email === from[1]).length !== 1
    || outsideBodyEmails.filter(email => email === to[1]).length !== 1
    || STRUCTURED_GMAIL_SEND_RETARGET.test(normalizedOutsideBody)) {
    return undefined;
  }

  return { from: from[1], to: to[1], subject: subject[1], body, attachmentPaths };
}

const STRUCTURED_GMAIL_SEND_ALLOWED_INPUT_KEYS = new Set([
  'to', 'cc', 'bcc', 'sendAsEmail', 'subject', 'body', 'isHtml', 'attachmentPaths',
  'requireKnownContacts', 'allowExternal', 'checkContacts', '_displayName', '_intent',
]);

export function canonicalGmailSendInputMismatchCategories(
  input: Record<string, unknown>,
  payload: StructuredGmailSendResumePayload,
): StructuredGmailSendMismatchCategory[] {
  const mismatches: StructuredGmailSendMismatchCategory[] = [];
  if (Object.hasOwn(input, 'from')) mismatches.push('unexpected-from');
  if (Object.hasOwn(input, 'replyTo')) mismatches.push('unexpected-replyTo');
  if (Object.keys(input).some(key => !STRUCTURED_GMAIL_SEND_ALLOWED_INPUT_KEYS.has(key)
    && key !== 'from' && key !== 'replyTo')) mismatches.push('unknown-fields');
  if (input.to !== payload.to) mismatches.push('to');
  if (input.sendAsEmail !== payload.from) mismatches.push('sendAsEmail');
  if (input.subject !== payload.subject) mismatches.push('subject');
  if (input.body !== payload.body) mismatches.push('body');
  if (input.isHtml !== false) mismatches.push('isHtml');
  if (!Array.isArray(input.attachmentPaths)
    || input.attachmentPaths.length !== payload.attachmentPaths.length
    || input.attachmentPaths.some((path, index) => path !== payload.attachmentPaths[index])) {
    mismatches.push('attachmentPaths');
  }
  if (Object.hasOwn(input, 'cc') && input.cc !== '') mismatches.push('cc');
  if (Object.hasOwn(input, 'bcc') && input.bcc !== '') mismatches.push('bcc');
  if (['requireKnownContacts', 'allowExternal', 'checkContacts'].some(key => (
    Object.hasOwn(input, key) && typeof input[key] !== 'boolean'
  ))) mismatches.push('optional-guard-types');
  if (['_displayName', '_intent'].some(key => (
    Object.hasOwn(input, key)
      && (typeof input[key] !== 'string' || /\0/u.test(input[key] as string))
  ))) mismatches.push('metadata-types');
  return mismatches;
}

export function isTargetFreeGenericContinuation(request: string): boolean {
  const withoutPoliteness = normalizeForMatch(request)
    .replace(/^(?:please|s il te plait|s il vous plait|stp|svp)\s+/, '')
    .replace(/\s+(?:please|s il te plait|s il vous plait|stp|svp)$/, '');
  return GENERIC_CONTINUATIONS.has(withoutPoliteness)
    || /^(?:continue|continuez|poursuis|poursuit|poursuivez|reprend|reprends|reprenez|resume|proceed|go ahead)(?:\s+sans\s+(?:(?:t\s+|vous\s+)?arreter)|\s+et\s+va\s+(?:reellement\s+)?jusqu\s+au\s+bout\s+de\s+(?:la|cette)\s+mission|\s+(?:(?:l|la)\s+)?analyse(?:\s+et\s+(?:(?:l|la)\s+)?optimisation)?)?$/u.test(withoutPoliteness);
}

/** A closed progress question or acknowledgement does not retarget a signed
 * exact-effect contract. Keep this narrower than generic conversation: any
 * named project, source, path, target or additional instruction remains a
 * meaningful authority boundary and therefore cannot revive an older grant. */
export function isClosedTargetFreeProgressFollowUp(
  rawRequest: string,
  normalizedRequest = normalizeForMatch(rawRequest),
): boolean {
  if (rawRequest.length > 240 || /```|~~~|^\s*>/mu.test(rawRequest)) return false;
  return /^(?:ou en (?:es tu|sommes nous)|quel(?:le)?s? (?:est|sont) (?:le |la |les )?(?:statut|avancement)|(?:peux tu |pouvez vous |pourrais tu |pourriez vous )?(?:me |nous )?(?:donner|donne|donnez|faire|fais|faites) (?:moi |nous )?(?:un|le) (?:point d avancement|point de situation|statut)|(?:can|could|would) you (?:give|send) (?:me|us) (?:a )?(?:status|progress) update|(?:give|send) (?:me|us) (?:a )?(?:status|progress) update|what(?:s| is) the (?:status|progress)|where are we|how is it going|status|progress|merci|thanks)$/u.test(normalizedRequest);
}
