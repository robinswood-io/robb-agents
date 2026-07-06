import { describe, expect, it } from 'bun:test';
import {
  resolveRoutingPolicy,
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
});
