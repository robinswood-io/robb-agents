import { isValidThinkingLevel, type ThinkingLevel } from '../agent/thinking-levels.ts';
import type { LlmConnection } from './llm-connections.ts';
import { classifyLocalRoutingRequirements, type RoutingDifficulty } from './routing-policy.ts';

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
  routing?: {
    enabled?: boolean;
    routineModelPatterns?: string[];
    standardModelPatterns?: string[];
    complexModelPatterns?: string[];
    highRiskModelPatterns?: string[];
    routineThinking?: ThinkingLevel;
    standardThinking?: ThinkingLevel;
    complexThinking?: ThinkingLevel;
    highRiskThinking?: ThinkingLevel;
  };
  budgets?: {
    softSessionUsd?: number;
    hardSessionUsd?: number;
  };
  recovery?: {
    maxAutomaticAttempts?: number;
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
  routing: {
    enabled: boolean;
    routineModelPatterns: string[];
    standardModelPatterns: string[];
    complexModelPatterns: string[];
    highRiskModelPatterns: string[];
    routineThinking: ThinkingLevel;
    standardThinking: ThinkingLevel;
    complexThinking: ThinkingLevel;
    highRiskThinking: ThinkingLevel;
  };
  budgets: {
    softSessionUsd: number;
    hardSessionUsd: number;
  };
  recovery: {
    maxAutomaticAttempts: number;
    browserFallbackToolPatterns: string[];
  };
  coordination: {
    maxQueuedMessages: number;
  };
}

export interface AgentCostControlInput {
  text: string;
  /** Bounded historical context used only to detect sensitive objectives hidden by terse follow-ups. */
  riskContext?: string;
  connection?: Pick<LlmConnection, 'models' | 'defaultModel'>;
  currentModel?: string;
  turnKind?: CostControlledTurnKind;
  contextTokens?: number;
  sessionCostUsd?: number;
}

export interface AgentCostControlDecision {
  model?: string;
  thinkingLevel: ThinkingLevel;
  turnKind: CostControlledTurnKind;
  difficulty: RoutingDifficulty;
  highRisk: boolean;
  /** Irreversible, destructive, production, payment, credential, or publication risk. */
  criticalRisk: boolean;
  /** Sensitive domain work whose current request explicitly forbids mutation. */
  readOnlyRisk: boolean;
  budgetState: CostBudgetState;
  shouldCompact: boolean;
  hardContextLimitReached: boolean;
  explanation: string;
}

export const DEFAULT_AGENT_COST_CONTROL_POLICY: ResolvedAgentCostControlPolicy = {
  enabled: true,
  context: {
    compactAtTokens: 80_000,
    hardLimitTokens: 100_000,
  },
  routing: {
    enabled: true,
    routineModelPatterns: ['gpt-5.6-luna', 'gpt-5.4-mini', 'haiku'],
    standardModelPatterns: ['gpt-5.6-terra', 'gpt-5.4', 'sonnet'],
    complexModelPatterns: ['gpt-5.6-sol', 'gpt-5.5', 'opus'],
    highRiskModelPatterns: ['gpt-5.6-sol', 'gpt-5.5', 'opus'],
    routineThinking: 'low',
    standardThinking: 'medium',
    complexThinking: 'high',
    highRiskThinking: 'xhigh',
  },
  budgets: {
    softSessionUsd: 10,
    hardSessionUsd: 25,
  },
  recovery: {
    maxAutomaticAttempts: 1,
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

function thinkingOr(value: unknown, fallback: ThinkingLevel): ThinkingLevel {
  return isValidThinkingLevel(value) ? value : fallback;
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
    routing: {
      enabled: booleanOr(policy?.routing?.enabled, defaults.routing.enabled),
      routineModelPatterns: stringArrayOr(policy?.routing?.routineModelPatterns, defaults.routing.routineModelPatterns),
      standardModelPatterns: stringArrayOr(policy?.routing?.standardModelPatterns, defaults.routing.standardModelPatterns),
      complexModelPatterns: stringArrayOr(policy?.routing?.complexModelPatterns, defaults.routing.complexModelPatterns),
      highRiskModelPatterns: stringArrayOr(policy?.routing?.highRiskModelPatterns, defaults.routing.highRiskModelPatterns),
      routineThinking: thinkingOr(policy?.routing?.routineThinking, defaults.routing.routineThinking),
      standardThinking: thinkingOr(policy?.routing?.standardThinking, defaults.routing.standardThinking),
      complexThinking: thinkingOr(policy?.routing?.complexThinking, defaults.routing.complexThinking),
      highRiskThinking: thinkingOr(policy?.routing?.highRiskThinking, defaults.routing.highRiskThinking),
    },
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

function availableModelIds(connection: AgentCostControlInput['connection']): string[] {
  return (connection?.models ?? []).map(model => typeof model === 'string' ? model : model.id);
}

function selectModel(
  connection: AgentCostControlInput['connection'],
  patterns: string[],
  fallback?: string,
): string | undefined {
  const modelIds = availableModelIds(connection);
  for (const pattern of patterns) {
    const normalizedPattern = pattern.toLowerCase();
    const match = modelIds.find(modelId => modelId.toLowerCase().includes(normalizedPattern));
    if (match) return match;
  }
  return fallback ?? connection?.defaultModel ?? modelIds[0];
}

const HIGH_RISK_PATTERN = /\b(production|prod|deploy|release|publish|delete|remove|purge|drop|migration|rollback|secret|credential|payment|invoice|accounting|ledger|reconciliation|legal|security|permission|rbac|signature|notari[sz]|irreversible|destructive|transaction)\b|\b(supprim|nettoy|déploi|production|migration|secret|paiement|factur|comptab|écriture|lettr|juridique|sécurit|irréversible|destruct)/i;
const CRITICAL_RISK_PATTERN = /\b(production|prod|deploy|release|publish|delete|remove|purge|drop|migration|rollback|secret|credential|payment|legal|signature|notari[sz]|irreversible|destructive|transaction)\b|\b(supprim|nettoy|déploi|production|migration|secret|paiement|juridique|irréversible|destruct)/i;
const EXPLICIT_READ_ONLY_PATTERN = /\b(read[ -]?only|audit only|inspect only|verify only|no writes?|without (?:any )?(?:change|mutation|write))\b|\b(lecture seule|sans (?:aucune )?(?:modification|mutation|écriture)|aucune (?:modification|mutation|écriture)|vérifie seulement|contrôle seulement)/i;
const EXPLICIT_MUTATION_REQUEST_PATTERN = /\b(deploy|publish|delete|remove|purge|drop|migrate|rollback|write|execute|apply|fix|change|modify|approve|submit|pay)\b|\b(déploie|publie|supprime|purge|migre|restaure|écris|exécute|applique|corrige|modifie|approuve|soumets|paie|nettoie)/i;

function isInternalTurn(turnKind: CostControlledTurnKind): boolean {
  return turnKind !== 'direct';
}

export function decideAgentCostControl(
  input: AgentCostControlInput,
  policyInput?: AgentCostControlPolicy,
): AgentCostControlDecision {
  const policy = resolveAgentCostControlPolicy(policyInput);
  const turnKind = input.turnKind ?? 'direct';
  const classified = classifyLocalRoutingRequirements({
    text: input.text,
    contextTokens: input.contextTokens,
  });
  const combinedRiskText = `${input.text}\n${input.riskContext ?? ''}`;
  const highRisk = HIGH_RISK_PATTERN.test(combinedRiskText);
  const criticalRisk = CRITICAL_RISK_PATTERN.test(combinedRiskText);
  const readOnlyRisk = highRisk
    && EXPLICIT_READ_ONLY_PATTERN.test(input.text)
    && !EXPLICIT_MUTATION_REQUEST_PATTERN.test(input.text);
  const contextTokens = Math.max(0, input.contextTokens ?? 0);
  const sessionCostUsd = Math.max(0, input.sessionCostUsd ?? 0);
  const budgetState: CostBudgetState = sessionCostUsd >= policy.budgets.hardSessionUsd
    ? 'hard-limit'
    : sessionCostUsd >= policy.budgets.softSessionUsd
      ? 'soft-limit'
      : 'normal';
  const shouldCompact = contextTokens >= policy.context.compactAtTokens || budgetState !== 'normal';
  const hardContextLimitReached = contextTokens >= policy.context.hardLimitTokens;

  let tier: 'routine' | 'standard' | 'complex' | 'highRisk';
  const ambiguousInternalRisk = highRisk && isInternalTurn(turnKind) && !readOnlyRisk;
  if ((criticalRisk || ambiguousInternalRisk) && !readOnlyRisk) tier = 'highRisk';
  else if (readOnlyRisk) tier = 'standard';
  else if (highRisk) tier = 'standard';
  else if (classified.difficulty === 'complex') tier = isInternalTurn(turnKind) ? 'standard' : 'complex';
  else if (classified.difficulty === 'standard' && !isInternalTurn(turnKind)) tier = 'standard';
  else tier = 'routine';

  if (budgetState !== 'normal' && tier !== 'highRisk') {
    tier = budgetState === 'hard-limit' ? 'routine' : tier === 'complex' ? 'standard' : 'routine';
  }

  const modelPatterns = policy.routing[`${tier}ModelPatterns`];
  const guardedHighRisk = highRisk && !criticalRisk && !readOnlyRisk && !ambiguousInternalRisk;
  const thinkingLevel = guardedHighRisk
    ? policy.routing.complexThinking
    : policy.routing[`${tier}Thinking`];
  const model = policy.enabled && policy.routing.enabled
    ? selectModel(input.connection, modelPatterns, input.currentModel)
    : input.currentModel;

  return {
    model,
    thinkingLevel,
    turnKind,
    difficulty: classified.difficulty ?? 'standard',
    highRisk,
    criticalRisk,
    readOnlyRisk,
    budgetState,
    shouldCompact,
    hardContextLimitReached,
    explanation: [
      `cost-control:${tier}`,
      guardedHighRisk ? 'safety:guarded-high-risk' : undefined,
      readOnlyRisk ? 'safety:explicit-read-only' : undefined,
      `turn:${turnKind}`,
      `difficulty:${classified.difficulty ?? 'standard'}`,
      `budget:${budgetState}`,
      shouldCompact ? `compact-at:${contextTokens}` : undefined,
    ].filter(Boolean).join('; '),
  };
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
