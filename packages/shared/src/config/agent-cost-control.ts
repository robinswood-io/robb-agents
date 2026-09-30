export type CostControlledTurnKind =
  | 'direct'
  | 'agent-message'
  | 'automatic-recovery'
  | 'browser-fallback'
  | 'spawned-session'
  | 'automation';

export type CostBudgetState = 'normal' | 'soft-limit' | 'hard-limit';

export interface AgentCostControlPolicy {
  enabled?: boolean;
  context?: {
    compactAtTokens?: number;
    hardLimitTokens?: number;
  };
  budgets?: {
    softSessionUsd?: number;
    hardSessionUsd?: number;
  };
  recovery?: {
    maxAutomaticAttempts?: number;
    maxNoProgressAttempts?: number;
    browserFallbackToolPatterns?: string[];
  };
  coordination?: {
    maxQueuedMessages?: number;
  };
}

export interface ResolvedAgentCostControlPolicy {
  enabled: boolean;
  context: {
    compactAtTokens: number;
    hardLimitTokens: number;
  };
  budgets: {
    softSessionUsd: number;
    hardSessionUsd: number;
  };
  recovery: {
    maxAutomaticAttempts: number;
    maxNoProgressAttempts: number;
    browserFallbackToolPatterns: string[];
  };
  coordination: {
    maxQueuedMessages: number;
  };
}

export const DEFAULT_AGENT_COST_CONTROL_POLICY: ResolvedAgentCostControlPolicy = {
  enabled: true,
  context: {
    compactAtTokens: 80_000,
    hardLimitTokens: 100_000,
  },
  budgets: {
    softSessionUsd: 10,
    hardSessionUsd: 25,
  },
  recovery: {
    maxAutomaticAttempts: 8,
    maxNoProgressAttempts: 2,
    browserFallbackToolPatterns: [
      'browser',
      'web',
      'fetch',
      'http',
      'source',
      'mcp',
      'gmail',
      'calendar',
      'slack',
      'notion',
      'linear',
      'github',
    ],
  },
  coordination: {
    maxQueuedMessages: 8,
  },
};

const MIN_CONTEXT_LIMIT_TOKENS = 8_000;
const COMPACT_CONTEXT_WINDOW_RATIO = 0.7;
const HARD_CONTEXT_WINDOW_RATIO = 0.85;

/**
 * Clamp absolute policy limits to the active model's real context window.
 * Without this, the default 80k/100k policy cannot protect a 64k model.
 */
export function resolveEffectiveAgentContextLimits(
  context: ResolvedAgentCostControlPolicy['context'],
  contextWindow?: number,
): ResolvedAgentCostControlPolicy['context'] {
  if (!Number.isFinite(contextWindow) || (contextWindow ?? 0) < MIN_CONTEXT_LIMIT_TOKENS) {
    return context;
  }

  const windowTokens = Math.floor(contextWindow as number);
  const compactAtTokens = Math.min(
    context.compactAtTokens,
    Math.max(MIN_CONTEXT_LIMIT_TOKENS, Math.floor(windowTokens * COMPACT_CONTEXT_WINDOW_RATIO)),
  );
  const hardLimitTokens = Math.max(
    compactAtTokens,
    Math.min(
      context.hardLimitTokens,
      Math.max(MIN_CONTEXT_LIMIT_TOKENS, Math.floor(windowTokens * HARD_CONTEXT_WINDOW_RATIO)),
    ),
  );

  return { compactAtTokens, hardLimitTokens };
}

function finiteAtLeast(value: number | undefined, fallback: number, minimum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, value as number) : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function stringArrayOr(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value
    : fallback;
}

export function resolveAgentCostControlPolicy(
  policy?: AgentCostControlPolicy,
): ResolvedAgentCostControlPolicy {
  const defaults = DEFAULT_AGENT_COST_CONTROL_POLICY;
  const compactAtTokens = finiteAtLeast(
    policy?.context?.compactAtTokens,
    defaults.context.compactAtTokens,
    8_000,
  );
  const hardLimitTokens = Math.max(
    compactAtTokens,
    finiteAtLeast(policy?.context?.hardLimitTokens, defaults.context.hardLimitTokens, 8_000),
  );
  const softSessionUsd = finiteAtLeast(
    policy?.budgets?.softSessionUsd,
    defaults.budgets.softSessionUsd,
    0,
  );

  return {
    enabled: booleanOr(policy?.enabled, defaults.enabled),
    context: { compactAtTokens, hardLimitTokens },
    budgets: {
      softSessionUsd,
      hardSessionUsd: Math.max(
        softSessionUsd,
        finiteAtLeast(policy?.budgets?.hardSessionUsd, defaults.budgets.hardSessionUsd, 0),
      ),
    },
    recovery: {
      maxAutomaticAttempts: Math.floor(finiteAtLeast(
        policy?.recovery?.maxAutomaticAttempts,
        defaults.recovery.maxAutomaticAttempts,
        0,
      )),
      maxNoProgressAttempts: Math.floor(finiteAtLeast(
        policy?.recovery?.maxNoProgressAttempts,
        defaults.recovery.maxNoProgressAttempts,
        1,
      )),
      browserFallbackToolPatterns: stringArrayOr(
        policy?.recovery?.browserFallbackToolPatterns,
        defaults.recovery.browserFallbackToolPatterns,
      ),
    },
    coordination: {
      maxQueuedMessages: Math.floor(finiteAtLeast(
        policy?.coordination?.maxQueuedMessages,
        defaults.coordination.maxQueuedMessages,
        1,
      )),
    },
  };
}

const CONTEXT_DEPENDENT_DIRECT_TURN_PATTERN = /^(?:(?:ok|oui|yes|d['’]accord)[\s,;:!.-]+)?(?:(?:go|vas-y|allez-y|continue|poursui(?:s|t|vre)|reprend(?:s|re)?|corrige|impl[ée]mente|d[ée]ploie|relance|ex[ée]cute|termine|proc[èe]de|applique)\b|(?:fais|faites)(?:-le|\s+le)?\b)/i;
/**
 * Whether a short direct message semantically continues the active objective.
 * Session accounting preserves the active objective across terse follow-ups.
 */
export function isContextDependentDirectTurn(text: string): boolean {
  const normalized = text.trim();
  return normalized.split(/\s+/).length < 30
    && CONTEXT_DEPENDENT_DIRECT_TURN_PATTERN.test(normalized);
}

export function isBrowserFallbackEligibleTool(
  toolName: string | undefined,
  policyInput?: AgentCostControlPolicy,
): boolean {
  if (!toolName) return false;
  const normalized = toolName.toLowerCase();
  return resolveAgentCostControlPolicy(policyInput).recovery.browserFallbackToolPatterns
    .some(pattern => normalized.includes(pattern.toLowerCase()));
}
