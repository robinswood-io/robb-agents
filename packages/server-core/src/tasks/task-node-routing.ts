import type { ThinkingLevel } from '@craft-agent/shared/agent';
import {
  getMiniModel,
  maxRoutingSensitivity,
  resolveRoutingPolicy,
  type LlmConnection,
  type ModelDefinition,
  type RoutingDifficulty,
  type RoutingPolicy,
} from '@craft-agent/shared/config';
import type { TaskNode, TaskSpec } from '@craft-agent/shared/tasks';

export type TaskNodeSpecialty =
  | 'research'
  | 'analysis'
  | 'coding'
  | 'testing'
  | 'review'
  | 'security'
  | 'data'
  | 'operations'
  | 'documentation'
  | 'general';

export type TaskModelTier = 'fast' | 'balanced' | 'best';

export interface TaskNodeProfile {
  specialty: TaskNodeSpecialty;
  difficulty: RoutingDifficulty;
  modelTier: TaskModelTier;
  thinkingLevel: ThinkingLevel;
}

export interface TaskNodeRouteContext {
  node: TaskNode;
  spec: TaskSpec;
  attempt: number;
  lastFailure?: string;
  /** Last dispatched route, persisted in the run log for crash-safe retry diversification. */
  previousRoute?: Pick<TaskNodeExecutionRoute, 'llmConnection' | 'model'>;
}

export interface TaskNodeExecutionRoute {
  profile: TaskNodeProfile;
  model?: string;
  llmConnection?: string;
  thinkingLevel: ThinkingLevel;
  strategy: 'primary' | 'retry-fallback' | 'pinned';
  blockedReason?: string;
}

export interface ResolveTaskNodeExecutionRouteInput extends TaskNodeRouteContext {
  connections: LlmConnection[];
  routingPolicy?: RoutingPolicy;
  defaultConnectionSlug?: string;
}

const SPECIALTY_SIGNALS: ReadonlyArray<{
  specialty: Exclude<TaskNodeSpecialty, 'general'>;
  patterns: readonly RegExp[];
}> = [
  {
    specialty: 'security',
    patterns: [/security/i, /sécurit/i, /owasp/i, /vulnérabil/i, /threat/i, /auth(?:entication|orization)?/i],
  },
  {
    specialty: 'coding',
    patterns: [/\bcode\b/i, /implement/i, /impl[ée]ment/i, /corrig/i, /\bfix\b/i, /refactor/i, /typescript/i, /react/i, /api\b/i],
  },
  {
    specialty: 'testing',
    patterns: [/\btest(?:s|ing)?\b/i, /vitest/i, /jest/i, /playwright/i, /e2e/i, /regression/i, /qa\b/i],
  },
  {
    specialty: 'review',
    patterns: [/\breview\b/i, /revue de code/i, /code review/i, /relire/i, /inspecter/i, /quality check/i],
  },
  {
    specialty: 'data',
    patterns: [/\bdata\b/i, /donn[ée]es?/i, /sql/i, /database/i, /postgres/i, /migration/i, /analytics?/i, /m[ée]trique/i],
  },
  {
    specialty: 'operations',
    patterns: [/docker/i, /deploy/i, /d[ée]ploiement/i, /infrastructure/i, /ci\/?cd/i, /github actions/i, /nginx/i, /logs?/i],
  },
  {
    specialty: 'documentation',
    patterns: [/documentation/i, /\bdocs?\b/i, /readme/i, /guide/i, /runbook/i, /changelog/i],
  },
  {
    specialty: 'research',
    patterns: [/research/i, /recherche/i, /benchmark/i, /sources?/i, /literature/i, /[ée]tat de l['’]art/i],
  },
  {
    specialty: 'analysis',
    patterns: [/analysis/i, /analyse/i, /diagnos/i, /root cause/i, /cause racine/i, /investig/i, /audit/i],
  },
];

const COMPLEX_SIGNALS = [
  /architecture/i,
  /migration/i,
  /audit/i,
  /analyse approfondie/i,
  /multi[- ]?[ée]tapes?/i,
  /refactor/i,
  /cross[- ]?package/i,
  /end[- ]to[- ]end/i,
  /production/i,
] as const;

const STANDARD_SIGNALS = [
  /implement/i,
  /impl[ée]ment/i,
  /corrig/i,
  /diagnos/i,
  /test/i,
  /review/i,
  /analyse/i,
  /compare/i,
] as const;

function inferSpecialty(text: string): TaskNodeSpecialty {
  for (const signal of SPECIALTY_SIGNALS) {
    if (signal.patterns.some((pattern) => pattern.test(text))) return signal.specialty;
  }
  return 'general';
}

function inferDifficulty(text: string): RoutingDifficulty {
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
  if (wordCount > 160 || COMPLEX_SIGNALS.some((pattern) => pattern.test(text))) return 'complex';
  if (wordCount >= 30 || STANDARD_SIGNALS.some((pattern) => pattern.test(text))) return 'standard';
  return 'simple';
}

function baseTier(difficulty: RoutingDifficulty): TaskModelTier {
  if (difficulty === 'complex') return 'best';
  if (difficulty === 'standard') return 'balanced';
  return 'fast';
}

function promoteTier(tier: TaskModelTier, attempt: number): TaskModelTier {
  if (attempt >= 3) return 'best';
  if (attempt < 2) return tier;
  return tier === 'fast' ? 'balanced' : 'best';
}

function thinkingForTier(tier: TaskModelTier, attempt: number): ThinkingLevel {
  if (attempt >= 3) return 'xhigh';
  if (tier === 'best') return 'high';
  if (tier === 'balanced') return 'medium';
  return 'low';
}

export function inferTaskNodeProfile(node: TaskNode, attempt = 1): TaskNodeProfile {
  const text = `${node.title ?? ''}\n${node.prompt ?? ''}`;
  const specialty = inferSpecialty(text);
  const difficulty = inferDifficulty(text);
  const modelTier = promoteTier(baseTier(difficulty), attempt);
  return {
    specialty,
    difficulty,
    modelTier,
    thinkingLevel: thinkingForTier(modelTier, attempt),
  };
}

function modelId(model: ModelDefinition | string): string {
  return typeof model === 'string' ? model : model.id;
}

function modelForTier(
  connection: LlmConnection,
  tier: TaskModelTier,
  taskDefaultModel?: string,
): string | undefined {
  const models = connection.models ?? [];
  if (tier === 'fast') {
    return getMiniModel(connection) ?? connection.defaultModel ?? taskDefaultModel;
  }
  if (tier === 'balanced') {
    if (connection.modelSelectionMode === 'userDefined3Tier' && models[1]) return modelId(models[1]);
    return connection.defaultModel ?? taskDefaultModel ?? (models[0] ? modelId(models[0]) : undefined);
  }
  return models[0] ? modelId(models[0]) : connection.defaultModel ?? taskDefaultModel;
}

export function resolveTaskNodeExecutionRoute(
  input: ResolveTaskNodeExecutionRouteInput,
): TaskNodeExecutionRoute {
  const profile = inferTaskNodeProfile(input.node, input.attempt);
  const requestedConnectionSlug =
    input.node.llmConnection ?? input.spec.defaults?.llmConnection ?? input.defaultConnectionSlug;
  const routePinned = Boolean(
    input.node.llmConnection
    ?? input.spec.defaults?.llmConnection
    ?? input.node.model
    ?? input.spec.defaults?.model,
  );
  const sensitivity = maxRoutingSensitivity(
    input.spec.mission?.inputs.map((missionInput) => missionInput.sensitivity) ?? [],
  );
  const decision = resolveRoutingPolicy(input.routingPolicy, input.connections, {
    requestedConnectionSlug,
    sensitivity,
    difficulty: profile.difficulty,
    tags: [profile.specialty, ...(input.node.labels ?? [])],
    sourceSlugs: input.spec.sources,
  });

  if (input.routingPolicy?.enabled !== false && input.routingPolicy && !decision.selectedConnectionSlug) {
    return {
      profile,
      thinkingLevel: profile.thinkingLevel,
      strategy: routePinned ? 'pinned' : 'primary',
      blockedReason: decision.errors.join('; ') || 'No policy-authorized LLM connection is available.',
    };
  }

  const primaryConnection = decision.selectedConnectionSlug ?? requestedConnectionSlug;
  const retryFallback = input.attempt > 1 && !routePinned
    ? decision.fallbackConnectionSlugs.find(
        (candidate) => candidate !== input.previousRoute?.llmConnection,
      )
    : undefined;
  const llmConnection = retryFallback ?? primaryConnection;
  const connection = input.connections.find((candidate) => candidate.slug === llmConnection);
  const model = input.node.model
    ?? (connection
      ? modelForTier(connection, profile.modelTier, input.spec.defaults?.model)
      : input.spec.defaults?.model);

  return {
    profile,
    model,
    llmConnection,
    thinkingLevel: profile.thinkingLevel,
    strategy: routePinned ? 'pinned' : retryFallback ? 'retry-fallback' : 'primary',
  };
}

const SPECIALTY_INSTRUCTIONS: Record<TaskNodeSpecialty, string> = {
  research: 'Find primary evidence, cross-check claims, and cite the exact sources used.',
  analysis: 'Diagnose from evidence, separate symptoms from root causes, and state concrete conclusions.',
  coding: 'Inspect existing patterns, implement the complete change, and run proportionate type checks and tests.',
  testing: 'Reproduce the behavior, build focused regression coverage, execute it, and report exact pass/fail counts.',
  review: 'Review the full scoped change, prioritize actionable findings, and include exact file and line references.',
  security: 'Use a threat-aware approach, preserve least privilege, and verify every security-relevant claim.',
  data: 'Validate inputs and definitions, make calculations reproducible, and flag data-quality limitations.',
  operations: 'Inspect current state first, use bounded reversible actions, and verify service health and logs afterward.',
  documentation: 'Produce accurate, reusable documentation grounded in the current implementation.',
  general: 'Complete the assigned objective using the most relevant evidence and verification available.',
};

export function taskNodeSpecialistPreamble(profile: TaskNodeProfile, attempt: number): string {
  return [
    '<specialist_execution>',
    `Role: ${profile.specialty} specialist. Complexity: ${profile.difficulty}. Attempt: ${attempt}.`,
    SPECIALTY_INSTRUCTIONS[profile.specialty],
    'Work autonomously until the requested outcome is actually complete. Make reasonable in-scope decisions without asking for routine confirmation.',
    'If an action fails, inspect the exact error, change the approach, and retry safe reversible steps instead of repeating the same command blindly.',
    'Do not claim completion without executing the relevant verification. Report each remaining blocker precisely.',
    '</specialist_execution>',
    '',
    '',
  ].join('\n');
}
