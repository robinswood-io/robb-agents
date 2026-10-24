import { posix } from "node:path";
import { hasSingleMailboxShape } from "../../../utils/string-boundaries.ts";

export const GENERIC_CONTINUATIONS = new Set([
  'continue',
  'continue please',
  'please continue',
  'proceed',
  'please proceed',
  'go ahead',
  'carry on',
  'resume',
  'poursuis',
  'poursuivez',
  'continuez',
  'vas y',
  'allez y',
  'reprends',
]);

export const NON_AUTHORIZING_QUESTION_PREFIX = /^(?:how|what|why|when|where|who|which|can (?:i|we|you)|could (?:i|we|you)|would (?:i|we|you)|should (?:i|we|you)|do (?:i|we|you)|does|did|will (?:i|we|you)|comment|pourquoi|quand|ou|qui|quel|quelle|peux tu|pouvez vous|dois je|est ce|faut il)\b/;

export const NON_AUTHORIZING_INFORMATION_PREFIX = /^(?:analy[sz]e|analyser|assess|evaluate|evalue|evaluer|review|inspect|inspecte|inspecter|explain|explique|expliquer|describe|decris|decrire|summarize|resume|resumer|investigate|examine|examiner|compare|comparer|show me|montre moi|tell me|dis moi|give me|donne moi|plan|planifie|planifier|propose|document|documente)\b/;

export function normalizeForMatch(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function basename(value: string): string {
  return value.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? value.toLowerCase();
}

export function isCanonicalEmailAddress(value: unknown): value is string {
  if (typeof value !== 'string' || !hasSingleMailboxShape(value) || /\0/u.test(value)) return false;
  const at = value.indexOf('@');
  const dot = value.lastIndexOf('.');
  const host = value.slice(at + 1, dot);
  return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u.test(value.slice(0, at))
    && /^[A-Za-z0-9][A-Za-z0-9.-]*$/u.test(host)
    && /[A-Za-z0-9]$/u.test(host)
    && /^[A-Za-z]{2,}$/u.test(value.slice(dot + 1));
}

export function isBoundedSessionPdfAttachmentPath(path: unknown): path is string {
  if (typeof path !== 'string' || path !== path.trim() || path.length > 600) return false;
  const match = /^\{\{SESSION_PATH\}\}\/(?:downloads|long_responses)\/(.+\.pdf)$/u.exec(path);
  if (!match?.[1]) return false;
  const relativePath = match[1];
  // Keep the symbolic session root literal and reject every path spelling that
  // could normalize to another target. Each nested component must be ordinary
  // ASCII file-name data and the final component must remain a lowercase PDF.
  return posix.normalize(relativePath) === relativePath
    && relativePath.split('/').every(component => (
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(component)
      && component !== '.'
      && component !== '..'
    ));
}

export function hasBoundedSessionPdfAttachment(input: Record<string, unknown>): boolean {
  if (!Array.isArray(input.attachmentPaths) || input.attachmentPaths.length !== 1) return false;
  // The symbolic session root is resolved by the host and cannot escape into
  // another task. Limit this authority recovery to one ordinary PDF beneath
  // the two directories used for connector downloads and long results.
  return isBoundedSessionPdfAttachmentPath(input.attachmentPaths[0]);
}
