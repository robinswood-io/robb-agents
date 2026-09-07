import type { Message, ObjectiveAcceptanceCriterion, ObjectiveOutcomeDeclaration } from '@craft-agent/core/types';
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions';
import { isObjectiveToolExecutedSuccessfully, isObjectiveMutationTool } from './objective-contract.ts';

const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);

/** Own JSON properties only: no evaluation, prototypes, or JSONPath expressions. */
function atPath(value: unknown, path: string): unknown {
  if (!path || path.length > 256) return undefined;
  for (const key of path.split('.')) {
    if (forbiddenKeys.has(key) || !value || typeof value !== 'object'
      || !Object.prototype.hasOwnProperty.call(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function resultJson(text: string): unknown {
  try {
    const value = JSON.parse(text);
    // MCP envelopes are transport, not the business result. Unwrap only one
    // unambiguous text block; never extract arbitrary JSON from prose.
    if (Array.isArray(value?.content) && value.content.length === 1
      && value.content[0]?.type === 'text') return JSON.parse(value.content[0].text);
    return value;
  } catch { return undefined; }
}

export function registerObjectiveAcceptanceCriteria(
  objective: ActiveSessionObjective,
  criteria: ObjectiveAcceptanceCriterion[],
  now = Date.now(),
): ActiveSessionObjective {
  if (objective.terminalState !== 'active') throw new Error('No active objective');
  if (!Array.isArray(criteria) || criteria.length < 1 || criteria.length > 16) throw new Error('Expected 1–16 criteria');
  const byId = new Map((objective.acceptanceCriteria ?? []).map(item => [item.id, item]));
  const incomingIds = new Set<string>();
  for (const item of criteria) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(item.id) || incomingIds.has(item.id)
      || objective.completionCriteria.includes(item.id as never)) throw new Error('Invalid or duplicate criterion id');
    incomingIds.add(item.id);
    if (!item.description?.trim() || item.description.length > 1000 || !item.toolName?.trim()
      || item.toolName.length > 256 || !item.input || Object.keys(item.input).length < 1
      || Object.keys(item.input).length > 16 || !Array.isArray(item.checks)
      || item.checks.length < 1 || item.checks.length > 16) throw new Error('Incomplete criterion');
    for (const [path, value] of [...Object.entries(item.input), ...item.checks.map(check => [check.path, check.equals] as const)]) {
      if (!path || path.length > 256 || path.split('.').some(key => forbiddenKeys.has(key) || !key)
        || !(value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
          || (typeof value === 'string' && value.length <= 2048))) throw new Error('Invalid JSON selector or scalar');
    }
    const previous = byId.get(item.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(item)) throw new Error('Registered criteria cannot be weakened or replaced');
    byId.set(item.id, structuredClone(item));
  }
  if (byId.size > 16) throw new Error('At most 16 criteria per objective');
  // New evidence must follow registration. Repeating an identical registration
  // is idempotent and does not invalidate already collected evidence.
  return {
    ...objective,
    acceptanceCriteria: [...byId.values()],
    acceptanceRegisteredAt: byId.size === objective.acceptanceCriteria?.length
      ? objective.acceptanceRegisteredAt : now,
  };
}

export function validateObjectiveAcceptanceCriteria(
  objective: ActiveSessionObjective,
  messages: Message[],
  declaration: ObjectiveOutcomeDeclaration,
): string[] {
  if (!objective.acceptanceCriteria?.length) return objective.requiresAcceptanceCriteria
    ? ['Register target-bound acceptance checks with set_completion_criteria before claiming completion'] : [];
  const rootIndex = messages.findIndex(message => message.id === objective.userMessageId);
  if (rootIndex < 0) return ['Objective transcript provenance is unavailable'];
  const scoped = messages.slice(rootIndex + 1);
  let lastMutation = -1;
  scoped.forEach((message, index) => {
    if (message.role === 'tool' && message.toolExecuted !== false && isObjectiveMutationTool(message)) lastMutation = index;
  });
  return objective.acceptanceCriteria.flatMap(criterion => {
    const claim = declaration.criteria.find(item => item.id === criterion.id);
    const matched = claim?.satisfied && scoped.some((message, index) => {
      if (index <= lastMutation || message.timestamp < (objective.acceptanceRegisteredAt ?? objective.startedAt)
        || message.toolName !== criterion.toolName || !isObjectiveToolExecutedSuccessfully(message)
        || isObjectiveMutationTool(message) || !message.toolResult
        || !(claim.evidence.includes(message.id) || (message.toolUseId && claim.evidence.includes(message.toolUseId)))) return false;
      if (!Object.entries(criterion.input).every(([path, expected]) => atPath(message.toolInput, path) === expected)) return false;
      const result = resultJson(message.toolResult);
      return criterion.checks.every(check => (check.path === '$text' ? message.toolResult : atPath(result, check.path)) === check.equals);
    });
    return matched ? [] : [`Business criterion lacks matching post-action evidence: ${criterion.id}`];
  });
}
