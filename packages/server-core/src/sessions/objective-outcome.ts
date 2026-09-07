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
  parseIndependentReviewReceipt,
} from '@craft-agent/shared/agent';
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions';
import {
  hasObjectiveSubstantiveToolResult,
  isObjectiveMutationTool,
  objectiveReviewBinding,
  isObjectiveToolExecutedSuccessfully,
} from './objective-contract.ts';
import { validateObjectiveAcceptanceCriteria } from './objective-acceptance-criteria.ts';

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
const OBSERVATION_SHELL_PATTERN = /(?:^|[;&|]\s*|\s)(?:cat|cmp|diff|find|git\s+(?:diff|log|show|status)|grep|head|ls|pwd|rg|stat|tail|test|wc|(?:bun|npm|pnpm|yarn)\s+(?:test|run\s+(?:check|lint|test|typecheck))|pytest|go\s+test|cargo\s+test|tsc\b[^\n]*--noEmit)\b/i;
const REVIEW_TOOL_PATTERN = /(?:call_llm|spawn_session|wait_sessions|reviewer|review)/i;

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TEXT_CHARS;
}

function boundedStringArray(value: unknown, maxItems: number): value is string[] {
  return Array.isArray(value)
    && value.length <= maxItems
    && value.every(isBoundedString);
}

function parseDeclaration(raw: string): ObjectiveOutcomeDeclaration | undefined {
  if (raw.length > MAX_DECLARATION_CHARS) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<ObjectiveOutcomeDeclaration>;
    if (!STATES.has(value.state as DeclaredObjectiveState)) return undefined;
    if (!Array.isArray(value.criteria) || value.criteria.length > MAX_CRITERIA) return undefined;
    const criteria = value.criteria.filter(item => (
      !!item
      && isBoundedString(item.id)
      && typeof item.satisfied === 'boolean'
      && boundedStringArray(item.evidence, MAX_EVIDENCE_PER_ITEM)
    ));
    if (criteria.length !== value.criteria.length) return undefined;
    if (!boundedStringArray(value.remainingWork, MAX_REMAINING_WORK)) return undefined;
    if (value.blocker !== null) {
      if (!value.blocker || !BLOCKER_KINDS.has(value.blocker.kind)) return undefined;
      if (!isBoundedString(value.blocker.description)) return undefined;
      if (!boundedStringArray(value.blocker.evidence, MAX_EVIDENCE_PER_ITEM)) return undefined;
    }
    return {
      state: value.state as DeclaredObjectiveState,
      criteria,
      remainingWork: value.remainingWork,
      blocker: value.blocker,
    };
  } catch {
    return undefined;
  }
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
  const declaration = parseDeclaration(match[1]?.trim() ?? '');
  return declaration
    ? { visibleContent, declaration }
    : { visibleContent, error: 'malformed objective outcome receipt' };
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

function substantiveToolResult(message: Message): string | undefined {
  return hasObjectiveSubstantiveToolResult(message)
    ? message.toolResult!.trim()
    : undefined;
}

function observationOrValidationTool(message: Message): boolean {
  if (isObjectiveMutationTool(message)) return false;
  if (classifyToolNameMutationSemantics(message.toolName ?? '') === 'ambiguous-compound') return false;
  const toolName = normalizedToolName(message.toolName);
  if (NON_VALIDATION_TOOL_PATTERN.test(toolName)) return false;
  if (OBSERVATION_TOOL_PATTERN.test(toolName)) return true;
  const input = message.toolInput ?? {};
  const action = [input.action, input.operation]
    .find((value): value is string => typeof value === 'string');
  if (action && OBSERVATION_ACTION_PATTERN.test(action.trim())) return true;
  const method = input.method;
  if (typeof method === 'string' && OBSERVATION_HTTP_METHOD_PATTERN.test(method.trim())) return true;
  const query = [input.query, input.sql, input.statement]
    .find((value): value is string => typeof value === 'string');
  if (query && OBSERVATION_SQL_PATTERN.test(query)) return true;
  const command = [input.command, input.cmd, input.script]
    .find((value): value is string => typeof value === 'string');
  return command ? OBSERVATION_SHELL_PATTERN.test(command) : false;
}

function hostEvidenceRefs(messages: Message[], objective: ActiveSessionObjective): {
  successful: Set<string>;
  checks: Set<string>;
  review: Set<string>;
  blockers: Record<ObjectiveBlockerKind, Set<string>>;
} {
  const scoped = messagesForObjective(messages, objective.userMessageId);
  const successful = new Set<string>(['assistant-final']);
  const checks = new Set<string>();
  const review = new Set<string>();
  const blockers: Record<ObjectiveBlockerKind, Set<string>> = {
    credential: new Set(),
    mfa: new Set(),
    external_authorization: new Set(),
    irreversible_authority: new Set(),
    business_decision: new Set(),
    policy: new Set(),
  };
  const addBlockerEvidence = (kind: ObjectiveBlockerKind, message: Message): void => {
    blockers[kind].add(message.id);
    if (message.toolUseId) blockers[kind].add(message.toolUseId);
    if (message.authRequestId) blockers[kind].add(message.authRequestId);
  };
  let lastMutationIndex = -1;
  for (const [index, message] of scoped.entries()) {
    if (message.role === 'tool' && message.toolExecuted !== false && isObjectiveMutationTool(message)) {
      lastMutationIndex = index;
    }
  }
  const addRefs = (refs: Set<string>, message: Message): void => {
    refs.add(message.id);
    if (message.toolUseId) refs.add(message.toolUseId);
    if (message.toolName) refs.add(`tool:${message.toolName}`);
  };
  for (const [index, message] of scoped.entries()) {
    if (message.role === 'auth-request' && message.authStatus === 'pending') {
      addBlockerEvidence('credential', message);
      if (/\b(?:mfa|2fa|two[- ]factor|deux\s+facteurs)\b/i.test(message.content)) {
        addBlockerEvidence('mfa', message);
      }
    }
    if (message.role === 'tool' && (message.isError || message.toolStatus === 'error')) {
      const failure = classifyAgentFailure({
        message: message.toolResult ?? message.content,
        toolName: message.toolName,
      });
      if (failure.failureClass === 'interactive-auth-required') addBlockerEvidence('mfa', message);
      if (failure.failureClass === 'credential-required') addBlockerEvidence('credential', message);
      if (failure.failureClass === 'permission-denied') {
        addBlockerEvidence('external_authorization', message);
        addBlockerEvidence('irreversible_authority', message);
      }
      if (failure.failureClass === 'sandbox-denied') addBlockerEvidence('policy', message);
    }
    const substantiveResult = substantiveToolResult(message);
    if (!substantiveResult) continue;
    addRefs(successful, message);
    const afterLatestMutation = index > lastMutationIndex;
    const reviewReceipt = REVIEW_TOOL_PATTERN.test(message.toolName ?? '')
      ? parseIndependentReviewReceipt(substantiveResult)
      : undefined;
    const reviewedCriteria = new Set(reviewReceipt?.criteria.map(criterion => criterion.id));
    const requiredReviewCriteria = [...objective.completionCriteria.filter(criterion => (
      criterion !== 'independent-review-passed'
    )), ...(objective.acceptanceCriteria ?? []).map(criterion => criterion.id)];
    const binding = objectiveReviewBinding(objective);
    const validReview = (
      reviewReceipt?.verdict === 'PASS'
      && (!objective.acceptanceCriteria?.length || (reviewReceipt.objectiveId === binding.objectiveId
        && reviewReceipt.acceptanceSha256 === binding.acceptanceSha256))
      && reviewReceipt.findings.length === 0
      && reviewReceipt.criteria.every(criterion => criterion.passed)
      && requiredReviewCriteria.every(criterion => reviewedCriteria.has(criterion))
    );
    if (afterLatestMutation && (observationOrValidationTool(message) || validReview)) {
      addRefs(checks, message);
    }
    if (afterLatestMutation && validReview) addRefs(review, message);
  }
  return { successful, checks, review, blockers };
}

function addAutonomyBlockerRefs(
  blockers: Record<ObjectiveBlockerKind, Set<string>>,
  events: readonly AutonomyEvent[],
  objective: ActiveSessionObjective,
): void {
  for (const event of events) {
    if (event.timestamp < objective.startedAt || event.phase !== 'escalated' || !event.escalationReason) continue;
    if (event.escalationReason === 'oauth_or_mfa') blockers.mfa.add(event.id);
    if (event.escalationReason === 'credential_required') blockers.credential.add(event.id);
    if (event.escalationReason === 'business_decision_required') blockers.business_decision.add(event.id);
    if (event.escalationReason === 'external_authorization_required') {
      blockers.external_authorization.add(event.id);
      blockers.irreversible_authority.add(event.id);
    }
  }
}

/** Validate model intent against host-observed evidence; declarations alone never prove completion. */
export function validateObjectiveOutcome(
  declaration: ObjectiveOutcomeDeclaration | undefined,
  options: {
    objective: ActiveSessionObjective;
    messages: Message[];
    extractionError?: string;
    evidenceGap?: string;
    executionEvidenceMissing?: boolean;
    autonomyEvents?: readonly AutonomyEvent[];
  },
): ObjectiveOutcomeValidation {
  const gaps: string[] = [];
  if (options.extractionError) gaps.push(options.extractionError);
  if (!declaration) {
    gaps.push('missing structured objective outcome receipt');
    return { state: 'continue', valid: false, gaps };
  }

  const refs = hostEvidenceRefs(options.messages, options.objective);
  addAutonomyBlockerRefs(refs.blockers, options.autonomyEvents ?? [], options.objective);
  const criteria = new Map<string, { satisfied: boolean; evidence: string[] }>();
  for (const criterion of declaration.criteria) {
    if (criteria.has(criterion.id)) gaps.push(`duplicate criterion: ${criterion.id}`);
    criteria.set(criterion.id, criterion);
  }

  if (declaration.state === 'continue') {
    if (declaration.remainingWork.length === 0) gaps.push('continue requires remainingWork');
    return { state: 'continue', valid: gaps.length === 0, gaps };
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
      if (!declaration.blocker.evidence.some(ref => observedBlockerRefs.has(ref))) {
        gaps.push('blocker evidence does not reference a matching host-observed blocker');
      }
    }
    return { state: gaps.length === 0 ? declaration.state : 'continue', valid: gaps.length === 0, gaps };
  }

  if (declaration.blocker) gaps.push('complete_verified cannot include a blocker');
  gaps.push(...validateObjectiveAcceptanceCriteria(options.objective, options.messages, declaration));
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
    }
  }
  if (options.evidenceGap) gaps.push(options.evidenceGap);
  if (options.executionEvidenceMissing) gaps.push('required execution evidence is missing');
  return { state: gaps.length === 0 ? 'complete_verified' : 'continue', valid: gaps.length === 0, gaps };
}
