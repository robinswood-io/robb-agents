import { describe, expect, it } from 'bun:test';
import {
  maxRoutingSensitivity,
  resolveRoutingPolicy,
  simulateRoutingPolicy,
  validateRoutingPolicy,
  type RoutingPolicy,
} from '../src/config/routing-policy.ts';
import type { LlmConnection } from '../src/config/llm-connections.ts';

function connection(slug: string, providerType: LlmConnection['providerType']): Pick<LlmConnection, 'slug' | 'providerType'> {
  return { slug, providerType };
}

const connections = [
  connection('local-ollama', 'pi_compat'),
  connection('ovh-sovereign', 'pi_compat'),
  connection('openrouter-balanced', 'pi'),
  connection('anthropic-direct', 'anthropic'),
];

describe('routing sensitivity helpers', () => {
  it('returns the highest sensitivity from enabled source hints', () => {
    expect(maxRoutingSensitivity(['public', 'confidential', 'internal'])).toBe('confidential');
    expect(maxRoutingSensitivity(['restricted', 'confidential'])).toBe('restricted');
    expect(maxRoutingSensitivity([undefined])).toBeUndefined();
  });
});

describe('routing policy validation', () => {
  it('warns on unknown referenced connections without failing schema validation', () => {
    const policy: RoutingPolicy = {
      version: 1,
      rules: [
        {
          id: 'internal-default',
          allowConnectionSlugs: ['missing-connection'],
        },
      ],
    };

    const result = validateRoutingPolicy(policy, connections.map(item => item.slug));

    expect(result.valid).toBe(true);
    expect(result.warnings.some(warning => warning.includes('missing-connection'))).toBe(true);
  });

  it('rejects duplicate rule ids', () => {
    const policy: RoutingPolicy = {
      version: 1,
      rules: [
        { id: 'same' },
        { id: 'same' },
      ],
    };

    const result = validateRoutingPolicy(policy);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Duplicate routingPolicy rule id: same');
  });
});

describe('simulateRoutingPolicy()', () => {
  it('explains matching rules and exclusions without mutating routing state', () => {
    const policy: RoutingPolicy = {
      version: 1,
      enabled: true,
      defaultAllowConnectionSlugs: ['local-ollama', 'ovh-sovereign', 'anthropic-direct'],
      defaultDenyConnectionSlugs: ['anthropic-direct'],
      rules: [{
        id: 'confidential-sovereign',
        when: { sensitivity: ['confidential'] },
        allowProviderTypes: ['pi_compat'],
        preferConnectionSlugs: ['ovh-sovereign'],
      }],
    };

    const simulation = simulateRoutingPolicy(policy, connections, {
      sensitivity: 'confidential',
      requestedConnectionSlug: 'anthropic-direct',
    });

    expect(simulation.context.sensitivity).toBe('confidential');
    expect(simulation.decision.selectedConnectionSlug).toBe('ovh-sovereign');
    expect(simulation.matchedRuleIds).toEqual(['confidential-sovereign']);
    expect(simulation.unmatchedRuleIds).toEqual([]);
    expect(simulation.candidates.find(candidate => candidate.slug === 'openrouter-balanced')).toMatchObject({
      allowed: false,
      exclusionReasons: ['not-in-default-allow-list', 'rule:confidential-sovereign:provider-not-allowed'],
    });
    expect(simulation.candidates.find(candidate => candidate.slug === 'anthropic-direct')).toMatchObject({
      allowed: false,
      exclusionReasons: ['rule:confidential-sovereign:provider-not-allowed', 'default-connection-denied'],
    });
  });

  it('explains default-deny when a sensitive turn lacks an explicit allow-list', () => {
    const simulation = simulateRoutingPolicy({ version: 1, enabled: true }, connections, { sensitivity: 'restricted' });

    expect(simulation.decision.selectedConnectionSlug).toBeUndefined();
    expect(simulation.candidates.every(candidate => candidate.exclusionReasons.includes('explicit-allow-required-for-sensitivity'))).toBe(true);
  });
});

describe('resolveRoutingPolicy()', () => {
  it('keeps current behavior when policy is absent', () => {
    const decision = resolveRoutingPolicy(undefined, connections, {
      requestedConnectionSlug: 'anthropic-direct',
    });

    expect(decision.selectedConnectionSlug).toBe('anthropic-direct');
    expect(decision.allowedConnectionSlugs).toEqual(connections.map(item => item.slug));
    expect(decision.reason).toBe('policy-disabled');
  });

  it('requires explicit allow-list for confidential turns by default', () => {
    const policy: RoutingPolicy = {
      version: 1,
      enabled: true,
      rules: [
        {
          id: 'prefer-local-without-allow',
          when: { sensitivity: ['confidential'] },
          preferConnectionSlugs: ['local-ollama'],
        },
      ],
    };

    const decision = resolveRoutingPolicy(policy, connections, { sensitivity: 'confidential' });

    expect(decision.selectedConnectionSlug).toBeUndefined();
    expect(decision.errors).toContain("routingPolicy requires an explicit allow-list for 'confidential' sensitivity");
  });

  it('selects preferred connection only after hard allow/provider constraints', () => {
    const policy: RoutingPolicy = {
      version: 1,
      enabled: true,
      rules: [
        {
          id: 'confidential-local-or-sovereign',
          when: { sensitivity: ['confidential'] },
          allowConnectionSlugs: ['local-ollama', 'ovh-sovereign'],
          allowProviderTypes: ['pi_compat'],
          preferConnectionSlugs: ['anthropic-direct', 'ovh-sovereign', 'local-ollama'],
        },
      ],
    };

    const decision = resolveRoutingPolicy(policy, connections, { sensitivity: 'confidential' });

    expect(decision.selectedConnectionSlug).toBe('ovh-sovereign');
    expect(decision.allowedConnectionSlugs).toEqual(['local-ollama', 'ovh-sovereign']);
    expect(decision.matchedRuleIds).toEqual(['confidential-local-or-sovereign']);
    expect(decision.reason).toBe('rule-preference');
  });

  it('applies deny lists after allow lists', () => {
    const policy: RoutingPolicy = {
      version: 1,
      enabled: true,
      defaultAllowConnectionSlugs: ['local-ollama', 'ovh-sovereign', 'openrouter-balanced'],
      defaultDenyConnectionSlugs: ['openrouter-balanced'],
      rules: [
        {
          id: 'internal-sovereign-first',
          when: { sensitivity: ['internal'] },
          preferConnectionSlugs: ['openrouter-balanced', 'ovh-sovereign', 'local-ollama'],
        },
      ],
    };

    const decision = resolveRoutingPolicy(policy, connections, { sensitivity: 'internal' });

    expect(decision.allowedConnectionSlugs).toEqual(['local-ollama', 'ovh-sovereign']);
    expect(decision.selectedConnectionSlug).toBe('ovh-sovereign');
  });

  it('honors requested connection when it is still allowed by policy', () => {
    const policy: RoutingPolicy = {
      version: 1,
      enabled: true,
      defaultAllowConnectionSlugs: ['openrouter-balanced', 'anthropic-direct'],
      fallbackConnectionSlug: 'openrouter-balanced',
    };

    const decision = resolveRoutingPolicy(policy, connections, {
      sensitivity: 'internal',
      requestedConnectionSlug: 'anthropic-direct',
    });

    expect(decision.selectedConnectionSlug).toBe('anthropic-direct');
    expect(decision.reason).toBe('requested-connection-allowed');
  });

  it('prefers rule-local fallback order after the selected primary connection', () => {
    const policy: RoutingPolicy = {
      version: 1,
      enabled: true,
      rules: [
        {
          id: 'confidential-sovereign-first',
          when: { sensitivity: ['confidential'] },
          allowConnectionSlugs: ['local-ollama', 'ovh-sovereign'],
          preferConnectionSlugs: ['ovh-sovereign'],
          fallbackConnectionSlugs: ['openrouter-balanced', 'local-ollama'],
        },
      ],
    };

    const decision = resolveRoutingPolicy(policy, connections, { sensitivity: 'confidential' });

    expect(decision.selectedConnectionSlug).toBe('ovh-sovereign');
    expect(decision.fallbackConnectionSlugs).toEqual(['local-ollama']);
  });

  it('uses the global fallback when the rule has no authorized fallback', () => {
    const policy: RoutingPolicy = {
      version: 1,
      enabled: true,
      defaultAllowConnectionSlugs: ['local-ollama', 'openrouter-balanced'],
      fallbackConnectionSlug: 'local-ollama',
      rules: [
        {
          id: 'internal-openrouter-first',
          when: { sensitivity: ['internal'] },
          preferConnectionSlugs: ['openrouter-balanced'],
        },
      ],
    };

    const decision = resolveRoutingPolicy(policy, connections, { sensitivity: 'internal' });

    expect(decision.selectedConnectionSlug).toBe('openrouter-balanced');
    expect(decision.fallbackConnectionSlugs[0]).toBe('local-ollama');
  });

  it('does not expose fallback candidates outside the effective allow-list', () => {
    const policy: RoutingPolicy = {
      version: 1,
      enabled: true,
      rules: [
        {
          id: 'confidential-local-only',
          when: { sensitivity: ['confidential'] },
          allowConnectionSlugs: ['local-ollama'],
          preferConnectionSlugs: ['local-ollama'],
          fallbackConnectionSlugs: ['anthropic-direct', 'openrouter-balanced'],
        },
      ],
      fallbackConnectionSlug: 'anthropic-direct',
    };

    const decision = resolveRoutingPolicy(policy, connections, { sensitivity: 'confidential' });

    expect(decision.selectedConnectionSlug).toBe('local-ollama');
    expect(decision.fallbackConnectionSlugs).toEqual([]);
  });

  it('keeps restricted turns away from premium/Gemini-style providers when only local routes are allowed', () => {
    const restrictedConnections = [
      connection('local-rapide', 'pi_compat'),
      connection('souverain-standard', 'pi_compat'),
      connection('google-gemini', 'pi'),
      connection('premium-claude', 'anthropic'),
    ];
    const policy: RoutingPolicy = {
      version: 1,
      enabled: true,
      rules: [
        {
          id: 'restricted-local-only',
          when: { sensitivity: ['restricted'] },
          allowConnectionSlugs: ['local-rapide', 'souverain-standard'],
          preferConnectionSlugs: ['souverain-standard'],
          fallbackConnectionSlugs: ['google-gemini', 'premium-claude', 'local-rapide'],
        },
      ],
    };

    const decision = resolveRoutingPolicy(policy, restrictedConnections, { sensitivity: 'restricted' });

    expect(decision.selectedConnectionSlug).toBe('souverain-standard');
    expect(decision.fallbackConnectionSlugs).toEqual(['local-rapide']);
    expect(decision.allowedConnectionSlugs).not.toContain('google-gemini');
    expect(decision.allowedConnectionSlugs).not.toContain('premium-claude');
  });
});
