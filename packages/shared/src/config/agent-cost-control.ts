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
  /** Effective model context window, used to keep absolute limits safe on smaller models. */
  contextWindow?: number;
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
  /** The turn only confirms an already-completed objective and hands it off for review. */
  completionReviewOnly: boolean;
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
    maxAutomaticAttempts: 3,
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

const HIGH_RISK_PATTERN = /\b(deploy|release|publish|delete|remove|purge|drop|migration|rollback|secret|credential|payment|invoice|accounting|ledger|reconciliation|legal|security|permission|rbac|signature|notari[sz]|irreversible|destructive|transaction|nda|non-disclosure)\b|\b(supprim|nettoy|déploi|migration|secret|paiement|factur|comptab|écriture|lettr|juridique|sécurit|irréversible|destruct)/i;
const CRITICAL_RISK_PATTERN = /\b(deploy|release|publish|delete|remove|purge|drop|migration|rollback|secret|credential|payment|legal|signature|notari[sz]|irreversible|destructive|transaction|nda|non-disclosure)\b|\b(supprim|nettoy|déploi|migration|secret|paiement|juridique|irréversible|destruct)/i;
// "Production" is also a normal business function (alongside marketing and
// support). Only treat it as an operational safety signal when it is coupled
// to an environment/resource or a mutating action.
const PRODUCTION_ENVIRONMENT_RISK_PATTERN = /(?:\b(?:production|prod)\b.{0,80}\b(?:environment|server|database|cluster|application|service|site|branch|deploy|release|publish|migration|rollback|delete|remove|purge|drop|restart|execute|write|apply|fix|change|modify)\b|\b(?:environment|server|database|cluster|application|service|site|branch|deploy|release|publish|migration|rollback|delete|remove|purge|drop|restart|execute|write|apply|fix|change|modify)\b.{0,80}\b(?:production|prod)\b|\bproduction\b.{0,80}\b(?:environnement|serveur|base de données|cluster|application|service|site|branche|déploi|publie|migration|restaure|supprim|purge|redémarr|exécut|lance|écris|appliqu|corrig|modifi)\w*|\b(?:environnement|serveur|base de données|cluster|application|service|site|branche|déploi|publie|migration|restaure|supprim|purge|redémarr|exécut|lance|écris|appliqu|corrig|modifi)\w*.{0,80}\bproduction\b)/i;
const EXPLICIT_READ_ONLY_PATTERN = /\b(read[ -]?only|audit only|inspect only|verify only|no writes?|without (?:any )?(?:change|mutation|write))\b|\b(lecture seule|sans (?:aucune )?(?:modification|mutation|écriture)|aucune (?:modification|mutation|écriture)|vérifie seulement|contrôle seulement)/i;
const EXPLICIT_MUTATION_REQUEST_PATTERN = /\b(deploy|publish|delete|remove|purge|drop|migrate|rollback|write|execute|apply|fix|change|modify|approve|submit|pay)\b|\b(déploie|publie|supprime|purge|migre|restaure|écris|exécute|applique|corrige|modifie|approuve|soumets|paie|nettoie)\b/i;
const COMPLETION_REVIEW_PATTERN = /(?:objectif|travail|tâche|task|work).{0,120}(?:déjà\s+)?(?:achev[ée]|termin[ée]|complét[ée]|complete(?:d)?|finished)|(?:déjà\s+)?(?:achev[ée]|termin[ée]|complét[ée]).{0,120}(?:objectif|travail|tâche)/i;
const NO_REEXECUTION_PATTERN = /(?:ne|n['’])\s+(?:relance|répète|lance|effectue).{0,160}(?:audit|appel réseau|effet externe|action externe)|(?:sans|aucun|aucune|no|without).{0,100}(?:audit|network call|appel réseau|external effect|effet externe)/i;
const REVIEW_HANDOFF_PATTERN = /needs-review|(?:statut|status).{0,40}(?:revue|review)|(?:place|mets|mettre|placer).{0,80}(?:revue|review)/i;
const CONTEXT_DEPENDENT_DIRECT_TURN_PATTERN = /^(?:(?:ok|oui|yes|go|d['’]accord)[\s,;:!.-]+)?(?:fais(?:-le)?|faites|vas-y|allez-y|continue|poursuis|reprends|corrige|impl[ée]mente|d[ée]ploie|relance|ex[ée]cute|termine|proc[èe]de|applique)\b/i;
const AUTOMATIC_RECOVERY_ATTEMPT_PATTERN = /<automatic_turn_recovery\b[^>]*\battempt=["'](\d+)["']/i;

function isCompletionReviewOnly(text: string): boolean {
  return COMPLETION_REVIEW_PATTERN.test(text)
    && NO_REEXECUTION_PATTERN.test(text)
    && REVIEW_HANDOFF_PATTERN.test(text)
    && !EXPLICIT_MUTATION_REQUEST_PATTERN.test(text);
}

function isInternalTurn(turnKind: CostControlledTurnKind): boolean {
  return turnKind !== 'direct';
}

function automaticRecoveryAttempt(text: string, turnKind: CostControlledTurnKind): number {
  if (turnKind !== 'automatic-recovery') return 0;
  const match = text.match(AUTOMATIC_RECOVERY_ATTEMPT_PATTERN);
  return match ? Math.max(1, Number.parseInt(match[1] ?? '1', 10)) : 1;
}

export function decideAgentCostControl(
  input: AgentCostControlInput,
  policyInput?: AgentCostControlPolicy,
): AgentCostControlDecision {
  const policy = resolveAgentCostControlPolicy(policyInput);
  const turnKind = input.turnKind ?? 'direct';
  const combinedRiskText = `${input.text}\n${input.riskContext ?? ''}`;
  const normalizedTurnText = input.text.trim();
  const contextDependentDirectTurn = normalizedTurnText.split(/\s+/).length < 30
    && CONTEXT_DEPENDENT_DIRECT_TURN_PATTERN.test(normalizedTurnText);
  const classificationText = isInternalTurn(turnKind) || contextDependentDirectTurn
    ? combinedRiskText
    : input.text;
  const classified = classifyLocalRoutingRequirements({
    text: classificationText,
    contextTokens: input.contextTokens,
  });
  const productionEnvironmentRisk = PRODUCTION_ENVIRONMENT_RISK_PATTERN.test(combinedRiskText);
  const highRisk = HIGH_RISK_PATTERN.test(combinedRiskText) || productionEnvironmentRisk;
  const criticalRisk = CRITICAL_RISK_PATTERN.test(combinedRiskText) || productionEnvironmentRisk;
  const completionReviewOnly = isCompletionReviewOnly(input.text);
  const readOnlyRisk = highRisk
    && (EXPLICIT_READ_ONLY_PATTERN.test(input.text) || completionReviewOnly)
    && !EXPLICIT_MUTATION_REQUEST_PATTERN.test(input.text);
  const difficulty: RoutingDifficulty = completionReviewOnly && !highRisk
    ? 'simple'
    : (classified.difficulty ?? 'standard');
  const contextTokens = Math.max(0, input.contextTokens ?? 0);
  const effectiveContext = resolveEffectiveAgentContextLimits(policy.context, input.contextWindow);
  const sessionCostUsd = Math.max(0, input.sessionCostUsd ?? 0);
  const budgetState: CostBudgetState = sessionCostUsd >= policy.budgets.hardSessionUsd
    ? 'hard-limit'
    : sessionCostUsd >= policy.budgets.softSessionUsd
      ? 'soft-limit'
      : 'normal';
  const shouldCompact = contextTokens >= effectiveContext.compactAtTokens;
  const hardContextLimitReached = contextTokens >= effectiveContext.hardLimitTokens;
  const recoveryAttempt = automaticRecoveryAttempt(input.text, turnKind);
  const seniorRecoveryEscalation = recoveryAttempt >= 2;

  let tier: 'routine' | 'standard' | 'complex' | 'highRisk';
  const ambiguousInternalRisk = highRisk && isInternalTurn(turnKind) && !readOnlyRisk;
  if ((criticalRisk || ambiguousInternalRisk) && !readOnlyRisk) tier = 'highRisk';
  else if (readOnlyRisk) tier = 'standard';
  else if (highRisk) tier = 'standard';
  else if (completionReviewOnly) tier = 'routine';
  else if (seniorRecoveryEscalation) tier = 'complex';
  else if (difficulty === 'complex') tier = isInternalTurn(turnKind) ? 'standard' : 'complex';
  else if (difficulty === 'standard' && (!isInternalTurn(turnKind) || turnKind === 'automatic-recovery')) tier = 'standard';
  else tier = 'routine';

  if (budgetState !== 'normal' && tier !== 'highRisk' && turnKind !== 'automatic-recovery') {
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
    difficulty,
    highRisk,
    criticalRisk,
    readOnlyRisk,
    completionReviewOnly,
    budgetState,
    shouldCompact,
    hardContextLimitReached,
    explanation: [
      `cost-control:${tier}`,
      guardedHighRisk ? 'safety:guarded-high-risk' : undefined,
      readOnlyRisk ? 'safety:explicit-read-only' : undefined,
      completionReviewOnly ? 'cost:completion-review-only' : undefined,
      seniorRecoveryEscalation ? `recovery:senior-attempt-${recoveryAttempt}` : undefined,
      `turn:${turnKind}`,
      `difficulty:${difficulty}`,
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
