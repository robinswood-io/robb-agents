export type CostControlledTurnKind =
  | 'direct'
  | 'agent-message'
  | 'auth-result'
  | 'auth-retry'
  | 'source-activation'
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
    maxValidatedContinuationAttempts?: number;
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
    maxValidatedContinuationAttempts: number;
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
    maxValidatedContinuationAttempts: 4,
    maxNoProgressAttempts: 1,
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
  const rawMaxAutomaticAttempts = policy?.recovery?.maxAutomaticAttempts;
  const maxAutomaticAttempts = Math.min(
    MAX_SAFE_AUTOMATIC_RECOVERY_ATTEMPTS,
    Math.floor(finiteAtLeast(
      rawMaxAutomaticAttempts,
      defaults.recovery.maxAutomaticAttempts,
      0,
    )),
  );
  // Before this dedicated field existed, maxAutomaticAttempts also bounded
  // validated continuations. Preserve an explicit legacy value, including 0;
  // only an unspecified policy receives the new four-pass default.
  const legacyContinuationFallback = rawMaxAutomaticAttempts === undefined
    ? defaults.recovery.maxValidatedContinuationAttempts
    : maxAutomaticAttempts;
  const maxValidatedContinuationAttempts = Math.min(
    MAX_SAFE_VALIDATED_CONTINUATION_ATTEMPTS,
    Math.floor(finiteAtLeast(
      policy?.recovery?.maxValidatedContinuationAttempts,
      legacyContinuationFallback,
      0,
    )),
  );
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
      maxAutomaticAttempts,
      maxValidatedContinuationAttempts,
      maxNoProgressAttempts: Math.min(
        MAX_SAFE_AUTOMATIC_RECOVERY_ATTEMPTS,
        Math.floor(finiteAtLeast(
          policy?.recovery?.maxNoProgressAttempts,
          defaults.recovery.maxNoProgressAttempts,
          1,
        )),
      ),
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

import type { LlmConnection } from './llm-connections.ts';
export const MAX_SAFE_AUTOMATIC_RECOVERY_ATTEMPTS = 8;
export const MAX_SAFE_VALIDATED_CONTINUATION_ATTEMPTS = 4;
export const AGENT_COST_CONTROL_DECISION_VERSION = 2 as const;
export type AgentCostControlRecoveryCause = NonNullable<import('../sessions/types.ts').PendingTurnRecovery['lastCause']>;
export type AgentCostControlRecoveryWorkClass = 'receipt-repair' | 'read-only-verification' | 'substantive';
export type CostProviderAdmission =
  | { action: 'allow-provider'; reason: 'within-hard-limit' | 'explicit-user-turn' }
  | { action: 'pause-for-user'; reason: 'autonomous-hard-limit' };
export function monetaryBudgetCostUsd(
  connection: LlmConnection | null | undefined,
  providerReportedCostUsd: number | undefined,
): number | undefined {
  if (connection?.providerType === 'pi'
    && connection.authType === 'oauth'
    && connection.piAuthProvider === 'openai-codex') return undefined;
  return providerReportedCostUsd;
}
export function decideCostProviderAdmission(input: {
  budgetState: CostBudgetState;
  turnKind: CostControlledTurnKind;
  /** True only for a persisted answer to the host-owned hard-limit question. */
  hostAuthenticatedUserOverride?: boolean;
}): CostProviderAdmission {
  if (input.budgetState !== 'hard-limit') {
    return { action: 'allow-provider', reason: 'within-hard-limit' };
  }
  if (input.hostAuthenticatedUserOverride === true) {
    return { action: 'allow-provider', reason: 'explicit-user-turn' };
  }
  return { action: 'pause-for-user', reason: 'autonomous-hard-limit' };
}

export function resolveAgentCostBudgetState(
  sessionCostUsd: number | undefined,
  budgets: Pick<ResolvedAgentCostControlPolicy['budgets'], 'softSessionUsd' | 'hardSessionUsd'>,
): CostBudgetState {
  // Missing telemetry means no reported spend yet. A present but non-finite
  // value is corrupt accounting and must fail closed: treating it as zero would
  // reopen the provider after the hard monetary fence.
  const costUsd = sessionCostUsd === undefined
    ? 0
    : Number.isFinite(sessionCostUsd)
      ? Math.max(0, sessionCostUsd)
      : Number.POSITIVE_INFINITY;
  return costUsd >= budgets.hardSessionUsd
    ? 'hard-limit'
    : costUsd >= budgets.softSessionUsd
      ? 'soft-limit'
      : 'normal';
}
