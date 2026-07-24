import { describe, expect, test } from 'bun:test';
import type { LlmConnection } from './llm-connections.ts';
import {
  classifyLocalRoutingRequirements,
  resolveRoutingPolicy,
  simulateRoutingPolicy,
  validateRoutingPolicy,
  type RoutingPolicy,
} from './routing-policy.ts';

const connections: Array<Pick<LlmConnection, 'slug' | 'providerType'>> = [
  { slug: 'local', providerType: 'pi_compat' },
  { slug: 'cloud', providerType: 'anthropic' },
  { slug: 'economy', providerType: 'pi' },
];

describe('classifyLocalRoutingRequirements', () => {
  test('classifies a short text locally without requiring capabilities', () => {
    expect(classifyLocalRoutingRequirements({ text: 'Résume ce document.' })).toEqual({
      difficulty: 'simple',
      requiredCapabilities: [],
    });
  });

  test('derives complex, image, tool, and large-context requirements', () => {
    expect(classifyLocalRoutingRequirements({
      text: 'Conçois une architecture multi-étapes pour cette migration.',
      hasImages: true,
      requestedToolNames: ['filesystem'],
      contextTokens: 120_000,
    })).toEqual({
      difficulty: 'complex',
      requiredCapabilities: ['vision', 'tools', 'large-context'],
    });
  });
});

describe('resolveRoutingPolicy', () => {
  test('fails closed on missing capabilities and explains the rejected alternative', () => {
    const policy: RoutingPolicy = {
      version: 1,
      enabled: true,
      defaultAllowConnectionSlugs: ['local', 'cloud'],
      connectionProfiles: {
        local: { capabilities: ['tools'], priority: 1 },
        cloud: { capabilities: ['tools', 'vision'], priority: 2 },
      },
    };

    const decision = resolveRoutingPolicy(policy, connections, {
      requestedConnectionSlug: 'local',
      requiredCapabilities: ['vision'],
    });

    expect(decision.selectedConnectionSlug).toBe('cloud');
    expect(decision.allowedConnectionSlugs).toEqual(['cloud']);
    expect(decision.rejectedCandidates).toContainEqual({
      slug: 'local',
      reasons: ['missing-capability:vision'],
    });
  });

  test('enforces explicit context limits', () => {
    const policy: RoutingPolicy = {
      version: 1,
      enabled: true,
      defaultAllowConnectionSlugs: ['local', 'cloud'],
      connectionProfiles: {
        local: { capabilities: ['large-context'], maxContextTokens: 64_000 },
        cloud: { capabilities: ['large-context'], maxContextTokens: 200_000 },
      },
    };

    const decision = resolveRoutingPolicy(policy, connections, {
      contextTokens: 100_000,
      requiredCapabilities: ['large-context'],
    });

    expect(decision.selectedConnectionSlug).toBe('cloud');
    expect(decision.rejectedCandidates).toContainEqual({
      slug: 'local',
      reasons: ['context-window-exceeded:64000'],
    });
  });

  test('blocks selection when a hard session budget would be exceeded', () => {
    const policy: RoutingPolicy = {
      version: 1,
      enabled: true,
      budgets: { sessionUsd: 1, onExceed: 'block' },
    };

    const decision = resolveRoutingPolicy(policy, connections, {
      budgetUsage: { sessionUsd: 0.9, projectedTurnUsd: 0.2 },
    });

    expect(decision.selectedConnectionSlug).toBeUndefined();
    expect(decision.budget).toEqual({
      status: 'blocked',
      exceededScopes: ['session'],
      projectedUsd: { session: 1.1 },
    });
    expect(decision.errors[0]).toContain('is blocked');
  });

  test('requests approval rather than silently exceeding a soft budget', () => {
    const policy: RoutingPolicy = {
      version: 1,
      enabled: true,
      budgets: { workspaceUsd: 10, onExceed: 'require-approval' },
    };

    const decision = resolveRoutingPolicy(policy, connections, {
      budgetUsage: { workspaceUsd: 9.5, projectedTurnUsd: 1 },
    });

    expect(decision.selectedConnectionSlug).toBeUndefined();
    expect(decision.budget?.status).toBe('approval-required');
    expect(decision.errors[0]).toContain('requires explicit approval');
  });

  test('uses explicit priority only after hard policy filtering', () => {
    const policy: RoutingPolicy = {
      version: 1,
      enabled: true,
      defaultDenyConnectionSlugs: ['economy'],
      connectionProfiles: {
        local: { priority: 20 },
        cloud: { priority: 10 },
        economy: { priority: 1 },
      },
    };

    const decision = resolveRoutingPolicy(policy, connections);

    expect(decision.selectedConnectionSlug).toBe('cloud');
    expect(decision.allowedConnectionSlugs).toEqual(['cloud', 'local']);
  });

  test('excludes runtime-unavailable connections before selection', () => {
    const decision = resolveRoutingPolicy({
      version: 1,
      enabled: true,
      defaultAllowConnectionSlugs: ['local', 'cloud'],
      connectionProfiles: {
        local: { priority: 1 },
        cloud: { priority: 2 },
      },
    }, connections, {
      unavailableConnectionSlugs: ['local'],
    });

    expect(decision.selectedConnectionSlug).toBe('cloud');
    expect(decision.rejectedCandidates).toContainEqual({
      slug: 'local',
      reasons: ['runtime-unavailable'],
    });
  });

  test('keeps confidential routing fail-closed without an explicit allow-list', () => {
    const decision = resolveRoutingPolicy(
      { version: 1, enabled: true },
      connections,
      { sensitivity: 'confidential' },
    );

    expect(decision.selectedConnectionSlug).toBeUndefined();
    expect(decision.allowedConnectionSlugs).toEqual([]);
    expect(decision.errors).toContain(
      "routingPolicy requires an explicit allow-list for 'confidential' sensitivity",
    );
  });
});

describe('routing policy validation and simulation', () => {
  test('reports invalid capabilities and budgets', () => {
    const invalidPolicy = JSON.parse(JSON.stringify({
      version: 1,
      connectionProfiles: { local: { capabilities: ['audio'] } },
      budgets: { sessionUsd: -1 },
    })) as unknown as RoutingPolicy;

    const validation = validateRoutingPolicy(invalidPolicy, ['local']);

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain(
      "Invalid capability 'audio' in routingPolicy connectionProfiles.local",
    );
    expect(validation.errors).toContain('Invalid routingPolicy.budgets.sessionUsd');
  });

  test('includes capability exclusions in read-only simulation output', () => {
    const simulation = simulateRoutingPolicy({
      version: 1,
      enabled: true,
      connectionProfiles: {
        local: { capabilities: [] },
        cloud: { capabilities: ['vision'] },
        economy: { capabilities: [] },
      },
    }, connections, { requiredCapabilities: ['vision'] });

    expect(simulation.candidates.find(candidate => candidate.slug === 'local')).toMatchObject({
      allowed: false,
      exclusionReasons: ['missing-capability:vision'],
    });
  });
});
