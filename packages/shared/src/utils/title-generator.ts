// @rbw-module robinswood-agents:shared/title-generator
// @rbw-role Cross-AI session title prompt builder, client prefix resolver, and validator (CLIENT 1 word + SUJET 2-3 words)
// @rbw-bounds in=[message, recentUserMessages, lastAssistantResponse] | out=[prompt, cleanedTitle] | invariants=[<=500 lines, pure functions]
// @rbw-memory project:robinswood-agents#mod:shared/title-generator

/**
 * Session title generation utilities.
 *
 * Shared helpers for building title prompts and validating results.
 * Enforces the Robinswood cross-AI chat naming standard:
 *   <CLIENT (1 word)> <SUJET (2 or 3 words)>
 *   Examples: "ATRIA Correction facturation", "PNS-GEN Traitement mail Ludwig"
 */

export const CANONICAL_CLIENT_CODES = new Set([
  'ATRIA',
  'PNS-GEN',
  'SILLON',
  'PLC',
  'PLC-CONSEIL',
  'JLM',
  'SAXIUM',
  'OTPE',
  'SRS',
  'CJD80',
  'KOMUNO',
  'DNC',
  'PAPERBRIDGE',
  'UGCOOKIE',
  'GAME-PLUG',
  'TRAID',
  'ORION',
  'WORK',
  'RBW',
]);

const CLIENT_DETECTION_RULES: readonly { readonly code: string; readonly pattern: RegExp }[] = [
  { code: 'ATRIA', pattern: /\b(?:atria|chorus\s*pro|guard\s*te[ck]|gard\s*te[ck]|with\s*time)\b/i },
  { code: 'PNS-GEN', pattern: /\b(?:pns[\s-]*gen|p\s*['’]?\s*s\s+gen|cerfrance\s*pns|gie\s*pns|ludwig|qfq|multi[\s-]*ldm|lettre\s+de\s+mission)\b/i },
  { code: 'SILLON', pattern: /\b(?:sillon|crm\s+vocal)\b/i },
  { code: 'PLC', pattern: /\b(?:plc(?:\s*[- ]\s*conseil|\s+consiel)?|isagri[e]?|lisa\.com\.tab|sila[eé]+|poly\s*acte|kanta|quanta|data\s*yoyo|voiret|cabello|taecke|chiss|baudoux|alseny|alceny)\b/i },
  { code: 'JLM', pattern: /\b(?:jlm|saxium|lamborot|bati\s*geste?|me[sz]ili)\b/i },
  { code: 'OTPE', pattern: /\b(?:otpe|oetp|oise\s+tp|pierre\s*(?:&|et)?\s*c[eé]ram|smart\s+id)\b/i },
  { code: 'SRS', pattern: /\b(?:srs|saint\s+rock|braches)\b/i },
  { code: 'CJD80', pattern: /\b(?:cjd(?:\s*80)?|komuno|bo[iî]te\s+[aà]\s+kiffs?|anne\s+dubois|votrerh)\b/i },
  { code: 'DNC', pattern: /\b(?:depil\s*(?:&|et|n)?\s*care|dnc)\b/i },
  { code: 'PAPERBRIDGE', pattern: /\bpaperbridge\b/i },
  { code: 'UGCOOKIE', pattern: /\bugcookie\b/i },
  { code: 'GAME-PLUG', pattern: /\b(?:game[\s-]*plug|chaosium)\b/i },
  { code: 'TRAID', pattern: /\b(?:traid|alpaca)\b/i },
  { code: 'ORION', pattern: /\b(?:orion|contextforge)\b/i },
  { code: 'WORK', pattern: /\b(?:work\s+portal|cockpit\s+work|backlog\s+work)\b/i },
];

const FRENCH_STOP_WORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'd', 'au', 'aux',
  'ce', 'cet', 'cette', 'ces', 'mon', 'ton', 'son', 'notre', 'votre', 'leur',
  'pour', 'sur', 'dans', 'avec', 'sans', 'chez', 'vers', 'par', 'en', 'et', 'ou',
  'que', 'qui', 'quoi', 'dont', 'ou', 'est', 'sont', 'etre', 'avoir', 'faire',
  'il', 'elle', 'on', 'nous', 'vous', 'ils', 'elles', 'je', 'tu', 'se', 'ne', 'pas',
]);

/**
 * Resolve the 1-word uppercase client/project code from free text.
 * Defaults to 'RBW' when no specific client is matched.
 */
export function resolveCrossAiClientCode(text: string): string {
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  for (const rule of CLIENT_DETECTION_RULES) {
    if (rule.pattern.test(normalized)) {
      return rule.code;
    }
  }
  return 'RBW';
}

/**
 * Format any raw chat title or prompt into the canonical Robinswood cross-AI format:
 *   CLIENT (1 word) + SUJET (2 or 3 words)
 * Examples:
 *   "ATRIA Correction facturation"
 *   "PNS-GEN Traitement mail Ludwig"
 */
export function formatCrossAiChatTitle(rawTitleOrMessage: string, contextText = ''): string {
  const cleaned = rawTitleOrMessage
    .replace(/^[#\-*>\s]+/, '')
    .replace(/^(?:title|topic|titre|sujet)\s*:\s*/i, '')
    .replace(/^["'«»“”]+|["'«»“”]+$/g, '')
    .trim();

  const rawTokens = cleaned
    .replace(/[—–·:|/\\,;.!?()[\]{}]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const firstUpper = (rawTokens[0] ?? '').toUpperCase();
  const hasExplicitCode = CANONICAL_CLIENT_CODES.has(firstUpper);
  const clientCode = hasExplicitCode
    ? (firstUpper === 'PLC-CONSEIL' ? 'PLC' : firstUpper === 'SAXIUM' ? 'JLM' : firstUpper)
    : resolveCrossAiClientCode(`${cleaned} ${contextText}`);

  let subjectTokens = hasExplicitCode ? rawTokens.slice(1) : [...rawTokens];

  // Strip redundant leading client tokens (e.g. "Atria", "PNS", "Gen", "PLC", "Conseil")
  const clientParts = new Set(clientCode.toLowerCase().split('-'));
  if (clientCode === 'PLC') clientParts.add('conseil');
  if (clientCode === 'ATRIA') clientParts.add('surveillance');
  if (clientCode === 'JLM') {
    clientParts.add('menuiserie');
    clientParts.add('saxium');
  }
  while (
    subjectTokens.length > 0 &&
    clientParts.has(subjectTokens[0]!.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/^['’]+/, ''))
  ) {
    subjectTokens.shift();
  }

  // If more than 3 words, drop filler stop-words while preserving meaningful words
  if (subjectTokens.length > 3) {
    const meaningful = subjectTokens.filter((tok) => {
      const norm = tok.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/^[ldnsmtc]['’]/i, '');
      return norm.length > 1 && !FRENCH_STOP_WORDS.has(norm);
    });
    if (meaningful.length >= 2) {
      subjectTokens = meaningful;
    }
  }

  // Strip leading apostrophe prefixes like "l'", "d'" on the remaining tokens
  subjectTokens = subjectTokens
    .map((tok) => tok.replace(/^[ldnsmtc]['’]/i, '').replace(/…+$/g, ''))
    .filter(Boolean);

  if (subjectTokens.length === 0) {
    subjectTokens = ['Suivi', 'sujet'];
  } else if (subjectTokens.length === 1) {
    subjectTokens = ['Suivi', subjectTokens[0]!];
  } else if (subjectTokens.length > 3) {
    subjectTokens = subjectTokens.slice(0, 3);
  }

  // Capitalize first subject word
  const firstWord = subjectTokens[0]!;
  subjectTokens[0] = firstWord.charAt(0).toUpperCase() + firstWord.slice(1);

  return `${clientCode} ${subjectTokens.join(' ')}`;
}

/** Slice text at the last word boundary within `max` characters. */
export function sliceAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const lastSpace = text.lastIndexOf(' ', max);
  return lastSpace > 0 ? text.slice(0, lastSpace) : text.slice(0, max);
}

/**
 * Check if text before a colon looks like LLM preamble.
 * Matches: "Title", "Topic", "Sure", "Sure, the title is", "Here's the topic", etc.
 */
function isPreamblePrefix(text: string): boolean {
  const lower = text.trim().toLowerCase();
  // Exact single-word preamble
  if (/^(?:title|topic|sure|okay|ok)$/.test(lower)) return true;
  // Starts with a known opener and optionally references title/topic
  if (/^(?:sure|okay|ok|here(?:'s| is))\b/.test(lower)) return true;
  // "the title/topic is" or similar
  if (/^the\s+(?:title|topic)\b/.test(lower)) return true;
  return false;
}

/**
 * Sanitize a language preference string before prompt interpolation.
 * Returns undefined for invalid/suspicious inputs so the caller falls back to auto-detect.
 */
export function sanitizeLanguage(language?: string): string | undefined {
  if (!language) return undefined;
  const trimmed = language.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0 || trimmed.length > 40) return undefined;
  // Allow letters (any script), Unicode marks, spaces, hyphens
  if (!/^[\p{L}\p{M}\s\-]+$/u.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Build a language instruction for title prompts.
 * Explicit preference takes priority; otherwise auto-detect from message content.
 */
function buildLanguageInstruction(language?: string): string {
  const safe = sanitizeLanguage(language);
  if (safe) {
    return `Reply in ${safe}.`;
  }
  return 'Reply in the same language as the user\'s messages.';
}

/**
 * Build a prompt for generating a session title from a user message.
 *
 * @param message - The user's message to generate a title from
 * @param options.language - Preferred language for the title
 * @returns Formatted prompt string
 */
export function buildTitlePrompt(message: string, options?: { language?: string }): string {
  const snippet = sliceAtWord(message, 500);
  const clientHint = resolveCrossAiClientCode(snippet);
  return [
    `What topic is the user exploring? Reply ONLY with: <CLIENT_1_WORD> <SUBJECT_2_TO_3_WORDS> (plain text, no markdown, client hint: ${clientHint}).`,
    buildLanguageInstruction(options?.language),
    'Examples: "ATRIA Correction facturation", "PNS-GEN Traitement mail Ludwig", "PLC Audit connecteur ISAGRI", "RBW Dark Mode Support"',
    '',
    'User: ' + snippet,
    '',
    'Topic:',
  ].join('\n');
}

/** Max characters for a message to be considered potentially low-signal. */
const LOW_SIGNAL_MAX_CHARS = 12;
/** Max words for a message to be considered potentially low-signal. */
const LOW_SIGNAL_MAX_WORDS = 2;

/**
 * Check if a message is likely low-signal (short acknowledgement/command).
 * Language-agnostic: uses length + word count only.
 */
export function isLowSignal(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length > LOW_SIGNAL_MAX_CHARS) return false;
  if (trimmed.split(/\s+/).length > LOW_SIGNAL_MAX_WORDS) return false;
  // If it contains a question mark, it's probably a real question
  if (trimmed.includes('?')) return false;
  return true;
}

/**
 * Select a spread of user messages that captures the session's purpose:
 * first (original intent), a recent-biased middle, and last (current state).
 *
 * Strips trailing low-signal messages (short acknowledgements like "ok", "thanks")
 * before selecting, so the spread focuses on substantive content.
 * Falls back to unfiltered if all messages are low-signal.
 *
 * For 4+ messages, picks at indices 0, ~66%, and last — biasing toward
 * where the conversation ended up rather than the exact midpoint.
 */
export function selectSpreadMessages(allUserMessages: string[]): string[] {
  const count = allUserMessages.length;
  if (count === 0) return [];

  // Strip trailing low-signal messages
  let filtered = allUserMessages;
  let trimEnd = allUserMessages.length;
  while (trimEnd > 0 && isLowSignal(allUserMessages[trimEnd - 1]!)) {
    trimEnd--;
  }
  if (trimEnd > 0) {
    filtered = allUserMessages.slice(0, trimEnd);
  }
  // else: all messages are low-signal, keep original array

  const n = filtered.length;
  if (n === 1) return [filtered[0]!];
  if (n === 2) return [filtered[0]!, filtered[1]!];
  if (n === 3) return [filtered[0]!, filtered[1]!, filtered[2]!];

  const midIndex = Math.floor(n * 2 / 3);
  return [filtered[0]!, filtered[midIndex]!, filtered[n - 1]!];
}

/** Build a label for the user messages section based on how many were selected. */
function messagesSectionLabel(count: number): string {
  if (count === 1) return 'User message:';
  if (count === 2) return 'User messages (first, last):';
  return 'Selected user messages:';
}

/**
 * Build a prompt for regenerating a session title from recent messages.
 *
 * @param recentUserMessages - Spread of user messages (first, middle, last)
 * @param lastAssistantResponse - The most recent assistant response
 * @param options.language - Preferred language for the title
 * @returns Formatted prompt string
 */
export function buildRegenerateTitlePrompt(
  recentUserMessages: string[],
  lastAssistantResponse: string,
  options?: { language?: string }
): string {
  const userContext = recentUserMessages
    .map((msg) => sliceAtWord(msg, 500))
    .join('\n\n');
  const assistantSnippet = sliceAtWord(lastAssistantResponse, 500);

  const clientHint = resolveCrossAiClientCode(`${userContext} ${assistantSnippet}`);
  const lines: string[] = [
    `Based on these messages, what is this conversation about? Reply ONLY with: <CLIENT_1_WORD> <SUBJECT_2_TO_3_WORDS> (plain text, no markdown, client hint: ${clientHint}).`,
    'Ignore short acknowledgement messages (like "ok", "thanks", "do it") that don\'t carry topic information.',
    buildLanguageInstruction(options?.language),
    'Examples: "ATRIA Correction facturation", "PNS-GEN Traitement mail Ludwig", "PLC Audit connecteur ISAGRI", "JLM Sync devis Batigest"',
  ];

  lines.push(
    '',
    messagesSectionLabel(recentUserMessages.length),
    userContext,
    '',
    'Latest assistant response:',
    assistantSnippet,
    '',
    'Topic:',
  );

  return lines.join('\n');
}

/** Max word count for a valid title. Anything above this is likely preamble leakage. */
const MAX_TITLE_WORDS = 10;

/**
 * Validate and clean a generated title.
 *
 * Iteratively strips known LLM preamble artifacts (leading "Title:", "Sure:", etc.),
 * then removes quotes and markdown formatting, and checks length/word-count bounds.
 *
 * @param title - The raw title from the model
 * @returns Cleaned title, or null if invalid
 */
export function validateTitle(title: string | null | undefined): string | null {
  if (!title) return null;

  let cleaned = title.trim();

  // Iterative preamble stripping: handles chained preambles like "Sure: Title: Foo"
  let prev = '';
  while (cleaned !== prev) {
    prev = cleaned;
    const colonIndex = cleaned.indexOf(':');
    if (colonIndex > 0 && colonIndex < 40) {
      const beforeColon = cleaned.slice(0, colonIndex);
      if (isPreamblePrefix(beforeColon)) {
        cleaned = cleaned.slice(colonIndex + 1).trim();
      }
    }
  }

  // Strip surrounding quotes
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1);
  }

  // Strip surrounding bold markers **title**
  if (cleaned.startsWith('**') && cleaned.endsWith('**')) {
    cleaned = cleaned.slice(2, -2);
  }

  // Strip leading markdown heading markers (one or more #, -, *)
  cleaned = cleaned.replace(/^[#\-*]+\s+/, '');

  cleaned = cleaned.trim();

  // Reject empty, too long, or too many words (likely preamble leakage)
  if (cleaned.length === 0 || cleaned.length >= 100) return null;
  if (cleaned.split(/\s+/).length > MAX_TITLE_WORDS) return null;

  return cleaned;
}
