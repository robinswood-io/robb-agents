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
  rules?: RoutingPolicyRule[];
}

export interface RoutingPolicyContext {
  sensitivity?: RoutingSensitivity;
  /** User/session-selected connection before automatic routing. */
  requestedConnectionSlug?: string;
  /** Future hook: session/source/client tags. */
  tags?: string[];
  /** Future hook: enabled source slugs. */
  sourceSlugs?: string[];
}

export interface RoutingPolicyDecision {
  selectedConnectionSlug?: string;
  allowedConnectionSlugs: string[];
  matchedRuleIds: string[];
  reason: RoutingPolicyReason;
  sensitivity: RoutingSensitivity;
  errors: string[];
  warnings: string[];
}

export interface RoutingPolicyValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const DEFAULT_EXPLICIT_ALLOW_SENSITIVITIES: RoutingSensitivity[] = ['confidential', 'restricted'];
export const ALL_ROUTING_SENSITIVITIES: RoutingSensitivity[] = ['public', 'internal', 'confidential', 'restricted'];
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

function unique(values: string[] | undefined): string[] {
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

  return true;
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
  }

  if (knownConnectionSlugs.length > 0) {
    const known = new Set(knownConnectionSlugs);
    const refs = collectReferencedSlugs(policy);
    for (const [slug, fields] of Object.entries(refs)) {
      if (!known.has(slug)) {
        warnings.push(`routingPolicy references unknown connection '${slug}' in ${fields.join(', ')}`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
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
      matchedRuleIds: [],
      reason: 'policy-disabled',
      sensitivity,
      errors,
      warnings,
    };
  }

  const validation = validateRoutingPolicy(policy, allSlugs);
  errors.push(...validation.errors);
  warnings.push(...validation.warnings);

  const enrichedContext = { ...context, sensitivity };
  const matchedRules = (policy.rules ?? []).filter(rule => ruleMatches(rule, enrichedContext));
  const matchedRuleIds = matchedRules.map(rule => rule.id);

  let allowed = new Set(allSlugs);

  if ((policy.defaultAllowConnectionSlugs?.length ?? 0) > 0) {
    const allowedDefaults = new Set(policy.defaultAllowConnectionSlugs);
    allowed = new Set([...allowed].filter(slug => allowedDefaults.has(slug)));
  }

  for (const rule of matchedRules) {
    if ((rule.allowConnectionSlugs?.length ?? 0) > 0) {
      const ruleAllow = new Set(rule.allowConnectionSlugs);
      allowed = new Set([...allowed].filter(slug => ruleAllow.has(slug)));
    }

    if ((rule.allowProviderTypes?.length ?? 0) > 0) {
      const allowedProviders = new Set(rule.allowProviderTypes);
      allowed = new Set([...allowed].filter(slug => {
        const connection = connections.find(candidate => candidate.slug === slug);
        return !!connection && allowedProviders.has(connection.providerType);
      }));
    }
  }

  for (const denied of unique(policy.defaultDenyConnectionSlugs)) allowed.delete(denied);
  for (const rule of matchedRules) {
    for (const denied of unique(rule.denyConnectionSlugs)) allowed.delete(denied);
  }

  const explicitAllowSensitivities = policy.requireExplicitAllowFor ?? DEFAULT_EXPLICIT_ALLOW_SENSITIVITIES;
  if (explicitAllowSensitivities.includes(sensitivity) && !hasExplicitAllow(policy, matchedRules)) {
    errors.push(`routingPolicy requires an explicit allow-list for '${sensitivity}' sensitivity`);
    allowed = new Set();
  }

  const allowedConnectionSlugs = allSlugs.filter(slug => allowed.has(slug));
  if (allowedConnectionSlugs.length === 0) {
    errors.push(`routingPolicy leaves no allowed LLM connection for '${sensitivity}' sensitivity`);
    return {
      selectedConnectionSlug: undefined,
      allowedConnectionSlugs,
      matchedRuleIds,
      reason: 'first-allowed',
      sensitivity,
      errors,
      warnings,
    };
  }

  if (context.requestedConnectionSlug && allowed.has(context.requestedConnectionSlug)) {
    return {
      selectedConnectionSlug: context.requestedConnectionSlug,
      allowedConnectionSlugs,
      matchedRuleIds,
      reason: 'requested-connection-allowed',
      sensitivity,
      errors,
      warnings,
    };
  }

  for (const rule of matchedRules) {
    const preferred = firstAllowedInOrder(rule.preferConnectionSlugs, allowed)
      ?? firstAllowedInOrder(rule.fallbackConnectionSlugs, allowed);
    if (preferred) {
      return {
        selectedConnectionSlug: preferred,
        allowedConnectionSlugs,
        matchedRuleIds,
        reason: 'rule-preference',
        sensitivity,
        errors,
        warnings,
      };
    }
  }

  if (policy.fallbackConnectionSlug && allowed.has(policy.fallbackConnectionSlug)) {
    return {
      selectedConnectionSlug: policy.fallbackConnectionSlug,
      allowedConnectionSlugs,
      matchedRuleIds,
      reason: 'policy-fallback',
      sensitivity,
      errors,
      warnings,
    };
  }

  return {
    selectedConnectionSlug: allowedConnectionSlugs[0],
    allowedConnectionSlugs,
    matchedRuleIds,
    reason: 'first-allowed',
    sensitivity,
    errors,
    warnings,
  };
}
