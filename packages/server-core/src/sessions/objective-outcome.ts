import type {
  AutonomyEvent,
  Message,
  ObjectiveOutcomeBlockerKind,
  ObjectiveOutcomeDeclaration,
  ObjectiveOutcomeState,
} from '@craft-agent/core/types';
import {
  classifyAgentFailure,
  classifyToolNameMutationSemantics,
  isObjectiveShellExecutorToolName,
  isObjectiveShellEvidenceCommand,
  isObjectiveShellObservationCommand,
  parseIndependentReviewReceipt,
} from '@craft-agent/shared/agent';
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions';
import {
  hasObjectiveSubstantiveToolResult,
  currentExplicitReadOnlyAuthorityBoundary,
  isObjectiveToolExecutedSuccessfully,
  isObjectiveMutationTool,
  isObjectiveEvidenceInvalidatingMutation,
  objectiveAllowsContentCheckReview,
  objectiveRequiresExecutionEvidence,
  objectiveReviewBinding,
  findObjectiveText,
  transitionObjectiveContract,
} from './objective-contract.ts';
import {
  collectObjectiveAcceptanceObservations,
  collectObjectiveAcceptanceEvidenceRefs,
  projectObjectiveAcceptanceCriteria,
  validateObjectiveAcceptanceCriteria,
} from './objective-acceptance-criteria.ts';
import { deriveNativeQuestionOutcome, nativeQuestionCompletionRefs, type HostNativeQuestionOutcome } from './native-question-completion.ts';

export type DeclaredObjectiveState = ObjectiveOutcomeState;
export type ObjectiveBlockerKind = ObjectiveOutcomeBlockerKind;
export type { ObjectiveOutcomeDeclaration } from '@craft-agent/core/types';

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

const OUTCOME_COMMENT_PATTERN = /<!--\s*robb_objective_outcome\s+([\s\S]*?)-->/gi;
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
const HUMAN_BLOCKER_KINDS = new Set<ObjectiveBlockerKind>([
  'credential', 'mfa', 'external_authorization', 'irreversible_authority', 'business_decision',
]);
const OBSERVATION_TOOL_PATTERN = /(?:^|_)(?:check|compare|diff|download|fetch|find|get|glob|grep|inspect|lint|list|open|query|read|review|search|screenshot|status|test|typecheck|validate|verify)(?:_|$)/i;
const NON_VALIDATION_TOOL_PATTERN = /(?:^|_)(?:reload|sleep|todo_read|todo_write|wait)(?:_|$)/i;
const OBSERVATION_ACTION_PATTERN = /^(?:check|compare|diff|download|fetch|find|get|inspect|lint|list|open|query|read|search|screenshot|status|test|typecheck|validate|verify)(?:$|[_:\-.])/i;
const OBSERVATION_HTTP_METHOD_PATTERN = /^(?:GET|HEAD)$/i;
const OBSERVATION_SQL_PATTERN = /^\s*(?:DESCRIBE|EXPLAIN|SELECT|SHOW)\b/i;
const REVIEW_TOOL_PATTERN = /(?:call_llm|spawn_session|wait_sessions|reviewer|review)/i;
const CALL_LLM_TOOL_PATTERN = /^(?:(?:mcp__session__|session__|functions\.)?call_llm|mcp__[^:]+__call_llm)$/i;
const MAX_AUTHENTICATION_RECEIPT_CHARS = 16_000;
const MAX_AUTHORIZATION_RECEIPT_TTL_MS = 24 * 60 * 60 * 1_000;
const AUTHENTICATION_SUCCESS_STATES = new Set([
  'authorized', 'authenticated', 'complete', 'completed', 'connected', 'success', 'succeeded',
]);
const AUTHENTICATION_PENDING_STATES = new Set([
  'pending', 'authorization_pending', 'authentication_pending', 'awaiting_authorization',
  'awaiting_authentication', 'awaiting_user', 'awaiting_user_action', 'user_action_required',
]);
const KNOWN_AUTHENTICATION_HOSTS = new Set([
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

function concreteRemainingWork(value: string): boolean {
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

function whollyDependentOnExternalWait(remainingWork: readonly string[]): boolean {
  let externalWaitSeen = false;
  return remainingWork.length > 0 && remainingWork.every(item => {
    if (passiveExternalWait(item)) {
      externalWaitSeen = true;
      return true;
    }
    return externalWaitSeen && EXTERNAL_WAIT_FOLLOWUP_PATTERN.test(item.trim());
  }) && externalWaitSeen;
}

function claimsPendingHumanConfirmation(remainingWork: readonly string[]): boolean {
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

function gmailIdentityTerms(value: string): Set<string> {
  return new Set(foldedWords(value).filter(word => word.length >= 4
    && !GMAIL_QUERY_NON_BINDING_TERMS.has(word)
    && !/^\d+[dhmwy]?$/.test(word)));
}

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
  return [input.to, input.cc, input.bcc, input.subject, input.body,
    input.expectedTo, input.expectedCc, input.expectedSubject]
    .filter((value): value is string => typeof value === 'string' && value.length <= 16_000)
    .join('\n');
}

function gmailNegativeSearchBoundToObjective(
  message: Message, objective: ActiveSessionObjective, messages: readonly Message[],
): boolean {
  if (message.toolName !== 'mcp__google-contacts__gmail_search_exact') return false;
  const query = message.toolInput?.query;
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

function messagesForObjective(messages: Message[], objectiveUserMessageId: string): Message[] {
  const index = messages.findIndex(message => message.id === objectiveUserMessageId && message.role === 'user');
  return index < 0 ? [] : messages.slice(index + 1);
}

function normalizedToolName(toolName: string | undefined): string {
  return (toolName ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

const BUILTIN_BASH_TOOL_NAMES = new Set(['Bash', 'bash', 'functions.bash']);
const BUILTIN_BASH_EVIDENCE_ALIASES = ['tool:Bash', 'tool:bash', 'tool:functions.bash'] as const;

interface ToolAliasCandidateGroup {
  aliases: readonly string[];
  messageIndexes: Set<number>;
}

const ROOT_TOOL_REQUEST_UI_METADATA = new Set(['_intent', '_displayName']);

export interface CurrentObjectiveBlockerObservation {
  kind: ObjectiveBlockerKind;
  message: Message;
  messageIndex: number;
}

function toolAliasDescriptor(toolName: string): { key: string; aliases: readonly string[] } {
  return BUILTIN_BASH_TOOL_NAMES.has(toolName)
    ? { key: 'native:bash', aliases: BUILTIN_BASH_EVIDENCE_ALIASES }
    : { key: `exact:${toolName}`, aliases: [`tool:${toolName}`] };
}

/**
 * Stable bounded projection of persisted JSON data. If a request cannot be
 * compared exactly, keep the earlier blocker rather than guessing that an
 * unrelated success resolved it.
 */
function stableRequestValue(value: unknown, depth = 0): string | undefined {
  if (typeof value === 'string') return value.length <= 4_096 ? JSON.stringify(value) : undefined;
  if (value === null || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (depth > 6 || !value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    if (value.length > 128) return undefined;
    const items = value.map(item => stableRequestValue(item, depth + 1));
    return items.every((item): item is string => item !== undefined) ? `[${items.join(',')}]` : undefined;
  }
  // These two root fields are renderer annotations injected around the real
  // tool request. They may legitimately change between retries and are not
  // part of target identity. Nested fields with the same names remain real
  // arguments and must still compare exactly.
  const keys = Object.keys(value)
    .filter(key => depth > 0 || !ROOT_TOOL_REQUEST_UI_METADATA.has(key))
    .sort();
  if (keys.length > 128) return undefined;
  const fields: string[] = [];
  for (const key of keys) {
    if (key.length > 256) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return undefined;
    const projected = stableRequestValue(descriptor.value, depth + 1);
    if (projected === undefined) return undefined;
    fields.push(`${JSON.stringify(key)}:${projected}`);
  }
  return `{${fields.join(',')}}`;
}

function sameToolRequest(left: Message, right: Message): boolean {
  if (!left.toolName || !right.toolName
    || toolAliasDescriptor(left.toolName).key !== toolAliasDescriptor(right.toolName).key) return false;
  const leftRequest = stableRequestValue(left.toolInput ?? {});
  const rightRequest = stableRequestValue(right.toolInput ?? {});
  return leftRequest !== undefined && leftRequest === rightRequest;
}

function blockerKindsForFailureSignal(message: Message, signal = message.toolResult ?? message.content,
  code?: string): ObjectiveBlockerKind[] {
  const normalizedSignal = signal.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const failure = classifyAgentFailure({
    message: signal,
    toolName: message.toolName,
    code,
  });
  if (failure.failureClass === 'interactive-auth-required') {
    if (/\b(?:mfa|2fa|two[- ]factor|deux\s+facteurs)\b/i.test(normalizedSignal)) return ['mfa'];
    if (/authorization_pending|consent|device[-_ ]code|autorisation/.test(normalizedSignal)) {
      return ['external_authorization'];
    }
    return ['credential'];
  }
  if (failure.failureClass === 'credential-required') return ['credential'];
  if (failure.failureClass === 'permission-denied') return ['external_authorization', 'irreversible_authority'];
  if (failure.failureClass === 'sandbox-denied') return ['policy'];
  return [];
}

function failureBlockerKinds(message: Message): ObjectiveBlockerKind[] {
  return blockerKindsForFailureSignal(message);
}

/**
 * A successful structured negative is authoritative only when it comes from a
 * connector operation whose exact name describes an interactive auth receipt.
 * Generic shell/read tools can print attacker-controlled JSON and session MCP
 * tools are orchestration surfaces, not external authorization authorities.
 */
function isStructuredAuthenticationReceiptTool(toolName?: string): boolean {
  const canonical = (toolName ?? '').replace(/^functions\./i, '');
  const match = /^mcp__(?!session__)[a-z0-9][a-z0-9_-]{0,127}__([a-z0-9][a-z0-9_-]{0,127})$/i.exec(canonical);
  if (!match) return false;
  const operation = match[1]!;
  const authSubject = /(?:^|_)(?:auth(?:entication|orization)?|oauth|device(?:_code)?|consent)(?:_|$)/i.test(operation);
  const receiptAction = /(?:^|_)(?:poll|status|check|wait|receipt|start|begin|request|connect|login|authorize|consent)(?:_|$)/i.test(operation);
  return authSubject && receiptAction;
}

interface StructuredAuthenticationToolName {
  connector: string;
  operation: string;
}

interface StructuredAuthenticationPollBinding {
  pollToolName: StructuredAuthenticationToolName;
  correlations: AuthCorrelations;
}

interface StructuredAuthenticationStartReceipt extends StructuredAuthenticationPollBinding {
  expiresAtMs: number;
}

type AuthCorrelationKind = 'id' | 'request' | 'connection';
type AuthCorrelations = Record<AuthCorrelationKind, Map<string, string>>;

function structuredAuthenticationToolName(toolName?: string): StructuredAuthenticationToolName | undefined {
  const canonical = (toolName ?? '').replace(/^functions\./i, '');
  const match = /^mcp__(?!session__)([a-z0-9][a-z0-9_-]{0,127})__([a-z0-9][a-z0-9_-]{0,127})$/i.exec(canonical);
  return match ? { connector: match[1]!.toLowerCase(), operation: match[2]!.toLowerCase() } : undefined;
}

function boundedStringField(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function authCorrelationDescriptor(key: string): { kind: AuthCorrelationKind; key: string } | undefined {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  if (normalized === 'id' || /^(?:auth|authorization|oauth)_id$/.test(normalized)) {
    return { kind: 'id', key: 'id' };
  }
  if (normalized === 'request' || /^(?:(?:auth|authorization|oauth)_)?request_id$/.test(normalized)) {
    return { kind: 'request', key: 'request_id' };
  }
  // A device code may coexist with a provider request ID and legitimately
  // carry a different value. Keep it in the request domain for cross-domain
  // isolation, but do not collapse these two distinct protocol identifiers.
  if (normalized === 'device_code') return { kind: 'request', key: 'device_code' };
  if (normalized === 'connection' || /^(?:(?:connector|oauth)_)?connection_id$/.test(normalized)) {
    return { kind: 'connection', key: 'connection_id' };
  }
  return undefined;
}

function authCorrelationValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0 && value.length <= 512) return JSON.stringify(value);
  return typeof value === 'number' && Number.isFinite(value) ? JSON.stringify(value) : undefined;
}

function setAuthCorrelation(
  correlations: AuthCorrelations, kind: AuthCorrelationKind, key: string, value: string,
): boolean {
  const previous = correlations[kind].get(key);
  if (previous !== undefined && previous !== value) return false;
  correlations[kind].set(key, value);
  return true;
}

function authCorrelations(value: Record<string, unknown>, authRequestId?: string): AuthCorrelations | undefined {
  const correlations: AuthCorrelations = {
    id: new Map(), request: new Map(), connection: new Map(),
  };
  for (const [key, candidate] of Object.entries(value)) {
    const descriptor = authCorrelationDescriptor(key);
    if (!descriptor) continue;
    const projected = authCorrelationValue(candidate);
    if (projected === undefined
      || !setAuthCorrelation(correlations, descriptor.kind, descriptor.key, projected)) return undefined;
  }
  if (authRequestId
    && !setAuthCorrelation(correlations, 'request', 'request_id', JSON.stringify(authRequestId))) {
    return undefined;
  }
  return correlations;
}

function mergeAuthCorrelations(left: AuthCorrelations, right: AuthCorrelations): AuthCorrelations | undefined {
  const merged: AuthCorrelations = {
    id: new Map(left.id), request: new Map(left.request), connection: new Map(left.connection),
  };
  for (const kind of ['id', 'request', 'connection'] as const) {
    for (const [key, value] of right[kind]) {
      if (!setAuthCorrelation(merged, kind, key, value)) return undefined;
    }
  }
  return merged;
}

function hasAuthCorrelation(correlations: AuthCorrelations): boolean {
  return correlations.id.size > 0 || correlations.request.size > 0 || correlations.connection.size > 0;
}

/** Match the strongest identity domain emitted by the auth operation. A
 * shared connection is insufficient once the receipt exposes a request,
 * device-code or auth ID; every supplied comparable value must also agree. */
function matchingAuthCorrelations(expected: AuthCorrelations, candidate: AuthCorrelations): boolean {
  const requiresSpecificIdentity = expected.id.size > 0 || expected.request.size > 0;
  let matchedRequiredDomain = false;
  for (const kind of ['id', 'request', 'connection'] as const) {
    for (const [key, candidateValue] of candidate[kind]) {
      const expectedValue = expected[kind].get(key);
      if (expectedValue === undefined) continue;
      if (candidateValue !== expectedValue) return false;
      if (requiresSpecificIdentity ? kind !== 'connection' : kind === 'connection') {
        matchedRequiredDomain = true;
      }
    }
  }
  return matchedRequiredDomain;
}

function structuredAuthenticationStartReceipt(message: Message): StructuredAuthenticationStartReceipt | undefined {
  if (!isObjectiveToolExecutedSuccessfully(message) || !message.toolResult
    || message.toolResult.length > MAX_AUTHENTICATION_RECEIPT_CHARS) return undefined;
  const startToolName = structuredAuthenticationToolName(message.toolName);
  if (!startToolName
    || !/(?:^|_)(?:auth(?:entication|orization)?|oauth|device(?:_code)?|consent)(?:_|$)/i.test(startToolName.operation)
    || !/(?:^|_)(?:start|begin|request|connect|login|authorize|consent)(?:_|$)/i.test(startToolName.operation)) {
    return undefined;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(message.toolResult.trim()); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const value = parsed as Record<string, unknown>;
  if (value.ok !== undefined && typeof value.ok !== 'boolean') return undefined;
  if (value.success !== undefined && typeof value.success !== 'boolean') return undefined;
  if (value.pending !== undefined && typeof value.pending !== 'boolean') return undefined;
  if ((value.ok !== true && value.success !== true)
    || value.ok === false || value.success === false || value.pending === false) return undefined;
  if (value.error !== undefined && value.error !== null) {
    if (typeof value.error !== 'string' || value.error.length > 4_096 || value.error.trim().length > 0) {
      return undefined;
    }
  }
  for (const field of ['status', 'state'] as const) {
    if (value[field] === undefined) continue;
    if (!boundedStringField(value[field], 64)
      || !AUTHENTICATION_PENDING_STATES.has(value[field].trim().toLowerCase())) return undefined;
  }
  const verificationUri = value.verification_uri ?? value.verificationUri;
  const userCode = value.user_code ?? value.userCode;
  const pollOperationValue = value.pollAfterHumanLoginWith ?? value.poll_after_human_login_with;
  const expiresAt = value.expiresAt ?? value.expires_at;
  if (!boundedStringField(verificationUri, 2_048)
    || !/^https:\/\/[^\s]+$/i.test(verificationUri)
    || !boundedStringField(userCode, 128)
    || !/^[a-z0-9][a-z0-9._-]{1,127}$/i.test(userCode)
    || !boundedStringField(pollOperationValue, 128)
    || !boundedStringField(expiresAt, 128)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(expiresAt)) {
    return undefined;
  }
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(message.timestamp)
    || expiresAtMs > message.timestamp + MAX_AUTHORIZATION_RECEIPT_TTL_MS) {
    return undefined;
  }
  const explicitPollToolName = structuredAuthenticationToolName(pollOperationValue);
  const pollToolName = explicitPollToolName ?? {
    connector: startToolName.connector,
    operation: pollOperationValue.toLowerCase(),
  };
  if (pollToolName.connector !== startToolName.connector
    || !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(pollToolName.operation)
    || !/(?:auth|oauth|device|consent).*(?:poll|status|check)|(?:poll|status|check).*(?:auth|oauth|device|consent)/i.test(pollToolName.operation)) {
    return undefined;
  }
  const inputCorrelations = authCorrelations(message.toolInput ?? {}, message.authRequestId);
  const resultCorrelations = authCorrelations(value, message.authRequestId);
  if (!inputCorrelations || !resultCorrelations) return undefined;
  const correlations = mergeAuthCorrelations(inputCorrelations, resultCorrelations);
  if (!correlations) return undefined;
  return {
    expiresAtMs,
    pollToolName,
    correlations,
  };
}

function matchingAuthenticationPoll(
  binding: StructuredAuthenticationPollBinding, candidate: Message, resultCorrelations: AuthCorrelations,
): boolean {
  const candidateToolName = structuredAuthenticationToolName(candidate.toolName);
  if (!candidateToolName
    || candidateToolName.connector !== binding.pollToolName.connector
    || candidateToolName.operation !== binding.pollToolName.operation) return false;
  const inputCorrelations = authCorrelations(candidate.toolInput ?? {}, candidate.authRequestId);
  if (!inputCorrelations) return false;
  const candidateCorrelations = mergeAuthCorrelations(inputCorrelations, resultCorrelations);
  if (!candidateCorrelations) return false;
  return matchingAuthCorrelations(binding.correlations, candidateCorrelations);
}

function successfulAuthenticationPollReceipt(message: Message): AuthCorrelations | undefined {
  if (!isObjectiveToolExecutedSuccessfully(message) || !message.toolResult
    || message.toolResult.length > MAX_AUTHENTICATION_RECEIPT_CHARS) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(message.toolResult.trim()); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const value = parsed as Record<string, unknown>;
  if (value.pending !== undefined && typeof value.pending !== 'boolean') return undefined;
  if (value.ok !== undefined && typeof value.ok !== 'boolean') return undefined;
  if (value.success !== undefined && typeof value.success !== 'boolean') return undefined;
  if (value.pending === true || value.ok === false || value.success === false) return undefined;
  if (value.error !== undefined && value.error !== null) {
    if (typeof value.error !== 'string' || value.error.length > 4_096 || value.error.trim().length > 0) {
      return undefined;
    }
  }
  const states: string[] = [];
  for (const field of ['status', 'state'] as const) {
    if (value[field] === undefined) continue;
    if (!boundedStringField(value[field], 64)) return undefined;
    const normalized = value[field].trim().toLowerCase();
    if (!AUTHENTICATION_SUCCESS_STATES.has(normalized)) return undefined;
    states.push(normalized);
  }
  if (value.pending !== false && states.length === 0) return undefined;
  return authCorrelations(value);
}

/** A pending poll is durable blocker evidence only when its machine fields are
 * internally consistent. Free-form prose is deliberately excluded: the host
 * must be able to distinguish pending from terminal/fatal responses without
 * interpreting connector text. */
function pendingAuthenticationPollReceipt(value: Record<string, unknown>): boolean {
  if (value.pending !== undefined && typeof value.pending !== 'boolean') return false;
  if (value.ok !== undefined && typeof value.ok !== 'boolean') return false;
  if (value.success !== undefined && typeof value.success !== 'boolean') return false;
  if (value.ok !== undefined && value.success !== undefined && value.ok !== value.success) return false;
  if (value.pending === false || value.success === true) return false;

  let pending = value.pending === true;
  for (const field of ['status', 'state'] as const) {
    if (value[field] === undefined) continue;
    if (!boundedStringField(value[field], 64)) return false;
    const normalized = value[field].trim().toLowerCase();
    if (!AUTHENTICATION_PENDING_STATES.has(normalized)) return false;
    pending = true;
  }
  for (const field of ['code', 'error'] as const) {
    if (value[field] === undefined || value[field] === null || value[field] === '') continue;
    if (!boundedStringField(value[field], field === 'error' ? 4_096 : 256)) return false;
    if (!AUTHENTICATION_PENDING_STATES.has(value[field].trim().toLowerCase())) return false;
    pending = true;
  }
  return pending;
}

/** Bind a blocker emitted directly by an auth poll/status/receipt operation.
 * Unlike an auth-start receipt it has no declared follow-up operation, so only
 * a strict success from this exact connector operation and correlated flow can
 * retire it. */
function structuredAuthenticationPollBlocker(message: Message): StructuredAuthenticationPollBinding | undefined {
  if (!isObjectiveToolExecutedSuccessfully(message) || !message.toolResult
    || message.toolResult.length > MAX_AUTHENTICATION_RECEIPT_CHARS) return undefined;
  const pollToolName = structuredAuthenticationToolName(message.toolName);
  if (!pollToolName
    || !/(?:^|_)(?:auth(?:entication|orization)?|oauth|device(?:_code)?|consent)(?:_|$)/i.test(pollToolName.operation)
    || !/(?:^|_)(?:poll|status|check|wait|receipt)(?:_|$)/i.test(pollToolName.operation)) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(message.toolResult.trim()); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  if (!pendingAuthenticationPollReceipt(parsed as Record<string, unknown>)) return undefined;
  const inputCorrelations = authCorrelations(message.toolInput ?? {}, message.authRequestId);
  const resultCorrelations = authCorrelations(parsed as Record<string, unknown>, message.authRequestId);
  if (!inputCorrelations || !resultCorrelations) return undefined;
  const correlations = mergeAuthCorrelations(inputCorrelations, resultCorrelations);
  return correlations && hasAuthCorrelation(correlations) ? { pollToolName, correlations } : undefined;
}

function structuredAuthenticationSurface(text: string): boolean {
  const rawUrl = /^url:\s*(https?:\/\/\S+)/im.exec(text)?.[1];
  if (!rawUrl || rawUrl.length > 2_048) return false;
  try {
    const url = new URL(rawUrl);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    // A browser snapshot is observation-only and cannot prove that a custom
    // application's login form is the credential boundary for the objective.
    // Custom authentication must instead emit the structured auth request or
    // receipt handled above. Only known identity-provider hosts are strong
    // enough for a snapshot alone to prove a current human blocker.
    return KNOWN_AUTHENTICATION_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

/**
 * Some connectors return a successful transport receipt whose business result
 * is explicitly pending/negative (for example an OAuth device-code poll).
 * Browser snapshots can likewise prove that a credential form is currently
 * blocking progress. Admit only bounded, machine-shaped negatives or an exact
 * interactive authentication surface; arbitrary successful prose is never a
 * blocker.
 */
function completedToolBlockerKinds(
  message: Message, objective?: ActiveSessionObjective, messages: readonly Message[] = [],
): ObjectiveBlockerKind[] {
  if (!isObjectiveToolExecutedSuccessfully(message) || !message.toolResult) return [];
  const text = message.toolResult.trim();
  if (!text) return [];

  if (objective && gmailNegativeSearchBoundToObjective(message, objective, messages)) {
    return ['external_authorization'];
  }

  if (isStructuredAuthenticationReceiptTool(message.toolName)) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const value = parsed as Record<string, unknown>;
        const toolName = structuredAuthenticationToolName(message.toolName);
        const pollOperation = !!toolName
          && /(?:^|_)(?:poll|status|check|wait|receipt)(?:_|$)/i.test(toolName.operation);
        // Poll blockers use a strict machine-state parser and a non-empty flow
        // binding. Generic failure-text classification must never admit or
        // retire an auth poll independently of that binding.
        if (pollOperation) return structuredAuthenticationPollBlocker(message)
          ? ['external_authorization']
          : [];
        const explicitlyNegative = value.pending === true || value.ok === false || value.success === false;
        const rawCode = [value.code, value.error, value.status]
          .find((candidate): candidate is string => typeof candidate === 'string' && candidate.length <= 256);
        const rawMessage = [value.message, value.error, value.code]
          .filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length <= 4_096)
          .join(' ');
        if (explicitlyNegative && rawMessage) {
          const classified = blockerKindsForFailureSignal(message, rawMessage, rawCode);
          if (classified.length > 0) return classified;
        }
        if (value.pending === true) return ['external_authorization'];
        // A device-code/auth start can succeed at the transport layer while
        // explicitly handing the next step to a human. Require a strict,
        // machine-shaped receipt from an allowlisted connector operation so a
        // generic successful JSON object or arbitrary prose cannot become a
        // blocker.
        if (structuredAuthenticationStartReceipt(message)) return ['external_authorization'];
      }
    } catch { /* A browser observation is intentionally plain text. */ }
  }

  if (!/(?:^|_)browser_tool$/i.test(normalizedToolName(message.toolName))) return [];
  const folded = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const authenticationSurface = structuredAuthenticationSurface(text);
  if (!authenticationSurface) return [];
  const accountChooser = /\[button\]/.test(folded)
    && /\[(?:heading|list)\]/.test(folded)
    && /\b(?:choisir|selectionner|select|choose|pick)\s+(?:un |an )?(?:compte|account)\b/.test(folded)
    && /\b(?:utiliser un autre compte|use another account|se connecter avec le compte|sign in with (?:the )?account)\b/.test(folded);
  if (accountChooser) return ['credential'];
  if (!/\[(?:textbox|input)\]/.test(folded)) return [];
  if (/\b(?:mfa|2fa|two[- ]factor|deux\s+facteurs|verification code|code de verification)\b/.test(folded)) {
    return ['mfa'];
  }
  if (/password|mot de passe/.test(folded)) return ['credential'];
  return [];
}

function objectiveBlockerKinds(
  message: Message, objective?: ActiveSessionObjective, messages: readonly Message[] = [],
): ObjectiveBlockerKind[] {
  return message.isError || message.toolStatus === 'error'
    ? failureBlockerKinds(message)
    : completedToolBlockerKinds(message, objective, messages);
}

function matchingAuthResolved(
  scoped: readonly Message[], failure: Message, failureIndex: number, success: Message, successIndex: number,
): boolean {
  if (!failure.authRequestId) return true;
  if (success.authRequestId === failure.authRequestId) return true;
  return scoped.slice(failureIndex + 1, successIndex + 1).some(message => (
    message.role === 'auth-request'
    && message.authRequestId === failure.authRequestId
    && message.authStatus === 'completed'
  ));
}

/**
 * Host-observed blockers that are still current. A later success retires a
 * tool failure only when its native/exact tool identity and complete request
 * match; an auth-bound failure additionally needs the same resolved auth.
 */
export function currentObjectiveBlockerObservations(
  messages: readonly Message[], objective: ActiveSessionObjective,
): CurrentObjectiveBlockerObservation[] {
  const scoped = messagesForObjective([...messages], objective.userMessageId);
  const observations: CurrentObjectiveBlockerObservation[] = [];
  for (const [index, message] of scoped.entries()) {
    // A real follow-up from the user re-opens the objective and asks the host
    // to reassess its environment. A tool/auth failure observed before that
    // boundary is historical evidence, not proof that the blocker still
    // exists. Hidden recovery prompts do not retire anything: only a new,
    // authenticated user turn forces the fresh observation.
    const supersededByUserTurn = scoped.slice(index + 1).some(candidate => (
      candidate.role === 'user' && !candidate.hidden && !candidate.internalOrigin
    ));
    if (supersededByUserTurn) continue;
    if (message.role === 'auth-request' && message.authStatus === 'pending') {
      const stillPending = !message.authRequestId || !scoped.slice(index + 1).some(candidate => (
        candidate.role === 'auth-request'
        && candidate.authRequestId === message.authRequestId
        && candidate.authStatus !== 'pending'
      ));
      if (stillPending) {
        observations.push({ kind: 'credential', message, messageIndex: index });
        if (/\b(?:mfa|2fa|two[- ]factor|deux\s+facteurs)\b/i.test(message.content)) {
          observations.push({ kind: 'mfa', message, messageIndex: index });
        }
      }
      continue;
    }
    if (message.role !== 'tool') continue;
    const kinds = objectiveBlockerKinds(message, objective, messages);
    if (!kinds.length) continue;
    const authStart = structuredAuthenticationStartReceipt(message);
    const authPollBlocker = authStart ? undefined : structuredAuthenticationPollBlocker(message);
    if (authStart && Date.now() >= authStart.expiresAtMs) continue;
    const resolved = scoped.slice(index + 1).some((candidate, offset) => {
      const candidateIndex = index + 1 + offset;
      const pollReceipt = authStart || authPollBlocker
        ? successfulAuthenticationPollReceipt(candidate)
        : undefined;
      const matchingSuccess = authStart
        ? pollReceipt !== undefined && matchingAuthenticationPoll(authStart, candidate, pollReceipt)
        : authPollBlocker
          ? pollReceipt !== undefined && matchingAuthenticationPoll(authPollBlocker, candidate, pollReceipt)
          : isObjectiveToolExecutedSuccessfully(candidate)
            && objectiveBlockerKinds(candidate, objective, messages).length === 0
            && sameToolRequest(message, candidate);
      return matchingSuccess
        && matchingAuthResolved(scoped, message, index, candidate, candidateIndex);
    });
    if (!resolved) {
      observations.push(...kinds.map(kind => ({ kind, message, messageIndex: index })));
    }
  }
  return observations;
}

function substantiveToolResult(message: Message): string | undefined {
  return hasObjectiveSubstantiveToolResult(message)
    ? message.toolResult!.trim()
    : undefined;
}

function observationOrValidationTool(message: Message): boolean {
  if (isObjectiveMutationTool(message)) return false;
  if (classifyToolNameMutationSemantics(message.toolName ?? '') === 'ambiguous-compound') return false;
  const toolName = normalizedToolName(message.toolName);
  const input = message.toolInput ?? {};
  const command = [input.command, input.cmd, input.script]
    .find((value): value is string => typeof value === 'string');
  // Generic/local/remote shell executors use the shared non-opaque subset.
  // The registered-only validator/curl extension is applied below only after
  // exact acceptance evidence matched. Tool naming alone cannot turn inline
  // code or fabricated stdout into a validation observation.
  if (isObjectiveShellExecutorToolName(message.toolName ?? '')) {
    return command !== undefined && isObjectiveShellObservationCommand(command);
  }
  if (NON_VALIDATION_TOOL_PATTERN.test(toolName)) return false;
  if (OBSERVATION_TOOL_PATTERN.test(toolName)) return true;
  const action = [input.action, input.operation]
    .find((value): value is string => typeof value === 'string');
  if (action && OBSERVATION_ACTION_PATTERN.test(action.trim())) return true;
  const method = input.method;
  if (typeof method === 'string' && OBSERVATION_HTTP_METHOD_PATTERN.test(method.trim())) return true;
  const query = [input.query, input.sql, input.statement]
    .find((value): value is string => typeof value === 'string');
  if (query && OBSERVATION_SQL_PATTERN.test(query)) return true;
  return command ? isObjectiveShellObservationCommand(command) : false;
}

function hostEvidenceRefs(
  messages: Message[],
  objective: ActiveSessionObjective,
  acceptanceEvidenceRefs: ReadonlySet<string> = new Set(),
  reviewNotBefore?: number,
): {
  successful: Set<string>;
  checks: Set<string>;
  review: Set<string>;
  incompleteCheckReviews: Map<string, string[]>;
  blockers: Record<ObjectiveBlockerKind, Set<string>>;
} {
  const scoped = messagesForObjective(messages, objective.userMessageId);
  const successful = new Set<string>(['assistant-final']);
  const checks = new Set<string>();
  const review = new Set<string>();
  const incompleteCheckReviews = new Map<string, string[]>();
  const blockers: Record<ObjectiveBlockerKind, Set<string>> = {
    credential: new Set(),
    mfa: new Set(),
    external_authorization: new Set(),
    irreversible_authority: new Set(),
    business_decision: new Set(),
    policy: new Set(),
  };
  const toolAliasCandidates = new Map<Set<string>, Map<string, ToolAliasCandidateGroup>>();
  const addAliasCandidate = (refs: Set<string>, message: Message, messageIndex: number): void => {
    if (!message.toolName) return;
    const descriptor = toolAliasDescriptor(message.toolName);
    const byTool = toolAliasCandidates.get(refs) ?? new Map<string, ToolAliasCandidateGroup>();
    const candidate = byTool.get(descriptor.key) ?? { aliases: descriptor.aliases, messageIndexes: new Set<number>() };
    candidate.messageIndexes.add(messageIndex);
    byTool.set(descriptor.key, candidate);
    toolAliasCandidates.set(refs, byTool);
  };
  const addBlockerEvidence = (kind: ObjectiveBlockerKind, message: Message, messageIndex: number): void => {
    blockers[kind].add(message.id);
    if (message.toolUseId) blockers[kind].add(message.toolUseId);
    if (message.authRequestId) blockers[kind].add(message.authRequestId);
    addAliasCandidate(blockers[kind], message, messageIndex);
  };
  // Exact current acceptance observations may use a deliberately bounded
  // opaque SSH validator that is stricter than the generic shell read grammar.
  // Once the host has matched that immutable invocation and result shape, the
  // read must not invalidate an otherwise current independent review.
  const registeredReadObservationIds = new Set(collectObjectiveAcceptanceObservations(
    objective,
    messages,
  ).filter(observation => !isObjectiveMutationTool(observation.message))
    .map(observation => observation.message.id));
  let lastMutationIndex = -1;
  for (const [index, message] of scoped.entries()) {
    if (message.role === 'tool' && message.toolExecuted !== false
      && !registeredReadObservationIds.has(message.id)
      && isObjectiveEvidenceInvalidatingMutation(message)) {
      lastMutationIndex = index;
    }
  }
  const contentCheckReviewAllowed = lastMutationIndex < 0 && objectiveAllowsContentCheckReview(objective,
    messages.find(message => message.id === objective.userMessageId && message.role === 'user')?.content);
  const addRefs = (refs: Set<string>, message: Message, messageIndex: number): void => {
    refs.add(message.id);
    if (message.toolUseId) refs.add(message.toolUseId);
    addAliasCandidate(refs, message, messageIndex);
  };
  for (const observation of currentObjectiveBlockerObservations(messages, objective)) {
    addBlockerEvidence(observation.kind, observation.message, observation.messageIndex);
  }
  for (const [index, message] of scoped.entries()) {
    const substantiveResult = substantiveToolResult(message);
    if (!substantiveResult) continue;
    addRefs(successful, message, index);
    const afterLatestMutation = index > lastMutationIndex;
    // A generic executor can be a conservative mutation boundary and still
    // return the post-invocation observation (for example a SELECT through an
    // opaque SQL tool). Only its observation can certify itself: a mutating
    // tool that happens to emit review-shaped JSON must not certify a review.
    const observationAtLatestMutation = index === lastMutationIndex
      && observationOrValidationTool(message);
    const binding = objectiveReviewBinding(objective);
    const reviewReceipt = REVIEW_TOOL_PATTERN.test(message.toolName ?? '')
      ? parseIndependentReviewReceipt(substantiveResult, {
        ...binding, toolName: message.toolName ?? '',
        sessionIds: Array.isArray(message.toolInput?.sessionIds)
          && message.toolInput.sessionIds.every(id => typeof id === 'string')
          ? message.toolInput.sessionIds as string[] : undefined,
      })
      : undefined;
    const reviewedCriteria = new Set(reviewReceipt?.criteria.map(criterion => criterion.id));
    const requiredReviewCriteria = [...objective.completionCriteria.filter(criterion => (
      criterion !== 'independent-review-passed'
    )), ...(objective.acceptanceCriteria ?? []).map(criterion => criterion.id)];
    const passedReview = (
      reviewReceipt?.verdict === 'PASS'
      && (!objective.acceptanceCriteria?.length || (reviewReceipt.objectiveId === binding.objectiveId
        && reviewReceipt.acceptanceSha256 === binding.acceptanceSha256))
      && reviewReceipt.findings.length === 0
      && reviewReceipt.criteria.every(criterion => criterion.passed)
    );
    const validReview = passedReview
      && requiredReviewCriteria.every(criterion => reviewedCriteria.has(criterion));
    // Reviewing the content of a response does not require the reviewer to
    // attest that the parent delivered it or has no remaining work. External
    // actions, registered checks and mandatory independent reviews retain the
    // complete contract, even for persisted objectives missing evidence flags.
    const validContentCheckReview = passedReview && contentCheckReviewAllowed
      && reviewedCriteria.has('relevant-checks-passed');
    if (afterLatestMutation && passedReview && !validReview && !validContentCheckReview) {
      const missing = (contentCheckReviewAllowed ? ['relevant-checks-passed'] : requiredReviewCriteria)
        .filter(criterion => !reviewedCriteria.has(criterion));
      for (const ref of [message.id, message.toolUseId, message.toolName ? `tool:${message.toolName}` : undefined]) {
        if (ref) incompleteCheckReviews.set(ref, missing);
      }
    }
    if (observationAtLatestMutation
      || (afterLatestMutation && (observationOrValidationTool(message) || validReview || validContentCheckReview))) {
      addRefs(checks, message, index);
    }
    // call_llm runs through the current session's connection and can inherit
    // the exact same model. Its structured prose is useful as a content check,
    // but it is never independent review evidence. A separate reviewer result
    // (normally collected through wait_sessions) remains required.
    if (afterLatestMutation && validReview
      && !CALL_LLM_TOOL_PATTERN.test(message.toolName ?? '')
      && (reviewNotBefore === undefined || message.timestamp >= reviewNotBefore)) {
      addRefs(review, message, index);
      // A delegated reviewer commonly cites its own final message id in the
      // parent's receipt. Accept that id only when wait_sessions supplied it
      // alongside the uniquely requested, objective/hash-bound PASS above.
      // Arbitrary ids in reviewer prose are discarded by the shared parser.
      if (reviewReceipt.reviewMessageId) review.add(reviewReceipt.reviewMessageId);
    }
  }
  // Exact registered checks can certify short or application-specific results
  // that are intentionally not generic substantive evidence. Project their
  // concrete refs and aliases through the same uniqueness accounting.
  for (const [index, message] of scoped.entries()) {
    if (!acceptanceEvidenceRefs.has(message.id)) continue;
    addRefs(successful, message, index);
    const command = [message.toolInput?.command, message.toolInput?.cmd, message.toolInput?.script]
      .find((value): value is string => typeof value === 'string');
    const registeredShellCheck = isObjectiveShellExecutorToolName(message.toolName ?? '')
      && command !== undefined && isObjectiveShellEvidenceCommand(command);
    if (observationOrValidationTool(message) || registeredShellCheck) addRefs(checks, message, index);
  }
  for (const [refs, candidatesByTool] of toolAliasCandidates) {
    for (const candidate of candidatesByTool.values()) {
      if (candidate.messageIndexes.size === 1) {
        for (const alias of candidate.aliases) refs.add(alias);
      }
    }
  }
  return { successful, checks, review, incompleteCheckReviews, blockers };
}

/** Host-only predicate for the exact current independent-review binding. It
 * intentionally reuses the completion validator's mutation ordering, receipt
 * parser and full-criteria checks instead of trusting child/session status. */
export function hasCurrentObjectiveIndependentReviewPass(
  objective: ActiveSessionObjective,
  messages: Message[],
  reviewNotBefore?: number,
): boolean {
  return hostEvidenceRefs(messages, objective, new Set(), reviewNotBefore).review.size > 0;
}

const AUTHORITY_ONLY_MUTATION_PATTERN = /\b(?:deploy\w*|deplo\w*|publish\w*|publi\w*|restart|redemarr\w*|modify|modification|modifi\w*|write|ecriture|ecri\w*|push|merge|install|configur\w*|activate|activation|reactiv\w*|mutation|mise\s+en\s+production)\b/i;
const AUTHORITY_DEPENDENCY_PATTERN = /\b(?:approval|authorization|permission|sign[ -]?off|business\s+decision|green\s+light|approbation|autorisation|permission|validation\s+humaine|decision\s+metier|feu\s+vert|accord\s+explicite)\b/i;
const SAFE_REMAINING_WORK_PATTERN = /\b(?:inspect|audit|check|verify|read|review|test|status|diagnos\w*|observe|search|list|compare|inspect\w*|audit\w*|verifi\w*|lis|lire|relis|relire|contr[oô]l\w*|statut|diagnosti\w*|observ\w*|recherch\w*|list\w*|compar\w*)\b/i;
const AUTHORITY_MUTATION_ACTION_PATTERNS = [
  /\b(?:deploy\w*|deplo\w*|publish\w*|publi\w*|mise\s+en\s+production)\b/i,
  /\b(?:restart|start|redemarr\w*|demarr\w*|activate|activation|reactiv\w*)\b/i,
  /\b(?:modify|modification|modifi\w*|write|ecriture|ecri\w*|mutation|configur\w*)\b/i,
  /\binstall\w*\b/i,
  /\bpush\w*\b/i,
  /\bmerge\w*\b/i,
] as const;
const AUTHORITY_TARGET_GENERIC_TOKENS = new Set([
  'app', 'application', 'component', 'composant', 'environment', 'environnement',
  'after', 'and', 'apres', 'approval', 'approbation', 'authorization', 'autorisation', 'avant', 'before',
  'cette', 'check', 'cible', 'dans', 'decision', 'deployment', 'deploiement', 'des', 'effectue', 'effectuer',
  'explicit', 'explicite', 'for', 'green', 'humain', 'humaine', 'install', 'installation', 'les', 'mise',
  'mutation', 'nothing', 'only', 'permission', 'pour', 'production', 'publish', 'publication', 'puis',
  'project', 'projet', 'restart', 'rien', 'server', 'serveur', 'service', 'sign', 'sous', 'staging', 'strictement', 'sur',
  'system', 'systeme', 'version',
  'then', 'this', 'une', 'uniquement', 'validation', 'verifie', 'verifier', 'vert', 'with', 'write',
]);
const AUTHORITY_ENVIRONMENT_PATTERNS = [
  /\b(?:prod|production)\b/i,
  /\b(?:stage|staging|preprod|preproduction|recette)\b/i,
  /\b(?:dev|development|developpement)\b/i,
  /\b(?:local|localhost)\b/i,
] as const;

function normalizedAuthorityText(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '').toLowerCase();
}

function authorityMutationActionIndexes(text: string): Set<number> {
  const normalized = normalizedAuthorityText(text);
  return new Set(AUTHORITY_MUTATION_ACTION_PATTERNS.flatMap((pattern, index) => (
    pattern.test(normalized) ? [index] : []
  )));
}

function authorityEnvironmentIndexes(text: string): Set<number> {
  const normalized = normalizedAuthorityText(text);
  return new Set(AUTHORITY_ENVIRONMENT_PATTERNS.flatMap((pattern, index) => (
    pattern.test(normalized) ? [index] : []
  )));
}

function authorityTargetTerms(text: string): Set<string> {
  const normalized = normalizedAuthorityText(text);
  return new Set((normalized.match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []).filter(token => (
    !AUTHORITY_TARGET_GENERIC_TOKENS.has(token)
    && !AUTHORITY_MUTATION_ACTION_PATTERNS.some(pattern => pattern.test(token))
    && !AUTHORITY_ENVIRONMENT_PATTERNS.some(pattern => pattern.test(token))
  )));
}

function remainingAuthorityTargetMatches(originalObjectiveText: string, remainingWork: string): boolean {
  const originalEnvironments = authorityEnvironmentIndexes(originalObjectiveText);
  const remainingEnvironments = authorityEnvironmentIndexes(remainingWork);
  if (originalEnvironments.size > 0 && remainingEnvironments.size > 0
    && ![...remainingEnvironments].some(environment => originalEnvironments.has(environment))) return false;
  const originalTerms = authorityTargetTerms(originalObjectiveText);
  const remainingTerms = authorityTargetTerms(remainingWork);
  if (remainingTerms.size > 0) return [...remainingTerms].every(term => originalTerms.has(term));
  if (originalTerms.size > 0) return false;
  return [...remainingEnvironments].some(environment => originalEnvironments.has(environment));
}

function authorityOnlyRemainingWork(remainingWork: readonly string[], originalObjectiveText: string): boolean {
  const originalActions = authorityMutationActionIndexes(originalObjectiveText);
  if (remainingWork.length === 0 || originalActions.size === 0) return false;
  return remainingWork.every(item => {
    const normalized = normalizedAuthorityText(item);
    if (SAFE_REMAINING_WORK_PATTERN.test(normalized)) return false;
    const remainingActions = authorityMutationActionIndexes(normalized);
    return (AUTHORITY_ONLY_MUTATION_PATTERN.test(normalized)
        || AUTHORITY_DEPENDENCY_PATTERN.test(normalized))
      && remainingActions.size > 0
      && [...remainingActions].some(action => originalActions.has(action))
      && remainingAuthorityTargetMatches(originalObjectiveText, normalized);
  });
}

/**
 * A direct user can intentionally withhold authority in a later amendment to
 * an earlier mutation mission. A read-only root is never such a handoff, and
 * the remaining action and target must still bind to that original mission.
 * Admit the handoff only when every immutable, target-bound preflight criterion
 * has a fresh passing observation. Mutations before the boundary remain
 * covered by those later checks; a mutation in the read-only phase rejects the
 * handoff. This prevents prose plus an unrelated read from inventing a blocker.
 */
function explicitReadOnlyAuthorityBlocker(
  declaration: ObjectiveOutcomeDeclaration,
  objective: ActiveSessionObjective,
  messages: Message[],
  expectedSessionId?: string,
): boolean {
  if (declaration.state !== 'blocked_human'
    || declaration.blocker?.kind !== 'external_authorization') return false;
  const boundary = currentExplicitReadOnlyAuthorityBoundary(objective, messages);
  const originalObjectiveText = findObjectiveText(messages, objective);
  if (!boundary || boundary.messageId === objective.userMessageId || !originalObjectiveText?.trim()) return false;
  const originalObjective = transitionObjectiveContract({
    messageId: objective.userMessageId,
    text: originalObjectiveText,
    delegatedRole: objective.delegatedRole,
    nowMs: objective.startedAt,
  });
  if (!objectiveRequiresExecutionEvidence(originalObjective, originalObjectiveText)
    || objectiveRequiresExecutionEvidence(objective, originalObjectiveText)
    || !authorityOnlyRemainingWork(declaration.remainingWork, originalObjectiveText)) return false;
  if (!declaration.blocker.evidence.includes(boundary.messageId)) return false;
  const rootIndex = messages.findIndex(message => message.id === objective.userMessageId && message.role === 'user');
  const boundaryIndexes = messages.flatMap((message, index) => message.id === boundary.messageId
    && message.role === 'user' && !message.hidden && !message.internalOrigin
    && !message.agentDelivery && !message.isQueued && !message.isPending ? [index] : []);
  if (rootIndex < 0 || boundaryIndexes.length !== 1 || boundaryIndexes[0]! <= rootIndex) return false;
  const boundaryIndex = boundaryIndexes[0]!;
  const readOnlyPhase = messages.slice(boundaryIndex + 1);
  if (readOnlyPhase.some(message => message.role === 'tool' && message.toolExecuted !== false
    && isObjectiveMutationTool(message))) return false;
  if (objective.acceptanceNeedsReview) return false;
  const criteria = projectObjectiveAcceptanceCriteria(objective, messages).criteria;
  if (criteria.length === 0) return false;
  const observations = collectObjectiveAcceptanceObservations(objective, messages, expectedSessionId)
    .filter(observation => observation.passed && messages.indexOf(observation.message) > boundaryIndex);
  return criteria.every(criterion => observations.some(observation => observation.criterionId === criterion.id));
}

function currentAutonomyBlockerEvents(
  events: readonly AutonomyEvent[], objective: ActiveSessionObjective, messages: readonly Message[],
): AutonomyEvent[] {
  const scoped = events.filter(event => event.timestamp >= objective.startedAt);
  return scoped.filter((event, index) => {
    if (event.phase !== 'escalated' || !event.escalationReason) return false;
    if (event.escalationReason === 'business_decision_required') {
      // A subsequent real user turn may carry the missing decision. Require
      // the host to reassess rather than treating the historical event as a
      // durable terminal blocker receipt.
      return !messages.some(message => message.role === 'user'
        && message.id !== objective.userMessageId && message.timestamp >= event.timestamp
        && !message.hidden && !message.internalOrigin);
    }
    if (!event.toolName) return true;
    const toolKey = toolAliasDescriptor(event.toolName).key;
    return !scoped.slice(index + 1).some(candidate => candidate.phase === 'verified'
      && !!candidate.toolName && toolAliasDescriptor(candidate.toolName).key === toolKey);
  });
}

function addAutonomyBlockerRefs(
  blockers: Record<ObjectiveBlockerKind, Set<string>>,
  currentEvents: readonly AutonomyEvent[],
): void {
  for (const event of currentEvents) {
    // Tool/auth escalation events lack the persisted target/request/auth
    // identity needed to prove that a blocker is still current. They remain a
    // conservative completion gate below, but cannot be cited as terminal
    // blocker evidence. A business decision is host-owned and stays current
    // only until the next real user turn.
    if (event.escalationReason === 'business_decision_required') blockers.business_decision.add(event.id);
  }
}

/** Validate model intent against host-observed evidence; declarations alone never prove completion. */
export function validateObjectiveOutcome(
  declaration: ObjectiveOutcomeDeclaration | undefined,
  options: {
    objective: ActiveSessionObjective;
    messages: Message[];
    /** Host-owned session identity used to bind spill artifacts to this transcript. */
    sessionId?: string;
    extractionError?: string;
    evidenceGap?: string;
    executionEvidenceMissing?: boolean;
    autonomyEvents?: readonly AutonomyEvent[];
    /** True only while the host owns an unresolved structured question,
     * authentication flow or scoped permission request for this session. */
    pendingHumanConfirmation?: boolean;
    /** Legacy turns cannot safely spend another automatic attempt. Preserve
     * only an earlier host-validated continuation if it still validates now. */
    preservedContinueOnLegacyBudget?: boolean;
  },
): ObjectiveOutcomeValidation {
  const gaps: string[] = [];
  if (options.extractionError) gaps.push(options.extractionError);
  if (!declaration) {
    const prior = options.objective.lastOutcome;
    if (options.preservedContinueOnLegacyBudget && !options.extractionError
      && prior?.state === 'continue') {
      const priorValidation = validateObjectiveOutcome(prior, {
        ...options, preservedContinueOnLegacyBudget: false,
      });
      if (priorValidation.valid && priorValidation.state === 'continue') {
        return {
          state: 'continue', valid: true, gaps: [],
          effectiveDeclaration: priorValidation.effectiveDeclaration ?? prior,
          preservedFromPriorOutcome: true,
        };
      }
    }
    gaps.push('missing structured objective outcome receipt');
    return { state: 'continue', valid: false, gaps };
  }

  const acceptanceEvidenceRefs = collectObjectiveAcceptanceEvidenceRefs(
    options.objective, options.messages, declaration, options.sessionId,
  );
  const reviewNotBefore = options.objective.terminalReconciliation
      ?.initialAcceptanceRegistrationRequired === true
    ? options.objective.acceptanceRegisteredAt
    : undefined;
  const refs = hostEvidenceRefs(
    options.messages,
    options.objective,
    acceptanceEvidenceRefs,
    reviewNotBefore,
  );
  const currentAutonomyBlockers = currentAutonomyBlockerEvents(
    options.autonomyEvents ?? [], options.objective, options.messages,
  );
  addAutonomyBlockerRefs(refs.blockers, currentAutonomyBlockers);
  const derived = !options.extractionError && !options.evidenceGap && !options.executionEvidenceMissing
    && currentAutonomyBlockers.length === 0
    && Object.values(refs.blockers).every(evidence => evidence.size === 0)
    ? deriveNativeQuestionOutcome(declaration, options.objective, options.messages) : undefined;
  if (derived) declaration = derived;
  if (declaration.state === 'complete_verified') {
    for (const ref of nativeQuestionCompletionRefs(options.objective, options.messages)) refs.checks.add(ref);
  }
  const criteria = new Map<string, { satisfied: boolean; evidence: string[] }>();
  for (const criterion of declaration.criteria) {
    if (criteria.has(criterion.id)) gaps.push(`duplicate criterion: ${criterion.id}`);
    criteria.set(criterion.id, criterion);
  }

  if (declaration.state === 'continue') {
    if (declaration.blocker) gaps.push('continue requires blocker:null');
    if (declaration.remainingWork.length === 0) gaps.push('continue requires remainingWork');
    if (declaration.remainingWork.some(item => !concreteRemainingWork(item))) {
      gaps.push('continue requires concrete, non-placeholder remainingWork');
    }
    if (whollyDependentOnExternalWait(declaration.remainingWork)) {
      gaps.push('continue cannot represent a passive external wait; use blocked_human with matching host-observed blocker evidence');
    }
    if (claimsPendingHumanConfirmation(declaration.remainingWork)
      && options.pendingHumanConfirmation !== true) {
      gaps.push('remainingWork claims a pending human confirmation, but no structured question, authentication flow, or permission request is pending');
    }
    const acceptanceCriterionIds = new Set(projectObjectiveAcceptanceCriteria(
      options.objective, options.messages,
    ).criteria.map(criterion => criterion.id));
    const knownCriterionIds = new Set([
      ...options.objective.completionCriteria,
      ...acceptanceCriterionIds,
    ]);
    for (const criterion of declaration.criteria) {
      if (!knownCriterionIds.has(criterion.id)) {
        gaps.push(`unknown criterion: ${criterion.id}`);
        continue;
      }
      if (!criterion.satisfied) continue;
      if (criterion.id === 'no-safe-work-remaining') {
        // `continue` and concrete remaining work are authoritative. Models
        // occasionally copy the terminal criterion template unchanged; retain
        // the checkpoint without turning that contradiction into a costly
        // retry or persisting a false terminal claim.
        continue;
      }
      if (acceptanceCriterionIds.has(criterion.id)) {
        const matched = collectObjectiveAcceptanceEvidenceRefs(options.objective, options.messages, {
          ...declaration, criteria: [criterion],
        }, options.sessionId);
        if (matched.size === 0) gaps.push(`criterion lacks observed evidence: ${criterion.id}`);
        continue;
      }
      const allowedRefs = criterion.id === 'independent-review-passed'
        ? refs.review
        : criterion.id === 'relevant-checks-passed'
          ? refs.checks
          : refs.successful;
      if (!criterion.evidence.some(ref => allowedRefs.has(ref))) {
        gaps.push(`criterion lacks observed evidence: ${criterion.id}`);
      }
    }
    // A concrete `continue` receipt is an in-progress checkpoint, not a claim
    // that the requested mutation already happened. Requiring execution proof
    // here rejects the very first honest checkpoint before the remaining work
    // can run. The pre-tool gate still enforces authoritative evidence before
    // any mutation, while every criterion claimed by this checkpoint remains
    // host-validated above. A missing or failing independent review is likewise
    // actionable remaining work, not a reason to reject the continuation that
    // will correct its findings. Evidence and execution proof remain mandatory
    // for complete_verified below.
    const copiedTerminalCriterion = declaration.criteria.some(criterion => (
      criterion.id === 'no-safe-work-remaining' && (criterion.satisfied || criterion.evidence.length > 0)
    ));
    const effectiveDeclaration: ObjectiveOutcomeDeclaration | undefined = copiedTerminalCriterion
      ? {
        ...declaration,
        criteria: declaration.criteria.map(criterion => criterion.id === 'no-safe-work-remaining'
          ? { ...criterion, satisfied: false, evidence: [] }
          : { ...criterion, evidence: [...criterion.evidence] }),
        remainingWork: [...declaration.remainingWork],
        blocker: null,
      }
      : undefined;
    return {
      state: 'continue', valid: gaps.length === 0, gaps,
      ...(gaps.length === 0 && effectiveDeclaration ? { effectiveDeclaration } : {}),
    };
  }

  if (declaration.state === 'blocked_human' || declaration.state === 'blocked_policy') {
    if (!declaration.blocker) {
      gaps.push(`${declaration.state} requires a blocker receipt`);
    } else {
      const kindValid = declaration.state === 'blocked_policy'
        ? declaration.blocker.kind === 'policy'
        : HUMAN_BLOCKER_KINDS.has(declaration.blocker.kind);
      if (!kindValid) gaps.push(`invalid blocker kind for ${declaration.state}`);
      const observedBlockerRefs = refs.blockers[declaration.blocker.kind];
      const readOnlyAuthority = kindValid && explicitReadOnlyAuthorityBlocker(
        declaration, options.objective, options.messages, options.sessionId,
      );
      if (!declaration.blocker.evidence.some(ref => observedBlockerRefs.has(ref))
        && !readOnlyAuthority) {
        gaps.push('blocker evidence does not reference a matching host-observed blocker');
      }
    }
    return { state: gaps.length === 0 ? declaration.state : 'continue', valid: gaps.length === 0, gaps };
  }

  if (declaration.blocker) gaps.push('complete_verified cannot include a blocker');
  gaps.push(...validateObjectiveAcceptanceCriteria(
    options.objective, options.messages, declaration, options.sessionId,
  ));
  if (declaration.remainingWork.length > 0) gaps.push('complete_verified cannot include remainingWork');
  for (const expected of options.objective.completionCriteria) {
    const receipt = criteria.get(expected);
    if (!receipt) {
      gaps.push(`missing criterion: ${expected}`);
      continue;
    }
    if (!receipt.satisfied) gaps.push(`unsatisfied criterion: ${expected}`);
    const allowedRefs = expected === 'independent-review-passed'
      ? refs.review
      : expected === 'relevant-checks-passed'
        ? refs.checks
        : refs.successful;
    if (!receipt.evidence.some(ref => allowedRefs.has(ref))) {
      gaps.push(`criterion lacks observed evidence: ${expected}`);
      if (expected === 'relevant-checks-passed') {
        const missing = [...new Set(receipt.evidence.flatMap(ref => refs.incompleteCheckReviews.get(ref) ?? []))];
        if (missing.length > 0) {
          gaps.push(`Cited review receipt is missing exact host criterion IDs: ${missing.join(', ')}. Review the existing deliverable and return those IDs; do not repeat its external actions.`);
        }
      }
    }
  }
  if (options.evidenceGap) gaps.push(options.evidenceGap);
  if (options.executionEvidenceMissing) gaps.push('required execution evidence is missing');
  return { state: gaps.length === 0 ? 'complete_verified' : 'continue', valid: gaps.length === 0, gaps,
    ...(gaps.length === 0 && derived ? { declaration: derived } : {}) };
}
