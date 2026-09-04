import { createHash } from 'node:crypto';
import type { Message } from '@craft-agent/core/types';
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions';
import { isContextDependentDirectTurn } from '@craft-agent/shared/config/agent-cost-control';
import { classifyLocalRoutingRequirements } from '@craft-agent/shared/config/routing-policy';

const HIGH_STAKES_DOMAIN_PATTERN = /\b(?:legal|law|juridique|droit|nda|non[- ]disclosure|contrat|compliance|conformit[ée]|medical|m[ée]dical|sant[ée]|financial|finance|accounting|comptab|fiscal|tax|security|s[ée]curit[ée]|credential|secret|permission|rbac)\b/i;
const MULTI_STEP_PATTERN = /\b(?:puis|ensuite|et\s+(?:v[ée]rifie|teste|corrige|impl[ée]mente|d[ée]ploie)|tous\s+les\s+points|l['’]ensemble\s+de\s+ces\s+points|de\s+bout\s+en\s+bout|end[- ]to[- ]end|multi[- ]?[ée]tapes?)\b/i;
const EXECUTION_REQUEST_PATTERN = /\b(?:build|create|write|change|modify|correct|fix|implement|apply|install|deploy|publish|delete|remove|cr[ée](?:e|er)|r[ée]dig\w*|[ée]cri\w*|modifi\w*|corrig\w*|impl[ée]ment\w*|implant\w*|appliqu\w*|install\w*|d[ée]ploi\w*|publi\w*|supprim\w*|r[ée]alis\w*|correction(?:s)?)\b/i;

export interface ObjectiveTransitionInput {
  existing?: ActiveSessionObjective;
  messageId: string;
  text: string;
  lifetimeCostUsd?: number;
  lifetimeTokens?: number;
  nowMs?: number;
}

export function transitionObjectiveContract(input: ObjectiveTransitionInput): ActiveSessionObjective {
  const nowMs = input.nowMs ?? Date.now();
  if (input.existing && isContextDependentDirectTurn(input.text)) {
    return {
      ...input.existing,
      continuationCount: input.existing.continuationCount + 1,
      terminalState: 'active',
      completedAt: undefined,
    };
  }

  const difficulty = classifyLocalRoutingRequirements({ text: input.text }).difficulty ?? 'standard';
  const highStakes = HIGH_STAKES_DOMAIN_PATTERN.test(input.text);
  const requiresExecutionEvidence = EXECUTION_REQUEST_PATTERN.test(input.text);
  const mission = highStakes || difficulty === 'complex' || MULTI_STEP_PATTERN.test(input.text);
  const completionCriteria: ActiveSessionObjective['completionCriteria'] = [
    'requested-outcome-delivered',
    'relevant-checks-passed',
    'no-safe-work-remaining',
  ];
  if (highStakes) completionCriteria.push('independent-review-passed');

  return {
    schemaVersion: 1,
    userMessageId: input.messageId,
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
  return messages.find(message => (
    message.id === objective.userMessageId && message.role === 'user'
  ))?.content;
}

/** Stable progress signal: only new successful tool evidence advances it. */
export function turnProgressFingerprint(messages: Message[], userMessageId: string): string {
  const userIndex = messages.findIndex(message => message.id === userMessageId && message.role === 'user');
  if (userIndex < 0) return 'missing-objective';
  const successfulTools = messages
    .slice(userIndex + 1)
    .filter(message => message.role === 'tool' && message.toolStatus === 'completed' && !message.isError)
    .map(message => `${message.toolUseId ?? message.id}:${message.toolName ?? 'tool'}`);
  return createHash('sha256').update(successfulTools.join('|')).digest('hex').slice(0, 16);
}

const MUTATION_TOOL_PATTERN = /^(?:Write|Edit|MultiEdit|NotebookEdit)$/i;
const MUTATION_CONNECTOR_PATTERN = /(?:^|__)(?:create|update|edit|write|delete|remove|publish|send|submit|deploy|install|apply|execute)(?:_|$)/i;
const MUTATION_BASH_PATTERN = /(?:^|\s)(?:apply_patch|cp|mv|install|deploy|git\s+(?:commit|push)|(?:python\d*|bun|node)\s+[^\n]*(?:build|generate|write|create)|docx-tool|xlsx-tool|pptx-tool|pdf-tool)\b|(?:^|[^<])>{1,2}(?!>)/i;

export function hasObjectiveExecutionEvidence(messages: Message[], userMessageId: string): boolean {
  const userIndex = messages.findIndex(message => message.id === userMessageId && message.role === 'user');
  if (userIndex < 0) return false;
  return messages.slice(userIndex + 1).some(message => {
    if (message.role !== 'tool' || message.toolStatus !== 'completed' || message.isError) return false;
    const toolName = message.toolName ?? '';
    if (MUTATION_TOOL_PATTERN.test(toolName) || MUTATION_CONNECTOR_PATTERN.test(toolName)) return true;
    if (toolName !== 'Bash') return false;
    const command = typeof message.toolInput?.command === 'string' ? message.toolInput.command : '';
    return MUTATION_BASH_PATTERN.test(command);
  });
}

export function buildObjectiveContractPrompt(objective: ActiveSessionObjective): string {
  const criteria = objective.completionCriteria.join(', ');
  return [
    `<host_objective_contract objective_user_message_id="${objective.userMessageId}" orchestration="${objective.orchestrationMode}" risk="${objective.risk}">`,
    `Completion criteria: ${criteria}.`,
    'Continue through every safe in-scope step. A progress report, proposed next action, or partially created deliverable is not a terminal result.',
    'Before ending, evaluate the objective as exactly one of: complete_verified, blocked_human, blocked_policy, continue.',
    'Use complete_verified only after the requested outcome exists, relevant checks passed, and no safe in-scope work remains. Use blocked_human only for a concrete credential, MFA, external authorization, or genuinely missing user decision.',
    objective.orchestrationMode === 'mission'
      ? 'Treat this as a durable mission: keep the original objective as the invariant, maintain a short remaining-work checklist, and use independent specialist/reviewer tools when they materially improve correctness.'
      : '',
    objective.evidenceRequirement
      ? 'High-stakes evidence gate: inspect current authoritative or primary sources before mutation, cite the controlling evidence, and obtain an independent review before claiming completion.'
      : '',
    '</host_objective_contract>',
  ].filter(Boolean).join('\n');
}
