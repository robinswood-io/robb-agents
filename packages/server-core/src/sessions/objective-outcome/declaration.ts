import type { Message, ObjectiveOutcomeBlockerKind, ObjectiveOutcomeDeclaration, ObjectiveOutcomeState } from "@craft-agent/core/types";
import { type HostNativeQuestionOutcome } from "../native-question-completion.ts";

export type DeclaredObjectiveState = ObjectiveOutcomeState;

export type ObjectiveBlockerKind = ObjectiveOutcomeBlockerKind;

export interface ExtractedObjectiveOutcome {
  visibleContent: string;
  declaration?: ObjectiveOutcomeDeclaration;
  error?: string;
}

export interface ObjectiveOutcomeValidation {
  state: DeclaredObjectiveState;
  valid: boolean;
  gaps: string[];
  /** Host-normalized checkpoint retained for a valid continuation. This never
   * upgrades evidence; it only removes terminal claims that contradict the
   * declared in-progress state. */
  effectiveDeclaration?: ObjectiveOutcomeDeclaration;
  /** The current final omitted a receipt; this continuation was revalidated
   * from the host's earlier checkpoint for a legacy turn with no budget history. */
  preservedFromPriorOutcome?: boolean;
  /** Present only for an independently proven native recipe correction. */
  declaration?: HostNativeQuestionOutcome;
}

const OUTCOME_COMMENT_PATTERN = /<!--\s*robb_objective_outcome:?\s+([\s\S]*?)-->/gi;

const MAX_DECLARATION_CHARS = 16_000;

const MAX_CRITERIA = 32;

const MAX_EVIDENCE_PER_ITEM = 64;

const MAX_REMAINING_WORK = 64;

const MAX_TEXT_CHARS = 1_000;

const STATES = new Set<DeclaredObjectiveState>([
  'complete_verified', 'blocked_human', 'blocked_policy', 'continue',
]);

const BLOCKER_KINDS = new Set<ObjectiveBlockerKind>([
  'credential', 'mfa', 'external_authorization', 'irreversible_authority', 'business_decision', 'policy',
]);

export const HUMAN_BLOCKER_KINDS = new Set<ObjectiveBlockerKind>([
  'credential', 'mfa', 'external_authorization', 'irreversible_authority', 'business_decision',
]);

export const OBSERVATION_TOOL_PATTERN = /(?:^|_)(?:check|compare|diff|download|fetch|find|get|glob|grep|inspect|lint|list|open|query|read|review|search|screenshot|status|test|typecheck|validate|verify)(?:_|$)/i;

export const NON_VALIDATION_TOOL_PATTERN = /(?:^|_)(?:reload|sleep|todo_read|todo_write|wait)(?:_|$)/i;

export const OBSERVATION_ACTION_PATTERN = /^(?:check|compare|diff|download|fetch|find|get|inspect|lint|list|open|query|read|search|screenshot|status|test|typecheck|validate|verify)(?:$|[_:\-.])/i;

export const OBSERVATION_HTTP_METHOD_PATTERN = /^(?:GET|HEAD)$/i;

export const OBSERVATION_SQL_PATTERN = /^\s*(?:DESCRIBE|EXPLAIN|SELECT|SHOW)\b/i;

export const REVIEW_TOOL_PATTERN = /(?:call_llm|spawn_session|wait_sessions|reviewer|review)/i;

export const CALL_LLM_TOOL_PATTERN = /^(?:(?:mcp__session__|session__|functions\.)?call_llm|mcp__[^:]+__call_llm)$/i;

export const MAX_AUTHENTICATION_RECEIPT_CHARS = 16_000;

export const MAX_AUTHORIZATION_RECEIPT_TTL_MS = 24 * 60 * 60 * 1_000;

export const AUTHENTICATION_SUCCESS_STATES = new Set([
  'authorized', 'authenticated', 'complete', 'completed', 'connected', 'success', 'succeeded',
]);

export const AUTHENTICATION_PENDING_STATES = new Set([
  'pending', 'authorization_pending', 'authentication_pending', 'awaiting_authorization',
  'awaiting_authentication', 'awaiting_user', 'awaiting_user_action', 'user_action_required',
]);

export const KNOWN_AUTHENTICATION_HOSTS = new Set([
  'accounts.google.com',
  'appleid.apple.com',
  'login.microsoft.com',
  'login.microsoftonline.com',
]);

const VAGUE_REMAINING_WORK_PATTERN = /^(?:(?:please\s+)?(?:continue|finish|complete|proceed|retry|try\s+again|do\s+it|do\s+the\s+rest|next\s+step|remaining\s+work|work\s+remains|todo|tbd)|(?:continuer|poursuivre|terminer|compl[eé]ter|r[eé]essayer|faire\s+(?:le\s+n[eé]cessaire|le\s+reste)|prochaine\s+[eé]tape|travail\s+restant|reste\s+[aà]\s+faire|[aà]\s+faire|attendre))[\s.!?…-]*$/iu;

const PASSIVE_EXTERNAL_WAIT_ACTION_PATTERN = /^(?:attendre(?:\s+(?:de|que|qu['’]))?|en\s+attente\s+(?:de|du|des|d['’])|recevoir|await(?:ing)?|wait(?:ing)?\s+for|receive)\b/iu;

const PASSIVE_EXTERNAL_WAIT_RESULT_PATTERN = /\b(?:r[eé]ponse|retour|validation|approbation|autorisation|confirmation|accord|r[eé]pondre|r[eé]ponde|r[eé]pondu|reply|replied|response|approval|authori[sz]ation|permission|respond|sign[ -]?off)\b/iu;

const PASSIVE_HUMAN_ACTOR_PATTERN = /\b(?:client(?:e)?s?|customer|vendor|fournisseur|prestataire|partenaire|partner|tiers|third[ -]?party|utilisateur|user|coll[eè]gue|colleague|[eé]quipe|team|support|administrateur|admin|manager|direction|juriste|avocat|comptable|cabinet|agiris)\b/iu;

const PASSIVE_EXTERNAL_AUTHORITY_PATTERN = /(?:\b(?:external|externe)\b.{0,32}\b(?:approval|authori[sz]ation|permission|sign[ -]?off|approbation|autorisation|validation|accord|confirmation)\b|\b(?:approval|authori[sz]ation|permission|sign[ -]?off|approbation|autorisation|validation|accord|confirmation)\b.{0,32}\b(?:external|externe)\b)/iu;

const PASSIVE_EXTERNAL_POLL_PATTERN = /^(?:v[eé]rifier|contr[oô]ler|voir|rechercher|check|verify|look|see|find\s+out)\b.*\b(?:si|if|whether)\b/iu;

const EXTERNAL_WAIT_FOLLOWUP_PATTERN = /^(?:(?:puis|ensuite|apr[eè]s|une\s+fois|lorsque|quand|si\s+(?:oui|re[çc]u(?:e|es|s)?))|(?:then|after|once|when|if\s+so))\b|^(?:\S+\s+){1,3}(?:ensuite|after|once)\b/iu;

const HUMAN_CONFIRMATION_SOURCE = String.raw`(?:confirmation|approbation|autorisation|validation|accord|feu\s+vert|approval|authorization|permission|sign[ -]?off)`;

const HUMAN_CONFIRMATION_PATTERN = new RegExp(String.raw`\b${HUMAN_CONFIRMATION_SOURCE}\b`, 'iu');

const PENDING_CONFIRMATION_ACTION_PATTERN = /^(?:attendre|recevoir|obtenir|await(?:ing)?|wait(?:ing)?\s+for)\b/iu;

const CLAIMED_PENDING_CONFIRMATION_PATTERN = new RegExp([
  String.raw`\b${HUMAN_CONFIRMATION_SOURCE}\b.{0,120}\b(?:`,
  String.raw`(?:d[eé]j[aà]\s+)?(?:demand[eé]e?|sollicit[eé]e?)`,
  String.raw`|already\s+requested|(?:we\s+)?(?:requested|solicited)`,
  String.raw`|(?:reste|restent|restant(?:e|es|s)?)\s+(?:attendu(?:e|es|s)?|en\s+attente)`,
  String.raw`|remains?\s+(?:awaited|pending)|en\s+attente|pending)\b`,
  String.raw`|\b(?:requested|solicited)\b.{0,80}\b${HUMAN_CONFIRMATION_SOURCE}\b`,
].join(''), 'iu');

const CONFIRMATION_CLAIM_SUBJECT_PATTERN = new RegExp(
  String.raw`^(?:(?:la|le|les|the|l['’])\s*)?(?:(?:requested|solicited)\s+)?${HUMAN_CONFIRMATION_SOURCE}\b`,
  'iu',
);

const AUTOMATED_CONFIRMATION_PROCESS_SOURCE = String.raw`(?:ci(?:\s+pipelines?)?|pipelines?(?:\s+ci)?|jobs?|builds?|deployments?|d[eé]ploiements?|github\s+actions?|workflows?|oauth\s+endpoints?|api\s+endpoints?|processus\s+automatis[eé]s?|automated\s+process(?:es)?)`;

const MACHINE_CONFIRMATION_SOURCE = String.raw`(?:confirmation|validation)`;

const AUTOMATED_CONFIRMATION_BINDING_PATTERN = new RegExp([
  String.raw`(?:\b${MACHINE_CONFIRMATION_SOURCE}\b.{0,96}\b(?:du|de\s+la|de\s+l['’]|des|dans|of|in)\s+(?:(?:le|la|les|the)\s+)?${AUTOMATED_CONFIRMATION_PROCESS_SOURCE}\b)`,
  String.raw`|(?:\b${HUMAN_CONFIRMATION_SOURCE}\b.{0,96}\b(?:par|from|by)\s+(?:(?:le|la|les|the)\s+)?${AUTOMATED_CONFIRMATION_PROCESS_SOURCE}\b)`,
  String.raw`|(?:\b${AUTOMATED_CONFIRMATION_PROCESS_SOURCE}\b.{0,48}\b${MACHINE_CONFIRMATION_SOURCE}\b)`,
].join(''), 'iu');

// Automated jobs are observable work, not human blockers. A continuation may
// poll them and verify their output within the normal bounded recovery budget.
const AUTOMATED_PROCESS_WAIT_PATTERN = /\b(?:api|application|build|ci|deployment|deploy|endpoint|export|github\s+actions?|health[ -]?check|h[oô]te|host|image|import|index(?:ation|ing)?|job|pipeline|queue|serveur|server|service|site|sync|synchronisation|t[aâ]che|task|traitement|url|workflow)\b/iu;

const GMAIL_QUERY_NON_BINDING_TERMS = new Set([
  'access', 'acces', 'account', 'after', 'and', 'api', 'approval', 'authorization',
  'before', 'category', 'cc', 'confirmation', 'contact', 'deliveredto', 'email', 'filename',
  'followup', 'from', 'has', 'in', 'is', 'label', 'larger', 'list', 'message', 'newer',
  'newer_than', 'older', 'older_than', 'other', 'production', 'project', 'question',
  'reply', 'report', 'request', 'response', 'rfc822msgid', 'signoff', 'smaller', 'status',
  'subject', 'support', 'team', 'ticket', 'validation',
  'or', 'permission', 'to',
]);

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TEXT_CHARS;
}

function boundedStringArray(value: unknown, maxItems: number): value is string[] {
  return Array.isArray(value)
    && value.length <= maxItems
    && value.every(isBoundedString);
}

export function concreteRemainingWork(value: string): boolean {
  return !VAGUE_REMAINING_WORK_PATTERN.test(value.trim());
}

function passiveExternalWait(value: string): boolean {
  const normalized = value.trim();
  const waitsForResult = (PASSIVE_EXTERNAL_WAIT_ACTION_PATTERN.test(normalized)
    || PASSIVE_EXTERNAL_POLL_PATTERN.test(normalized))
    && PASSIVE_EXTERNAL_WAIT_RESULT_PATTERN.test(normalized);
  if (!waitsForResult) return false;
  // A named human/vendor remains the dependency even when the subject happens
  // to be a deployment, site or application. Conversely, generic external API
  // responses remain observable machine work rather than human blockers.
  if (PASSIVE_HUMAN_ACTOR_PATTERN.test(normalized)) return true;
  if (AUTOMATED_PROCESS_WAIT_PATTERN.test(normalized)) return false;
  return PASSIVE_EXTERNAL_AUTHORITY_PATTERN.test(normalized);
}

export function whollyDependentOnExternalWait(remainingWork: readonly string[]): boolean {
  let externalWaitSeen = false;
  return remainingWork.length > 0 && remainingWork.every(item => {
    if (passiveExternalWait(item)) {
      externalWaitSeen = true;
      return true;
    }
    return externalWaitSeen && EXTERNAL_WAIT_FOLLOWUP_PATTERN.test(item.trim());
  }) && externalWaitSeen;
}

export function claimsPendingHumanConfirmation(remainingWork: readonly string[]): boolean {
  return remainingWork.some(item => {
    const normalized = item.trim();
    const humanActor = PASSIVE_HUMAN_ACTOR_PATTERN.test(normalized);
    const externalAuthority = PASSIVE_EXTERNAL_AUTHORITY_PATTERN.test(normalized);
    // A status described as "pending" or "already requested" can belong to an
    // observable automated process (CI, deployment, API, job). Do not turn it
    // into a human handoff unless the same item explicitly names a human actor
    // or an external approval authority.
    if (AUTOMATED_CONFIRMATION_BINDING_PATTERN.test(normalized)
      && !humanActor && !externalAuthority) {
      return false;
    }
    if (CLAIMED_PENDING_CONFIRMATION_PATTERN.test(normalized)
      && (PENDING_CONFIRMATION_ACTION_PATTERN.test(normalized)
        || CONFIRMATION_CLAIM_SUBJECT_PATTERN.test(normalized)
        || humanActor || externalAuthority)) return true;
    return PENDING_CONFIRMATION_ACTION_PATTERN.test(normalized)
      && HUMAN_CONFIRMATION_PATTERN.test(normalized)
      && (humanActor || externalAuthority);
  });
}

function foldedWords(value: string): string[] {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(Boolean);
}

export function gmailIdentityTerms(value: string): Set<string> {
  return new Set(foldedWords(value).filter(word => word.length >= 4
    && !GMAIL_QUERY_NON_BINDING_TERMS.has(word)
    && !/^\d+[dhmwy]?$/.test(word)));
}

function parseDeclaration(raw: string): { declaration?: ObjectiveOutcomeDeclaration; detail?: string } {
  const invalid = (detail: string) => ({ detail });
  if (raw.length > MAX_DECLARATION_CHARS) return invalid('receipt exceeds the size limit');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return invalid('receipt must be a JSON object');
  const value = parsed as Record<string, unknown>;
  if (!STATES.has(value.state as DeclaredObjectiveState)) return invalid(`state must be one of: ${[...STATES].join(', ')}`);
  if (!Array.isArray(value.criteria) || value.criteria.length > MAX_CRITERIA) return invalid('criteria must be a bounded array');
  const criteria: ObjectiveOutcomeDeclaration['criteria'] = [];
  for (const [index, candidate] of value.criteria.entries()) {
    const path = `criteria[${index}]`;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return invalid(`${path} must be an object`);
    const item = candidate as Record<string, unknown>;
    if (!isBoundedString(item.id)) return invalid(`${path}.id must be a non-empty bounded string`);
    // Review receipts use "passed". Accept that equivalent boolean spelling only
    // when unambiguous, then subject the canonical receipt to all host evidence
    // checks. This does not turn a reviewer PASS into a successful objective.
    const hasSatisfied = Object.hasOwn(item, 'satisfied');
    const hasPassed = Object.hasOwn(item, 'passed');
    const satisfied = hasSatisfied ? item.satisfied : item.passed;
    if (typeof satisfied !== 'boolean' || (hasPassed && typeof item.passed !== 'boolean')) {
      return invalid(`${path}.satisfied must be a boolean`);
    }
    if (hasSatisfied && hasPassed && item.satisfied !== item.passed) return invalid(`${path} has conflicting satisfied and passed values`);
    if (!boundedStringArray(item.evidence, MAX_EVIDENCE_PER_ITEM)) return invalid(`${path}.evidence must be a bounded array of observed tool/message IDs or host-resolved tool aliases`);
    criteria.push({ id: item.id, satisfied, evidence: item.evidence });
  }
  if (!boundedStringArray(value.remainingWork, MAX_REMAINING_WORK)) return invalid('remainingWork must be an array of concrete remaining steps (or [])');
  let blocker: ObjectiveOutcomeDeclaration['blocker'] = null;
  if (value.blocker !== null) {
    if (!value.blocker || typeof value.blocker !== 'object' || Array.isArray(value.blocker)) return invalid('blocker must be null or an object with kind, description and evidence');
    const item = value.blocker as Record<string, unknown>;
    if (!BLOCKER_KINDS.has(item.kind as ObjectiveBlockerKind)) return invalid(`blocker.kind must be one of: ${[...BLOCKER_KINDS].join(', ')}; only use a kind supported by observed blocker evidence`);
    if (!isBoundedString(item.description)) return invalid('blocker.description must be a non-empty bounded string');
    if (!boundedStringArray(item.evidence, MAX_EVIDENCE_PER_ITEM)) return invalid('blocker.evidence must be a bounded array of observed tool/message IDs or host-resolved tool aliases');
    blocker = { kind: item.kind as ObjectiveBlockerKind, description: item.description, evidence: item.evidence };
  }
  return { declaration: {
    state: value.state as DeclaredObjectiveState,
    criteria,
    remainingWork: value.remainingWork,
    blocker,
  } };
}

/** Extract and hide the single final machine receipt from user-visible prose. */
export function extractObjectiveOutcome(content: string): ExtractedObjectiveOutcome {
  const matches = [...content.matchAll(OUTCOME_COMMENT_PATTERN)];
  const visibleContent = content.replace(OUTCOME_COMMENT_PATTERN, '').trimEnd();
  if (matches.length === 0) return { visibleContent };
  if (matches.length !== 1) return { visibleContent, error: 'multiple objective outcome receipts' };

  const match = matches[0];
  if (!match || content.slice((match.index ?? 0) + match[0].length).trim().length > 0) {
    return { visibleContent, error: 'objective outcome receipt must be the final response element' };
  }
  const parsed = parseDeclaration(match[1]?.trim() ?? '');
  return parsed.declaration
    ? { visibleContent, declaration: parsed.declaration }
    : { visibleContent, error: `malformed objective outcome receipt${parsed.detail ? `: ${parsed.detail}` : ''}` };
}

export function messagesForObjective(messages: Message[], objectiveUserMessageId: string): Message[] {
  const index = messages.findIndex(message => message.id === objectiveUserMessageId && message.role === 'user');
  return index < 0 ? [] : messages.slice(index + 1);
}

export function normalizedToolName(toolName: string | undefined): string {
  return (toolName ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

export const BUILTIN_BASH_TOOL_NAMES = new Set(['Bash', 'bash', 'functions.bash']);

export const BUILTIN_BASH_EVIDENCE_ALIASES = ['tool:Bash', 'tool:bash', 'tool:functions.bash'] as const;
