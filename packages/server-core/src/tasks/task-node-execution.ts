import type { ThinkingLevel } from '@craft-agent/shared/agent';
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

export interface TaskNodeProfile {
  specialty: TaskNodeSpecialty;
  difficulty: 'simple' | 'standard' | 'complex';
}

/** Settings explicitly selected on the node, task, parent session or workspace. */
export interface TaskModelSettings {
  model?: string;
  llmConnection?: string;
  thinkingLevel?: ThinkingLevel;
}

export function resolveTaskModelSettings(node: TaskNode, spec: TaskSpec, defaults: TaskModelSettings = {}): TaskModelSettings {
  const llmConnection = node.llmConnection ?? spec.defaults?.llmConnection ?? defaults.llmConnection;
  // A node's explicit connection replaces the task connection and its model.
  // Keep a task model only when the node also inherits that connection.
  const taskModel = !node.llmConnection || node.llmConnection === spec.defaults?.llmConnection
    ? spec.defaults?.model
    : undefined;
  return {
    llmConnection,
    model: node.model ?? taskModel
      ?? (llmConnection === defaults.llmConnection ? defaults.model : undefined),
    thinkingLevel: node.thinkingLevel ?? spec.defaults?.thinkingLevel ?? defaults.thinkingLevel,
  };
}

const SPECIALTY_SIGNALS: ReadonlyArray<{
  specialty: Exclude<TaskNodeSpecialty, 'general'>;
  intentPatterns: readonly RegExp[];
  patterns: readonly RegExp[];
}> = [
  {
    specialty: 'security',
    intentPatterns: [/security (?:review|audit)/i, /audit(?:er)? (?:la )?s[ée]curit/i, /threat model/i],
    patterns: [/security/i, /sécurit/i, /owasp/i, /vulnérabil/i, /threat/i, /auth(?:entication|orization)?/i],
  },
  {
    specialty: 'coding',
    intentPatterns: [/\b(?:implement|build|code|fix|refactor)(?:ing)?\b/i, /\b(?:impl[ée]ment|corrig|d[ée]velop)/i],
    patterns: [/\bcode\b/i, /implement/i, /impl[ée]ment/i, /corrig/i, /\bfix\b/i, /refactor/i, /typescript/i, /react/i, /api\b/i],
  },
  {
    specialty: 'testing',
    intentPatterns: [
      /\b(?:write|add|create|run|execute|fix)(?:ing)?\b.{0,40}\btests?\b/i,
      /\b(?:test|verify|validate)(?:ing)?\b/i,
    ],
    patterns: [/\btest(?:s|ing)?\b/i, /vitest/i, /jest/i, /playwright/i, /e2e/i, /regression/i, /qa\b/i],
  },
  {
    specialty: 'review',
    intentPatterns: [/\b(?:review|inspect|assess)(?:ing)?\b/i, /revue de code/i, /relire/i],
    patterns: [/\breview\b/i, /revue de code/i, /code review/i, /relire/i, /inspecter/i, /quality check/i],
  },
  {
    specialty: 'data',
    intentPatterns: [/\b(?:query|migrate|analyse|analyze)\b.{0,40}\b(?:data|database|sql|metrics?)\b/i],
    patterns: [/\bdata\b/i, /donn[ée]es?/i, /sql/i, /database/i, /postgres/i, /migration/i, /analytics?/i, /m[ée]trique/i],
  },
  {
    specialty: 'operations',
    intentPatterns: [/\b(?:deploy|operate|restart|monitor)(?:ing)?\b/i, /d[ée]ploiement/i],
    patterns: [/docker/i, /deploy/i, /d[ée]ploiement/i, /infrastructure/i, /ci\/?cd/i, /github actions/i, /nginx/i, /logs?/i],
  },
  {
    specialty: 'documentation',
    intentPatterns: [/\b(?:document|write|update)(?:ing)?\b.{0,40}\b(?:docs?|readme|guide|runbook)\b/i],
    patterns: [/documentation/i, /\bdocs?\b/i, /readme/i, /guide/i, /runbook/i, /changelog/i],
  },
  {
    specialty: 'research',
    intentPatterns: [/\b(?:research|benchmark|source)(?:ing)?\b/i, /recherche/i, /[ée]tat de l['’]art/i],
    patterns: [/research/i, /recherche/i, /benchmark/i, /sources?/i, /literature/i, /[ée]tat de l['’]art/i],
  },
  {
    specialty: 'analysis',
    intentPatterns: [/\b(?:analyze|analyse|diagnose|investigate|audit)(?:r|ing)?\b/i, /cause racine/i],
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
  const trimmed = text.trim();
  if (/^(?:review|inspect|assess|relire)\b/i.test(trimmed)) return 'review';
  if (/^(?:write|add|create|run|execute|test|verify|validate|fix)\b.{0,80}\btests?\b/i.test(trimmed)) {
    return 'testing';
  }
  let best: { specialty: TaskNodeSpecialty; score: number } = { specialty: 'general', score: 0 };
  for (const signal of SPECIALTY_SIGNALS) {
    const intentScore = signal.intentPatterns.reduce(
      (score, pattern) => score + (pattern.test(text) ? 4 : 0),
      0,
    );
    const contextScore = signal.patterns.reduce(
      (score, pattern) => score + (pattern.test(text) ? 1 : 0),
      0,
    );
    const score = intentScore + contextScore;
    if (score > best.score) best = { specialty: signal.specialty, score };
  }
  return best.specialty;
}

function inferDifficulty(text: string): TaskNodeProfile['difficulty'] {
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
  if (wordCount > 160 || COMPLEX_SIGNALS.some((pattern) => pattern.test(text))) return 'complex';
  if (wordCount >= 30 || STANDARD_SIGNALS.some((pattern) => pattern.test(text))) return 'standard';
  return 'simple';
}

export function inferTaskNodeProfile(node: TaskNode): TaskNodeProfile {
  const text = `${node.title ?? ''}\n${node.prompt ?? ''}`;
  const specialty = node.kind === 'verify' || node.kind === 'judge'
    ? 'review'
    : node.kind === 'synthesize' || node.kind === 'aggregate' || node.kind === 'filter'
      ? 'analysis'
      : inferSpecialty(text);
  const difficulty = inferDifficulty(text);
  return { specialty, difficulty };
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
