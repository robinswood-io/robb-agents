/**
 * Policy-first LLM routing schema.
 *
 * Robinswood fork foundation: route eligibility is decided by confidentiality
 * and explicit provider/connection allow-lists before cost or performance.
 *
 * This module is intentionally pure and UI/server agnostic so the future router
 * can be introduced incrementally without coupling policy parsing to a runtime.
 */

import type { LlmConnection, LlmProviderType } from './llm-connections.ts';

export type RoutingSensitivity = 'public' | 'internal' | 'confidential' | 'restricted';
export type RoutingDifficulty = 'simple' | 'standard' | 'complex';
export type RoutingCapability = 'tools' | 'vision' | 'large-context';

export type RoutingPolicyReason =
  | 'policy-disabled'
  | 'requested-connection-allowed'
  | 'rule-preference'
  | 'policy-fallback'
  | 'first-allowed';

export interface RoutingPolicyWhen {
  /** Match only these sensitivity levels. Missing means every sensitivity. */
  sensitivity?: RoutingSensitivity[];
  /** Future hook: match session/source/client tags. */
  tagsAny?: string[];
  /** Future hook: match enabled source slugs. */
  sourcesAny?: string[];
  /** Match a locally classified turn difficulty. */
  difficulty?: RoutingDifficulty[];
}

export interface RoutingPolicyRule {
  /** Stable identifier for audit/explanations. */
  id: string;
  description?: string;
  when?: RoutingPolicyWhen;

  /** Hard allow-list. If present, candidates are intersected with these slugs. */
  allowConnectionSlugs?: string[];
  /** Hard deny-list. Always removed after allow rules. */
  denyConnectionSlugs?: string[];
  /** Hard provider allow-list. Applied before preferences/fallback. */
  allowProviderTypes?: LlmProviderType[];

  /** Soft preference once hard policy constraints have been applied. */
  preferConnectionSlugs?: string[];
  /** Rule-local fallback order after preferences. */
  fallbackConnectionSlugs?: string[];
}

export interface RoutingConnectionProfile {
  /** Explicit capabilities. Missing capabilities fail closed when required. */
  capabilities?: RoutingCapability[];
  /** Optional context limit used by the local requirements classifier. */
  maxContextTokens?: number;
  /** Lower values are preferred after hard policy and rule preferences. */
  priority?: number;
}

export interface RoutingBudgetPolicy {
  sessionUsd?: number;
  missionUsd?: number;
  workspaceUsd?: number;
  onExceed?: 'block' | 'require-approval';
}

export interface RoutingPolicy {
  version: 1;
  /** Disabled policies leave current session/default connection behavior untouched. */
  enabled?: boolean;
  defaultSensitivity?: RoutingSensitivity;

  /** Workspace-level hard allow/deny defaults applied before matching rules. */
  defaultAllowConnectionSlugs?: string[];
  defaultDenyConnectionSlugs?: string[];

  /**
   * If a turn has one of these sensitivities, at least one explicit allow-list
   * must apply. This prevents confidential turns from accidentally inheriting
   * "all configured providers".
   */
  requireExplicitAllowFor?: RoutingSensitivity[];

  /** Final global fallback considered after rule preferences and rule fallbacks. */
  fallbackConnectionSlug?: string;
  /** Explicit runtime capability metadata by connection slug. */
  connectionProfiles?: Record<string, RoutingConnectionProfile>;
  /** Hard cost guardrails evaluated before a connection is selected. */
  budgets?: RoutingBudgetPolicy;
  rules?: RoutingPolicyRule[];
}

export interface RoutingBudgetUsage {
  sessionUsd?: number;
  missionUsd?: number;
  workspaceUsd?: number;
  projectedTurnUsd?: number;
}

export interface RoutingPolicyContext {
  sensitivity?: RoutingSensitivity;
  /** User/session-selected connection before automatic routing. */
  requestedConnectionSlug?: string;
  /** Future hook: session/source/client tags. */
  tags?: string[];
  /** Future hook: enabled source slugs. */
  sourceSlugs?: string[];
  /** Local-only classification; prompt content is never persisted in the decision. */
  difficulty?: RoutingDifficulty;
  requiredCapabilities?: RoutingCapability[];
  /** Current context size used to enforce explicit per-connection limits. */
  contextTokens?: number;
  /** Runtime-unavailable connections, for example while a circuit breaker is open. */
  unavailableConnectionSlugs?: string[];
  budgetUsage?: RoutingBudgetUsage;
}

export interface RoutingRejectedCandidate {
  slug: string;
  reasons: string[];
}

export interface RoutingBudgetDecision {
  status: 'within-budget' | 'blocked' | 'approval-required';
  exceededScopes: Array<'session' | 'mission' | 'workspace'>;
  projectedUsd: {
    session?: number;
    mission?: number;
    workspace?: number;
  };
}

export interface RoutingPolicyDecision {
  selectedConnectionSlug?: string;
  allowedConnectionSlugs: string[];
  /** Policy-authorized fallback order, excluding the selected primary connection. */
  fallbackConnectionSlugs: string[];
  matchedRuleIds: string[];
  reason: RoutingPolicyReason;
  sensitivity: RoutingSensitivity;
  errors: string[];
  warnings: string[];
  /** Human-readable reason plus exact alternatives excluded by hard constraints. */
  explanation?: string;
  rejectedCandidates?: RoutingRejectedCandidate[];
  budget?: RoutingBudgetDecision;
}

export interface RoutingPolicyValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** Read-only explanation for one connection in a policy simulation. */
export interface RoutingPolicySimulationCandidate {
  slug: string;
  providerType: LlmProviderType;
  allowed: boolean;
  /** Deterministic policy constraints which excluded this candidate. */
  exclusionReasons: string[];
}

/**
 * Explain a prospective policy decision without starting an agent, checking a
 * credential, or mutating workspace/session state. Safe to expose in a UI.
 */
export interface RoutingPolicySimulation {
  context: Required<Pick<RoutingPolicyContext, 'sensitivity'>> & Omit<RoutingPolicyContext, 'sensitivity'>;
  decision: RoutingPolicyDecision;
  matchedRuleIds: string[];
  unmatchedRuleIds: string[];
  candidates: RoutingPolicySimulationCandidate[];
}

const DEFAULT_EXPLICIT_ALLOW_SENSITIVITIES: RoutingSensitivity[] = ['confidential', 'restricted'];
export const ALL_ROUTING_SENSITIVITIES: RoutingSensitivity[] = ['public', 'internal', 'confidential', 'restricted'];
export const ALL_ROUTING_DIFFICULTIES: RoutingDifficulty[] = ['simple', 'standard', 'complex'];
export const ALL_ROUTING_CAPABILITIES: RoutingCapability[] = ['tools', 'vision', 'large-context'];
const ROUTING_SENSITIVITY_RANK: Record<RoutingSensitivity, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

export function maxRoutingSensitivity(values: Array<RoutingSensitivity | undefined>): RoutingSensitivity | undefined {
  return values
    .filter((value): value is RoutingSensitivity => !!value)
    .sort((left, right) => ROUTING_SENSITIVITY_RANK[right] - ROUTING_SENSITIVITY_RANK[left])[0];
}

function unique<T extends string>(values: T[] | undefined): T[] {
  return Array.from(new Set((values ?? []).filter(Boolean)));
}

function intersects(left: string[] | undefined, right: string[] | undefined): boolean {
  if (!left || left.length === 0 || !right || right.length === 0) return false;
  const rightSet = new Set(right);
  return left.some(value => rightSet.has(value));
}

function ruleMatches(rule: RoutingPolicyRule, context: Required<Pick<RoutingPolicyContext, 'sensitivity'>> & RoutingPolicyContext): boolean {
  const when = rule.when;
  if (!when) return true;

  if (when.sensitivity && !when.sensitivity.includes(context.sensitivity)) return false;
  if (when.tagsAny && when.tagsAny.length > 0 && !intersects(when.tagsAny, context.tags)) return false;
  if (when.sourcesAny && when.sourcesAny.length > 0 && !intersects(when.sourcesAny, context.sourceSlugs)) return false;
  if (when.difficulty && context.difficulty && !when.difficulty.includes(context.difficulty)) return false;
  if (when.difficulty && !context.difficulty) return false;

  return true;
}

export interface LocalRoutingClassificationInput {
  text: string;
  hasImages?: boolean;
  requestedToolNames?: string[];
  contextTokens?: number;
}

/**
 * Conservative, local-only requirements classifier.
 *
 * It returns labels and capabilities only; input text is never included in the
 * decision or telemetry.
 */
export function classifyLocalRoutingRequirements(
  input: LocalRoutingClassificationInput,
): Pick<RoutingPolicyContext, 'difficulty' | 'requiredCapabilities'> {
  const normalized = input.text.trim();
  const wordCount = normalized ? normalized.split(/\s+/).length : 0;
  const complexSignals = [
    /architecture/i,
    /migration/i,
    /audit/i,
    /analyse approfondie/i,
    /multi[- ]?étapes?/i,
    /refactor/i,
  ];
  const difficulty: RoutingDifficulty =
    wordCount > 180 || complexSignals.some(pattern => pattern.test(normalized))
      ? 'complex'
      : wordCount < 30
        ? 'simple'
        : 'standard';
  const requiredCapabilities: RoutingCapability[] = [];

  if (input.hasImages) requiredCapabilities.push('vision');
  if ((input.requestedToolNames?.length ?? 0) > 0) requiredCapabilities.push('tools');
  if ((input.contextTokens ?? 0) >= 100_000) requiredCapabilities.push('large-context');

  return { difficulty, requiredCapabilities };
}

function evaluateRoutingBudget(
  policy: RoutingBudgetPolicy | undefined,
  usage: RoutingBudgetUsage | undefined,
): RoutingBudgetDecision | undefined {
  if (!policy) return undefined;
  const projectedTurnUsd = Math.max(0, usage?.projectedTurnUsd ?? 0);
  const projectedUsd = {
    ...(typeof usage?.sessionUsd === 'number'
      ? { session: usage.sessionUsd + projectedTurnUsd }
      : {}),
    ...(typeof usage?.missionUsd === 'number'
      ? { mission: usage.missionUsd + projectedTurnUsd }
      : {}),
    ...(typeof usage?.workspaceUsd === 'number'
      ? { workspace: usage.workspaceUsd + projectedTurnUsd }
      : {}),
  };
  const exceededScopes: Array<'session' | 'mission' | 'workspace'> = [];
  if (typeof policy.sessionUsd === 'number' && (projectedUsd.session ?? 0) > policy.sessionUsd) exceededScopes.push('session');
  if (typeof policy.missionUsd === 'number' && (projectedUsd.mission ?? 0) > policy.missionUsd) exceededScopes.push('mission');
  if (typeof policy.workspaceUsd === 'number' && (projectedUsd.workspace ?? 0) > policy.workspaceUsd) exceededScopes.push('workspace');

  return {
    status: exceededScopes.length === 0
      ? 'within-budget'
      : policy.onExceed === 'require-approval'
        ? 'approval-required'
        : 'blocked',
    exceededScopes,
    projectedUsd,
  };
}

function hasExplicitAllow(policy: RoutingPolicy, matchedRules: RoutingPolicyRule[]): boolean {
  if ((policy.defaultAllowConnectionSlugs?.length ?? 0) > 0) return true;
  return matchedRules.some(rule =>
    (rule.allowConnectionSlugs?.length ?? 0) > 0 ||
    (rule.allowProviderTypes?.length ?? 0) > 0
  );
}

function firstAllowedInOrder(order: string[] | undefined, allowed: Set<string>): string | undefined {
  return order?.find(slug => allowed.has(slug));
}

function buildFallbackConnectionSlugs(
  policy: RoutingPolicy | undefined,
  matchedRules: RoutingPolicyRule[],
  allowedConnectionSlugs: string[],
  selectedConnectionSlug?: string,
): string[] {
  const allowed = new Set(allowedConnectionSlugs);
  const ordered = [
    ...matchedRules.flatMap(rule => rule.fallbackConnectionSlugs ?? []),
    ...(policy?.fallbackConnectionSlug ? [policy.fallbackConnectionSlug] : []),
    ...allowedConnectionSlugs,
  ];

  return unique(ordered).filter(slug => slug !== selectedConnectionSlug && allowed.has(slug));
}

function collectReferencedSlugs(policy: RoutingPolicy): Record<string, string[]> {
  const refs: Record<string, string[]> = {};
  const add = (field: string, values: string[] | undefined) => {
    for (const value of values ?? []) {
      refs[value] = [...(refs[value] ?? []), field];
    }
  };

  add('defaultAllowConnectionSlugs', policy.defaultAllowConnectionSlugs);
  add('defaultDenyConnectionSlugs', policy.defaultDenyConnectionSlugs);
  if (policy.fallbackConnectionSlug) add('fallbackConnectionSlug', [policy.fallbackConnectionSlug]);

  for (const rule of policy.rules ?? []) {
    add(`rules.${rule.id}.allowConnectionSlugs`, rule.allowConnectionSlugs);
    add(`rules.${rule.id}.denyConnectionSlugs`, rule.denyConnectionSlugs);
    add(`rules.${rule.id}.preferConnectionSlugs`, rule.preferConnectionSlugs);
    add(`rules.${rule.id}.fallbackConnectionSlugs`, rule.fallbackConnectionSlugs);
  }

  return refs;
}

export function validateRoutingPolicy(policy: RoutingPolicy, knownConnectionSlugs: string[] = []): RoutingPolicyValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (policy.version !== 1) {
    errors.push(`Unsupported routingPolicy.version: ${String(policy.version)}`);
  }

  if (policy.defaultSensitivity && !ALL_ROUTING_SENSITIVITIES.includes(policy.defaultSensitivity)) {
    errors.push(`Invalid routingPolicy.defaultSensitivity: ${policy.defaultSensitivity}`);
  }

  const ruleIds = new Set<string>();
  for (const rule of policy.rules ?? []) {
    if (!rule.id) {
      errors.push('routingPolicy.rules contains a rule without id');
      continue;
    }
    if (ruleIds.has(rule.id)) {
      errors.push(`Duplicate routingPolicy rule id: ${rule.id}`);
    }
    ruleIds.add(rule.id);

    for (const sensitivity of rule.when?.sensitivity ?? []) {
      if (!ALL_ROUTING_SENSITIVITIES.includes(sensitivity)) {
        errors.push(`Invalid sensitivity '${sensitivity}' in routingPolicy rule '${rule.id}'`);
      }
    }
    for (const difficulty of rule.when?.difficulty ?? []) {
      if (!ALL_ROUTING_DIFFICULTIES.includes(difficulty)) {
        errors.push(`Invalid difficulty '${difficulty}' in routingPolicy rule '${rule.id}'`);
      }
    }
  }

  for (const [slug, profile] of Object.entries(policy.connectionProfiles ?? {})) {
    for (const capability of profile.capabilities ?? []) {
      if (!ALL_ROUTING_CAPABILITIES.includes(capability)) {
        errors.push(`Invalid capability '${capability}' in routingPolicy connectionProfiles.${slug}`);
      }
    }
    if (profile.maxContextTokens !== undefined && (!Number.isFinite(profile.maxContextTokens) || profile.maxContextTokens <= 0)) {
      errors.push(`Invalid maxContextTokens in routingPolicy connectionProfiles.${slug}`);
    }
    if (profile.priority !== undefined && !Number.isFinite(profile.priority)) {
      errors.push(`Invalid priority in routingPolicy connectionProfiles.${slug}`);
    }
  }

  for (const [scope, value] of Object.entries(policy.budgets ?? {})) {
    if (scope === 'onExceed') continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      errors.push(`Invalid routingPolicy.budgets.${scope}`);
    }
  }

  if (knownConnectionSlugs.length > 0) {
    const known = new Set(knownConnectionSlugs);
    const refs = collectReferencedSlugs(policy);
    for (const [slug, fields] of Object.entries(refs)) {
      if (!known.has(slug)) {
        warnings.push(`routingPolicy references unknown connection '${slug}' in ${fields.join(', ')}`);
      }
    }
    for (const slug of Object.keys(policy.connectionProfiles ?? {})) {
      if (!known.has(slug)) {
        warnings.push(`routingPolicy references unknown connection '${slug}' in connectionProfiles`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function simulateRoutingPolicy(
  policy: RoutingPolicy | undefined,
  connections: Array<Pick<LlmConnection, 'slug' | 'providerType'>>,
  context: RoutingPolicyContext = {},
): RoutingPolicySimulation {
  const sensitivity = context.sensitivity ?? policy?.defaultSensitivity ?? 'internal';
  const enrichedContext = { ...context, sensitivity };
  const matchedRules = policy?.enabled === false || !policy
    ? []
    : (policy.rules ?? []).filter(rule => ruleMatches(rule, enrichedContext));
  const matchedRuleIds = matchedRules.map(rule => rule.id);
  const unmatchedRuleIds = policy?.enabled === false || !policy
    ? []
    : (policy.rules ?? []).filter(rule => !matchedRules.includes(rule)).map(rule => rule.id);
  const decision = resolveRoutingPolicy(policy, connections, enrichedContext);
  const explicitAllowRequired = Boolean(
    policy
    && policy.enabled !== false
    && (policy.requireExplicitAllowFor ?? DEFAULT_EXPLICIT_ALLOW_SENSITIVITIES).includes(sensitivity)
    && !hasExplicitAllow(policy, matchedRules),
  );

  const candidates = connections.map((connection): RoutingPolicySimulationCandidate => {
    const exclusionReasons: string[] = [];
    if (policy?.enabled !== false && policy) {
      if ((policy.defaultAllowConnectionSlugs?.length ?? 0) > 0 && !policy.defaultAllowConnectionSlugs!.includes(connection.slug)) {
        exclusionReasons.push('not-in-default-allow-list');
      }
      for (const rule of matchedRules) {
        if ((rule.allowConnectionSlugs?.length ?? 0) > 0 && !rule.allowConnectionSlugs!.includes(connection.slug)) {
          exclusionReasons.push(`rule:${rule.id}:not-in-connection-allow-list`);
        }
        if ((rule.allowProviderTypes?.length ?? 0) > 0 && !rule.allowProviderTypes!.includes(connection.providerType)) {
          exclusionReasons.push(`rule:${rule.id}:provider-not-allowed`);
        }
        if (rule.denyConnectionSlugs?.includes(connection.slug)) {
          exclusionReasons.push(`rule:${rule.id}:connection-denied`);
        }
      }
      if (policy.defaultDenyConnectionSlugs?.includes(connection.slug)) {
        exclusionReasons.push('default-connection-denied');
      }
      if (explicitAllowRequired) exclusionReasons.push('explicit-allow-required-for-sensitivity');
    }
    exclusionReasons.push(
      ...(decision.rejectedCandidates?.find(candidate => candidate.slug === connection.slug)?.reasons ?? []),
    );
    return {
      slug: connection.slug,
      providerType: connection.providerType,
      allowed: decision.allowedConnectionSlugs.includes(connection.slug),
      exclusionReasons: unique(exclusionReasons),
    };
  });

  return { context: enrichedContext, decision, matchedRuleIds, unmatchedRuleIds, candidates };
}

export function resolveRoutingPolicy(
  policy: RoutingPolicy | undefined,
  connections: Array<Pick<LlmConnection, 'slug' | 'providerType'>>,
  context: RoutingPolicyContext = {},
): RoutingPolicyDecision {
  const sensitivity = context.sensitivity ?? policy?.defaultSensitivity ?? 'internal';
  const warnings: string[] = [];
  const errors: string[] = [];

  const allSlugs = connections.map(connection => connection.slug);
  const all = new Set(allSlugs);

  if (!policy || policy.enabled === false) {
    const selected = context.requestedConnectionSlug && all.has(context.requestedConnectionSlug)
      ? context.requestedConnectionSlug
      : allSlugs[0];

    return {
      selectedConnectionSlug: selected,
      allowedConnectionSlugs: allSlugs,
      fallbackConnectionSlugs: buildFallbackConnectionSlugs(policy, [], allSlugs, selected),
      matchedRuleIds: [],
      reason: 'policy-disabled',
      sensitivity,
      errors,
      warnings,
      explanation: selected
        ? `Policy disabled; kept requested/default connection '${selected}'.`
        : 'Policy disabled; no configured connection was available.',
      rejectedCandidates: [],
    };
  }

  const validation = validateRoutingPolicy(policy, allSlugs);
  errors.push(...validation.errors);
  warnings.push(...validation.warnings);

  const enrichedContext = { ...context, sensitivity };
  const matchedRules = (policy.rules ?? []).filter(rule => ruleMatches(rule, enrichedContext));
  const matchedRuleIds = matchedRules.map(rule => rule.id);

  let allowed = new Set(allSlugs);
  const rejectionReasons = new Map<string, string[]>();
  const reject = (slug: string, reason: string) => {
    rejectionReasons.set(slug, unique([...(rejectionReasons.get(slug) ?? []), reason]));
  };

  if ((policy.defaultAllowConnectionSlugs?.length ?? 0) > 0) {
    const allowedDefaults = new Set(policy.defaultAllowConnectionSlugs);
    for (const slug of allowed) {
      if (!allowedDefaults.has(slug)) reject(slug, 'not-in-default-allow-list');
    }
    allowed = new Set([...allowed].filter(slug => allowedDefaults.has(slug)));
  }

  for (const rule of matchedRules) {
    if ((rule.allowConnectionSlugs?.length ?? 0) > 0) {
      const ruleAllow = new Set(rule.allowConnectionSlugs);
      for (const slug of allowed) {
        if (!ruleAllow.has(slug)) reject(slug, `rule:${rule.id}:not-in-connection-allow-list`);
      }
      allowed = new Set([...allowed].filter(slug => ruleAllow.has(slug)));
    }

    if ((rule.allowProviderTypes?.length ?? 0) > 0) {
      const allowedProviders = new Set(rule.allowProviderTypes);
      allowed = new Set([...allowed].filter(slug => {
        const connection = connections.find(candidate => candidate.slug === slug);
        const isAllowed = !!connection && allowedProviders.has(connection.providerType);
        if (!isAllowed) reject(slug, `rule:${rule.id}:provider-not-allowed`);
        return isAllowed;
      }));
    }
  }

  for (const denied of unique(policy.defaultDenyConnectionSlugs)) {
    if (allowed.has(denied)) reject(denied, 'default-connection-denied');
    allowed.delete(denied);
  }
  for (const rule of matchedRules) {
    for (const denied of unique(rule.denyConnectionSlugs)) {
      if (allowed.has(denied)) reject(denied, `rule:${rule.id}:connection-denied`);
      allowed.delete(denied);
    }
  }
  for (const unavailable of unique(context.unavailableConnectionSlugs)) {
    if (allowed.has(unavailable)) reject(unavailable, 'runtime-unavailable');
    allowed.delete(unavailable);
  }

  const explicitAllowSensitivities = policy.requireExplicitAllowFor ?? DEFAULT_EXPLICIT_ALLOW_SENSITIVITIES;
  if (explicitAllowSensitivities.includes(sensitivity) && !hasExplicitAllow(policy, matchedRules)) {
    errors.push(`routingPolicy requires an explicit allow-list for '${sensitivity}' sensitivity`);
    for (const slug of allowed) reject(slug, 'explicit-allow-required-for-sensitivity');
    allowed = new Set();
  }

  for (const slug of [...allowed]) {
    const profile = policy.connectionProfiles?.[slug];
    for (const capability of unique(context.requiredCapabilities)) {
      if (!profile?.capabilities?.includes(capability)) {
        reject(slug, `missing-capability:${capability}`);
        allowed.delete(slug);
      }
    }
    if (
      allowed.has(slug)
      && typeof context.contextTokens === 'number'
      && typeof profile?.maxContextTokens === 'number'
      && context.contextTokens > profile.maxContextTokens
    ) {
      reject(slug, `context-window-exceeded:${profile.maxContextTokens}`);
      allowed.delete(slug);
    }
  }

  const allowedConnectionSlugs = allSlugs
    .filter(slug => allowed.has(slug))
    .sort((left, right) =>
      (policy.connectionProfiles?.[left]?.priority ?? 0)
      - (policy.connectionProfiles?.[right]?.priority ?? 0)
    );
  const rejectedCandidates: RoutingRejectedCandidate[] = allSlugs
    .filter(slug => !allowed.has(slug))
    .map(slug => ({
      slug,
      reasons: rejectionReasons.get(slug) ?? ['excluded-by-policy'],
    }));
  const budget = evaluateRoutingBudget(policy.budgets, context.budgetUsage);

  if (budget && budget.status !== 'within-budget') {
    const action = budget.status === 'approval-required'
      ? 'requires explicit approval'
      : 'is blocked';
    errors.push(`routingPolicy ${action}: ${budget.exceededScopes.join(', ')} budget exceeded`);
    return {
      selectedConnectionSlug: undefined,
      allowedConnectionSlugs,
      fallbackConnectionSlugs: [],
      matchedRuleIds,
      reason: 'first-allowed',
      sensitivity,
      errors,
      warnings,
      explanation: `No route selected because the projected cost ${action}.`,
      rejectedCandidates,
      budget,
    };
  }

  if (allowedConnectionSlugs.length === 0) {
    errors.push(`routingPolicy leaves no allowed LLM connection for '${sensitivity}' sensitivity`);
    return {
      selectedConnectionSlug: undefined,
      allowedConnectionSlugs,
      fallbackConnectionSlugs: [],
      matchedRuleIds,
      reason: 'first-allowed',
      sensitivity,
      errors,
      warnings,
      explanation: `No configured connection satisfies the '${sensitivity}' policy and required capabilities.`,
      rejectedCandidates,
      budget,
    };
  }

  if (context.requestedConnectionSlug && allowed.has(context.requestedConnectionSlug)) {
    return {
      selectedConnectionSlug: context.requestedConnectionSlug,
      allowedConnectionSlugs,
      fallbackConnectionSlugs: buildFallbackConnectionSlugs(policy, matchedRules, allowedConnectionSlugs, context.requestedConnectionSlug),
      matchedRuleIds,
      reason: 'requested-connection-allowed',
      sensitivity,
      errors,
      warnings,
      explanation: `Requested connection '${context.requestedConnectionSlug}' is allowed by the effective policy.`,
      rejectedCandidates,
      budget,
    };
  }

  for (const rule of matchedRules) {
    const preferred = firstAllowedInOrder(rule.preferConnectionSlugs, allowed)
      ?? firstAllowedInOrder(rule.fallbackConnectionSlugs, allowed);
    if (preferred) {
      return {
        selectedConnectionSlug: preferred,
        allowedConnectionSlugs,
        fallbackConnectionSlugs: buildFallbackConnectionSlugs(policy, matchedRules, allowedConnectionSlugs, preferred),
        matchedRuleIds,
        reason: 'rule-preference',
        sensitivity,
        errors,
        warnings,
        explanation: `Connection '${preferred}' is the first allowed preference from matched policy rules.`,
        rejectedCandidates,
        budget,
      };
    }
  }

  if (policy.fallbackConnectionSlug && allowed.has(policy.fallbackConnectionSlug)) {
    return {
      selectedConnectionSlug: policy.fallbackConnectionSlug,
      allowedConnectionSlugs,
      fallbackConnectionSlugs: buildFallbackConnectionSlugs(policy, matchedRules, allowedConnectionSlugs, policy.fallbackConnectionSlug),
      matchedRuleIds,
      reason: 'policy-fallback',
      sensitivity,
      errors,
      warnings,
      explanation: `Connection '${policy.fallbackConnectionSlug}' is the configured policy fallback and remains allowed.`,
      rejectedCandidates,
      budget,
    };
  }

  const selected = allowedConnectionSlugs[0];
  return {
    selectedConnectionSlug: selected,
    allowedConnectionSlugs,
    fallbackConnectionSlugs: buildFallbackConnectionSlugs(policy, matchedRules, allowedConnectionSlugs, selected),
    matchedRuleIds,
    reason: 'first-allowed',
    sensitivity,
    errors,
    warnings,
    explanation: `Connection '${selected}' is the highest-priority remaining allowed candidate.`,
    rejectedCandidates,
    budget,
  };
}
