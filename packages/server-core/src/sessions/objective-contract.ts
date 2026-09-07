import { createHash } from 'node:crypto';
import type { Message } from '@craft-agent/core/types';
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions';
import { classifyToolNameMutationSemantics } from '@craft-agent/shared/agent';
import { isContextDependentDirectTurn } from '@craft-agent/shared/config/agent-cost-control';
import { classifyLocalRoutingRequirements } from '@craft-agent/shared/config/routing-policy';

const HIGH_STAKES_DOMAIN_PATTERN = /\b(?:legal|law|juridique|droit|nda|non[- ]disclosure|contrat|compliance|conformit[ée]|medical|m[ée]dical|sant[ée]|financial|finance|accounting|comptab\w*|fiscal\w*|tax|security|s[ée]curit[ée]|credential|secret|permission|rbac)\b/i;
const MULTI_STEP_PATTERN = /\b(?:puis|ensuite|et\s+(?:v[ée]rifie|teste|corrige|impl[ée]mente|d[ée]ploie)|tous\s+les\s+points|l['’]ensemble\s+de\s+ces\s+points|de\s+bout\s+en\s+bout|end[- ]to[- ]end|multi[- ]?[ée]tapes?)\b/i;
const EXECUTION_REQUEST_PATTERN = /\b(?:build|create|write|change|modify|correct|fix|implement|apply|install|deploy|publish|delete|remove|cr[ée](?:e|er)|r[ée]dig\w*|[ée]cri\w*|modifi\w*|corrig\w*|impl[ée]ment\w*|implant\w*|appliqu\w*|install\w*|d[ée]ploi\w*|publi\w*|supprim\w*|r[ée]alis\w*|correction(?:s)?)\b/i;
const EXPLICIT_NEW_OBJECTIVE_PATTERN = /(?:\b(?:nouvel(?:le)?|nouveau|autre|different(?:e)?)\s+(?:objectif|mission|tache|demande|sujet|projet|document|fichier|dossier)\b|\b(?:new|another|different)\s+(?:objective|mission|task|request|topic|project|document|file)\b|\b(?:changeons|changez?|passons?)\s+(?:de\s+)?(?:sujet|objectif|mission|tache)\b|\b(?:switch|move)\s+to\s+(?:a\s+)?(?:new|another)\s+(?:objective|task|topic)\b)/i;
const CONTINUATION_FILLER_PATTERN = /^(?:(?:bah|ben|bon|alors|donc|non|ok|okay|oui|yes|daccord|vas\s+y|allez\s+y)\s+)*(?:et\s+)?(.+)$/i;
const CONTINUATION_REFERENCE_PATTERN = /(?:\b(?:encore|aussi|precedent|precedente|above|again|remaining|restant\w*)\b|\b(?:la\s+suite|le\s+reste)\b)/i;
const CONTINUATION_REOPEN_PATTERN = /(?:\b(?:pas|not)\s+(?:termine|fini|fait|complet|verified|done|finished)\b|\b(?:il\s+manque|tu\s+nas\s+pas|ca\s+ne\s+(?:marche|fonctionne)\s+pas|keep\s+going|carry\s+on)\b)/i;
const CONTINUATION_VERBS = [
  'avance', 'continue', 'continuer', 'poursuis', 'poursuit', 'poursuivre',
  'reprend', 'reprends', 'reprendre',
] as const;

const OBSERVATION_TARGET_KEY_PATTERN = /^(?:action|cmd|command|file|file_path|filename|id|key|operation|path|pattern|q|query|ref_id|resource|search|search_query|sessionId|target|threadId|uri|url)$/i;
const MUTATION_TRANSFORM_KEY_PATTERN = /^(?:body|content|data|diff|edits|new_string|newText|old_string|oldText|patch|payload|replacement|text|value)$/i;
const PASSIVE_NO_PROGRESS_TOOL_PATTERN = /(?:^|[_:\-.])(?:wait|sleep|reload|refresh)(?:$|[_:\-.])/i;
const PASSIVE_NO_PROGRESS_ACTION_PATTERN = /^(?:wait|sleep|poll|reload|refresh)(?:\b|_)/i;
const NON_EXECUTED_CHECKPOINT_PATTERN = /(?:\bcost guard(?: checkpoint)?\s*:|\bwas not started\b|\btool-call (?:budget|checkpoint)\b.{0,120}\b(?:blocked|not (?:started|executed))\b)/i;
const NON_SUBSTANTIVE_TOOL_RESULT_PATTERN = /^(?:\[?auto[- ]?completed\]?|completed automatically|tool completed|completed|done|ok|success)$/i;
const GENERIC_EXECUTE_TOOL_PATTERN = /(?:^|[_:\-.])(?:exec|execute)(?:$|[_:\-.])/i;
const MUTATION_ACTION_PATTERN = /^(?:apply|archive|cancel|commit|create|delete|deploy|edit|install|merge|move|publish|remove|rename|restart|send|submit|update|write)(?:$|[_:\-.])/i;
const MUTATION_HTTP_METHOD_PATTERN = /^(?:DELETE|PATCH|POST|PUT)$/i;
const MUTATION_SQL_PATTERN = /^\s*(?:ALTER|CREATE|DELETE|DROP|GRANT|INSERT|MERGE|REPLACE|REVOKE|TRUNCATE|UPDATE|UPSERT)\b/i;
const MAX_CANONICAL_INPUT_CHARS = 4_096;
const MAX_RESULT_DIGEST_CHARS = 16_384;
const MAX_TRANSFORM_DIGEST_CHARS = 16_384;

export const OBJECTIVE_OUTCOME_CONTINUE_EXAMPLE =
  '<!-- robb_objective_outcome {"state":"continue","criteria":[],"remainingWork":["describe the next concrete step"],"blocker":null} -->';

export interface ObjectiveTransitionInput {
  existing?: ActiveSessionObjective;
  messageId: string;
  text: string;
  lifetimeCostUsd?: number;
  lifetimeTokens?: number;
  nowMs?: number;
}

function foldForIntent(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, '')
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function editDistanceWithin(left: string, right: string, limit: number): boolean {
  if (Math.abs(left.length - right.length) > limit) return false;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const value = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > limit) return false;
    previous = current;
  }
  return (previous[right.length] ?? limit + 1) <= limit;
}

function looksLikeContinuation(text: string): boolean {
  if (isContextDependentDirectTurn(text)) return true;
  const folded = foldForIntent(text);
  const withoutFiller = folded.match(CONTINUATION_FILLER_PATTERN)?.[1] ?? folded;
  const [firstWord = ''] = withoutFiller.split(/\s+/);
  const typoTolerance = firstWord.length >= 5 ? 2 : 1;
  return CONTINUATION_REFERENCE_PATTERN.test(withoutFiller)
    || CONTINUATION_REOPEN_PATTERN.test(withoutFiller)
    || CONTINUATION_VERBS.some(verb => editDistanceWithin(firstWord, verb, typoTolerance));
}

function startsExplicitNewObjective(text: string): boolean {
  return EXPLICIT_NEW_OBJECTIVE_PATTERN.test(foldForIntent(text));
}

export function transitionObjectiveContract(input: ObjectiveTransitionInput): ActiveSessionObjective {
  const nowMs = input.nowMs ?? Date.now();
  const preserveExisting = input.existing
    && !startsExplicitNewObjective(input.text)
    && looksLikeContinuation(input.text);
  if (input.existing && preserveExisting) {
    return {
      ...input.existing,
      objectiveId: input.existing.objectiveId ?? input.existing.userMessageId,
      lastUserMessageId: input.messageId,
      continuationCount: input.existing.continuationCount + 1,
      terminalState: 'active',
      completedAt: undefined,
      lastOutcome: undefined,
    };
  }

  const difficulty = classifyLocalRoutingRequirements({ text: input.text }).difficulty ?? 'standard';
  const highStakes = HIGH_STAKES_DOMAIN_PATTERN.test(input.text);
  const requiresExecutionEvidence = EXECUTION_REQUEST_PATTERN.test(input.text);
  const requiresObservationEvidence = /\b(?:inspect\w*|audit\w*|v[ée]rifi\w*|contr[oô]l\w*|check|verify)\b/i.test(input.text);
  const mission = highStakes || difficulty === 'complex' || MULTI_STEP_PATTERN.test(input.text);
  const completionCriteria: ActiveSessionObjective['completionCriteria'] = [
    'requested-outcome-delivered',
    'relevant-checks-passed',
    'no-safe-work-remaining',
  ];
  if (highStakes) completionCriteria.push('independent-review-passed');

  return {
    schemaVersion: 1,
    originalText: input.text,
    ...(requiresExecutionEvidence || requiresObservationEvidence ? { requiresAcceptanceCriteria: true } : {}),
    ...(requiresObservationEvidence ? { requiresObservationEvidence: true } : {}),
    objectiveId: input.messageId,
    userMessageId: input.messageId,
    lastUserMessageId: input.messageId,
    startedAt: nowMs,
    budgetBaselineUsd: Math.max(0, input.lifetimeCostUsd ?? 0),
    tokenBaseline: Math.max(0, input.lifetimeTokens ?? 0),
    continuationCount: 0,
    orchestrationMode: mission ? 'mission' : 'direct',
    risk: highStakes ? 'high-stakes' : 'standard',
    ...(requiresExecutionEvidence ? { requiresExecutionEvidence: true } : {}),
    ...(highStakes && requiresExecutionEvidence
      ? { evidenceRequirement: 'authoritative-sources-before-mutation' as const }
      : {}),
    completionCriteria,
    terminalState: 'active',
  };
}

export function objectiveCostUsd(
  objective: ActiveSessionObjective | undefined,
  lifetimeCostUsd: number | undefined,
): number {
  const lifetime = Math.max(0, lifetimeCostUsd ?? 0);
  return objective ? Math.max(0, lifetime - objective.budgetBaselineUsd) : lifetime;
}

export function findObjectiveText(
  messages: Message[],
  objective: ActiveSessionObjective | undefined,
): string | undefined {
  if (!objective) return undefined;
  return objective.originalText ?? messages.find(message => (
    message.id === objective.userMessageId && message.role === 'user'
  ))?.content;
}

function stableValue(value: unknown, depth = 0): unknown {
  if (depth >= 5) return '[depth-limit]';
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim().slice(0, 2_048);
  if (Array.isArray(value)) return value.slice(0, 64).map(child => stableValue(child, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 64)
      .map(([key, child]) => [key, stableValue(child, depth + 1)]),
  );
}

function normalizedToolTarget(input: Record<string, unknown> | undefined): string {
  if (!input) return '{}';
  const targetEntries = Object.entries(input)
    .filter(([key]) => OBSERVATION_TARGET_KEY_PATTERN.test(key));
  const source = targetEntries.length > 0 ? Object.fromEntries(targetEntries) : input;
  try {
    return JSON.stringify(stableValue(source)).slice(0, MAX_CANONICAL_INPUT_CHARS);
  } catch {
    return '[unserializable-input]';
  }
}

function resultDigest(message: Message): string {
  const raw = message.toolResult ?? message.content ?? '';
  const normalized = raw.replace(/\r\n/g, '\n').trim();
  const bounded = normalized.length <= MAX_RESULT_DIGEST_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_RESULT_DIGEST_CHARS / 2)}\n[...bounded...]\n${normalized.slice(-MAX_RESULT_DIGEST_CHARS / 2)}`;
  return createHash('sha256').update(bounded).digest('hex').slice(0, 16);
}

function mutationTransformDigest(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  const transformEntries = Object.entries(input)
    .filter(([key]) => MUTATION_TRANSFORM_KEY_PATTERN.test(key));
  if (transformEntries.length === 0) return undefined;
  let canonical: string;
  try {
    canonical = JSON.stringify(stableValue(Object.fromEntries(transformEntries)));
  } catch {
    canonical = '[unserializable-transform]';
  }
  const bounded = canonical.length <= MAX_TRANSFORM_DIGEST_CHARS
    ? canonical
    : `${canonical.slice(0, MAX_TRANSFORM_DIGEST_CHARS / 2)}[...bounded...]${canonical.slice(-MAX_TRANSFORM_DIGEST_CHARS / 2)}`;
  return createHash('sha256').update(bounded).digest('hex').slice(0, 16);
}

function isPassiveNoProgressTool(message: Message): boolean {
  const toolName = message.toolName ?? '';
  if (PASSIVE_NO_PROGRESS_TOOL_PATTERN.test(toolName)) return true;
  if (/^(?:write_stdin|read_thread_terminal)$/i.test(toolName)) {
    const chars = message.toolInput?.chars;
    if (chars === undefined || chars === '') return true;
  }
  const action = [message.toolInput?.action, message.toolInput?.command, message.toolInput?.operation]
    .find((value): value is string => typeof value === 'string');
  return action ? PASSIVE_NO_PROGRESS_ACTION_PATTERN.test(action.trim()) : false;
}

export function isObjectiveToolExecutedSuccessfully(message: Message): boolean {
  if (message.role !== 'tool' || message.toolStatus !== 'completed' || message.isError) return false;
  const runtimeMessage = message as Message & {
    continuationRequired?: boolean;
    toolExecutionStatus?: 'executed' | 'not-executed' | string;
  };
  if (
    message.toolExecuted === false
    || message.toolCheckpoint !== undefined
    || runtimeMessage.continuationRequired
    || runtimeMessage.toolExecutionStatus === 'not-executed'
  ) return false;
  const output = message.toolResult ?? message.content ?? '';
  return !NON_EXECUTED_CHECKPOINT_PATTERN.test(output);
}

/** True only for a real completed invocation whose persisted result can serve as evidence. */
export function hasObjectiveSubstantiveToolResult(message: Message): boolean {
  if (!isObjectiveToolExecutedSuccessfully(message)) return false;
  // `content` is only a UI label. Safety-net completion can mark a child tool
  // completed without ever receiving a genuine tool_result, leaving this empty.
  const result = message.toolResult?.trim();
  return !!result && !NON_SUBSTANTIVE_TOOL_RESULT_PATTERN.test(result);
}

export function isObjectiveMutationTool(message: Message): boolean {
  const toolName = message.toolName ?? '';
  if (/^(?:mcp__session__)?(?:set_completion_criteria|project_learning)$/.test(toolName)) return false;
  const usesInputSemantics = GENERIC_EXECUTE_TOOL_PATTERN.test(toolName)
    || /^(?:Bash|Shell)$/i.test(toolName);
  if (!usesInputSemantics) {
    return classifyToolNameMutationSemantics(toolName) === 'mutation';
  }
  const input = message.toolInput ?? {};
  const action = [input.action, input.operation]
    .find((value): value is string => typeof value === 'string');
  if (action && MUTATION_ACTION_PATTERN.test(action.trim())) return true;
  const method = input.method;
  if (typeof method === 'string' && MUTATION_HTTP_METHOD_PATTERN.test(method.trim())) return true;
  const query = [input.query, input.sql, input.statement]
    .find((value): value is string => typeof value === 'string');
  if (query && MUTATION_SQL_PATTERN.test(query)) return true;
  const command = [message.toolInput?.command, message.toolInput?.cmd, message.toolInput?.script]
    .find((value): value is string => typeof value === 'string') ?? '';
  return MUTATION_BASH_PATTERN.test(command);
}

export interface TurnProgressFingerprints {
  /** Combined backwards-compatible fingerprint consumed by turn recovery. */
  fingerprint: string;
  /** Semantic observations: tool + normalized target/query + bounded result digest. */
  evidenceProgress: string;
  /** Confirmed mutations, kept separate from observational evidence. */
  executionProgress: string;
  evidenceCount: number;
  executionCount: number;
}

/** Stable semantic progress signals. Repeated reads, waits and unexecuted checkpoints do not advance them. */
export function turnProgressFingerprints(messages: Message[], userMessageId: string): TurnProgressFingerprints {
  const userIndex = messages.findIndex(message => message.id === userMessageId && message.role === 'user');
  if (userIndex < 0) {
    return {
      fingerprint: 'missing-objective',
      evidenceProgress: 'missing-objective',
      executionProgress: 'missing-objective',
      evidenceCount: 0,
      executionCount: 0,
    };
  }
  const evidence = new Set<string>();
  const execution = new Set<string>();
  for (const message of messages.slice(userIndex + 1)) {
    if (!isObjectiveToolExecutedSuccessfully(message) || isPassiveNoProgressTool(message)) continue;
    const mutation = isObjectiveMutationTool(message);
    const transformDigest = mutation ? mutationTransformDigest(message.toolInput) : undefined;
    const signal = [
      (message.toolName ?? 'tool').toLowerCase(),
      normalizedToolTarget(message.toolInput),
      ...(transformDigest ? [`transform:${transformDigest}`] : []),
      resultDigest(message),
    ].join(':');
    (mutation ? execution : evidence).add(signal);
  }
  const evidenceSignals = [...evidence].sort().join('|');
  const executionSignals = [...execution].sort().join('|');
  const evidenceProgress = createHash('sha256').update(evidenceSignals).digest('hex').slice(0, 16);
  const executionProgress = createHash('sha256').update(executionSignals).digest('hex').slice(0, 16);
  return {
    fingerprint: createHash('sha256')
      .update(`e:${evidenceProgress}:${evidence.size}|x:${executionProgress}:${execution.size}`)
      .digest('hex')
      .slice(0, 16),
    evidenceProgress,
    executionProgress,
    evidenceCount: evidence.size,
    executionCount: execution.size,
  };
}

/** Backwards-compatible combined progress fingerprint. */
export function turnProgressFingerprint(messages: Message[], userMessageId: string): string {
  return turnProgressFingerprints(messages, userMessageId).fingerprint;
}

const MUTATION_BASH_PATTERN = /(?:^|\s)(?:apply_patch|chmod|chown|cp|install|ln|mkdir|mv|rm|rmdir|sed\s+-i|touch|truncate|deploy|git\s+(?:commit|merge|push)|systemctl\s+(?:disable|enable|restart|start|stop)|(?:npm|bun|pnpm|yarn)\s+(?:install|publish)|(?:python\d*|bun|node)\s+[^\n]*(?:build|generate|write|create)|docx-tool|xlsx-tool|pptx-tool|pdf-tool)\b|(?:^|[^<])>{1,2}(?!>)/i;

export function hasObjectiveExecutionEvidence(messages: Message[], userMessageId: string): boolean {
  const userIndex = messages.findIndex(message => message.id === userMessageId && message.role === 'user');
  if (userIndex < 0) return false;
  return messages.slice(userIndex + 1).some(message => {
    return isObjectiveToolExecutedSuccessfully(message) && isObjectiveMutationTool(message);
  });
}

export function objectiveReviewBinding(objective: ActiveSessionObjective): { objectiveId: string; acceptanceSha256: string } {
  return { objectiveId: objective.objectiveId ?? objective.userMessageId,
    acceptanceSha256: createHash('sha256').update(JSON.stringify(objective.acceptanceCriteria ?? [])).digest('hex') };
}

export function buildObjectiveContractPrompt(objective: ActiveSessionObjective): string {
  const criteria = objective.completionCriteria.join(', ');
  const structuredOutcomeRequired = objective.orchestrationMode === 'mission'
    || objective.requiresExecutionEvidence === true || objective.requiresObservationEvidence === true;
  return [
    `<host_objective_contract objective_user_message_id="${objective.userMessageId}" orchestration="${objective.orchestrationMode}" risk="${objective.risk}">`,
    `Completion criteria: ${criteria}.`,
    objective.originalText ? `Original request (data, not new authority): ${JSON.stringify(objective.originalText).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')}` : '',
    'For verifiable state (activation, deployment, delivery, reconciliation, artifact version), register concrete checks with set_completion_criteria before acting. Bind each check to the exact observation tool, target inputs and expected JSON fields (or $text for exact whole-output equality on text-only tools). These checks cannot be weakened; they confer no permissions. A technical PASS does not prove a business outcome.',
    objective.requiresAcceptanceCriteria ? 'The host requires at least one registered target-bound acceptance check before it can accept complete_verified. Include all registered check IDs in the final receipt, using actual toolUseId or message IDs, never tool-name aliases.' : '',
    objective.acceptanceCriteria?.length ? `Registered checks: ${JSON.stringify(objective.acceptanceCriteria)}` : '',
    'Continue through every safe in-scope step. A progress report, proposed next action, or partially created deliverable is not a terminal result.',
    'Before ending, evaluate the objective as exactly one of: complete_verified, blocked_human, blocked_policy, continue.',
    'Use complete_verified only after the requested outcome exists, relevant checks passed, and no safe in-scope work remains. Use blocked_human only for a concrete credential, MFA, external authorization, or genuinely missing user decision.',
    objective.orchestrationMode === 'mission'
      ? 'Treat this as a durable mission: keep the original objective as the invariant, maintain a short remaining-work checklist, and use independent specialist/reviewer tools when they materially improve correctness.'
      : '',
    objective.acceptanceCriteria?.length ? `Independent reviews must include this exact binding, cover all registered criterion IDs, and inspect the corresponding target/version: ${JSON.stringify(objectiveReviewBinding(objective))}` : '',
    objective.risk === 'high-stakes'
      ? 'High-stakes evidence gate: inspect current authoritative or primary sources before mutation, cite the controlling evidence, and obtain an independent review before claiming completion. The independent reviewer must return a concise JSON receipt shaped as {"verdict":"PASS","criteria":[{"id":"...","passed":true}],"findings":[]}, with every non-review completion criterion passed and no findings; invoking a reviewer alone is not evidence that review passed.'
      : '',
    structuredOutcomeRequired
      ? 'End every final response with exactly one concise machine-readable HTML comment on a single line. Valid state values are: complete_verified, blocked_human, blocked_policy, continue.'
      : '',
    structuredOutcomeRequired
      ? `Valid in-progress example (replace its values): ${OBJECTIVE_OUTCOME_CONTINUE_EXAMPLE}`
      : '',
    structuredOutcomeRequired
      ? 'For evidence references, use toolUseId values from successful tool results (or tool:<exact tool name>). Use assistant-final only for requested-outcome-delivered or no-safe-work-remaining. The host rejects invented references.'
      : '',
    structuredOutcomeRequired
      ? 'complete_verified requires every completion criterion to be present, satisfied:true, and backed by non-empty valid evidence. relevant-checks-passed must reference a substantive observation or validation executed after the latest mutation. For blocked_human or blocked_policy, blocker must be an object with kind, description, and evidence:["toolUseId/messageId"]; a blocker without structured evidence is invalid. For continue, list concrete remainingWork.'
      : '',
    '</host_objective_contract>',
  ].filter(Boolean).join('\n');
}
