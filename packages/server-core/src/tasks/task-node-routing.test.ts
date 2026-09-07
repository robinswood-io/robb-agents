import { describe, expect, it } from 'bun:test';
import { decideAgentCostControl, type LlmConnection, type RoutingPolicy } from '@craft-agent/shared/config';
import { getPiModelsForAuthProvider } from '../../../shared/src/config/models-pi';
import { parseTaskSpec, type TaskSpec } from '@craft-agent/shared/tasks';
import {
  inferTaskNodeProfile,
  resolveTaskNodeExecutionRoute,
  taskNodeSpecialistPreamble,
} from './task-node-routing';

function task(raw: unknown): TaskSpec {
  const result = parseTaskSpec(raw);
  if (!result.success) throw new Error(JSON.stringify(result.error.issues));
  return result.data;
}

function connection(overrides: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: 'primary',
    name: 'Primary',
    providerType: 'anthropic',
    authType: 'api_key',
    models: ['claude-opus', 'claude-sonnet', 'claude-haiku'],
    defaultModel: 'claude-sonnet',
    modelSelectionMode: 'userDefined3Tier',
    createdAt: 1,
    ...overrides,
  };
}

describe('task node adaptive routing', () => {
  for (const piAuthProvider of ['openai', 'openai-codex']) {
    const openaiConnection = connection({
      providerType: 'pi',
      piAuthProvider,
      // Exercise both catalogue definitions and persisted string IDs.
      models: ['pi/gpt-5.6-sol', 'pi/gpt-6-astra', 'pi/gpt-5.6-terra', 'pi/gpt-5.6-luna']
        .map(id => piAuthProvider === 'openai'
          ? getPiModelsForAuthProvider(piAuthProvider).find(model => model.id === id)!
          : id),
      defaultModel: 'pi/gpt-5.6-sol',
      modelSelectionMode: 'automaticallySyncedFromProvider',
    });

    it.each([
      { prompt: 'List files.', attempt: 1, model: 'pi/gpt-5.6-luna', thinkingLevel: 'low' },
      { prompt: 'Implement the TypeScript endpoint.', attempt: 1, model: 'pi/gpt-5.6-terra', thinkingLevel: 'medium' },
      { prompt: 'Design the architecture.', attempt: 1, model: 'pi/gpt-6-astra', thinkingLevel: 'high' },
      { prompt: 'Implement the TypeScript endpoint.', attempt: 2, model: 'pi/gpt-6-astra', thinkingLevel: 'high' },
      { prompt: 'List files.', attempt: 3, model: 'pi/gpt-6-astra', thinkingLevel: 'xhigh' },
      { prompt: 'Check the result.', kind: 'verify', attempt: 1, model: 'pi/gpt-6-astra', thinkingLevel: 'high' },
      { prompt: 'Check the result.', kind: 'judge', attempt: 1, model: 'pi/gpt-6-astra', thinkingLevel: 'high' },
    ])(`${piAuthProvider}: routes $prompt at attempt $attempt to $model`, ({ prompt, kind, attempt, model, thinkingLevel }) => {
      const spec = task({
        id: 'astra-routing', title: 'Astra routing', goal: 'Match the workload',
        nodes: [{ id: 'node', prompt, ...(kind ? { kind } : {}) }],
      });
      const route = resolveTaskNodeExecutionRoute({
        node: spec.nodes[0]!, spec, attempt,
        connections: [openaiConnection], defaultConnectionSlug: 'primary',
      });
      expect(route).toMatchObject({ model, thinkingLevel, llmConnection: 'primary' });
      // The actual first-turn controller must preserve the specialist route.
      expect(decideAgentCostControl({
        text: prompt, connection: openaiConnection,
        currentModel: route.model, currentThinkingLevel: route.thinkingLevel,
        turnKind: 'spawned-session',
      }, { profile: 'balanced' })).toMatchObject({ model, thinkingLevel });
    });

    it(`${piAuthProvider}: falls back to Sol when Astra is not configured`, () => {
      const spec = task({
        id: 'without-astra', title: 'Without Astra', goal: 'Use available models',
        nodes: [{ id: 'node', prompt: 'Design the architecture.' }],
      });
      const route = resolveTaskNodeExecutionRoute({
        node: spec.nodes[0]!, spec, attempt: 1, defaultConnectionSlug: 'primary',
        connections: [{ ...openaiConnection, models: ['pi/gpt-5.6-terra', 'pi/gpt-5.6-sol'] }],
      });
      expect(route.model).toBe('pi/gpt-5.6-sol');
    });

    it(`${piAuthProvider}: respects explicit task defaults and node model overrides`, () => {
      const spec = task({
        id: 'pinned-astra', title: 'Pinned model', goal: 'Respect model pins',
        defaults: { model: 'pi/gpt-5.6-terra' },
        nodes: [
          { id: 'default', prompt: 'Design the architecture.' },
          { id: 'override', prompt: 'Design the architecture.', model: 'pi/gpt-5.6-sol' },
        ],
      });
      for (const [index, model] of ['pi/gpt-5.6-terra', 'pi/gpt-5.6-sol'].entries()) {
        expect(resolveTaskNodeExecutionRoute({
          node: spec.nodes[index]!, spec, attempt: 3,
          connections: [openaiConnection], defaultConnectionSlug: 'primary',
        })).toMatchObject({ model, strategy: 'pinned' });
      }
    });

    it(`${piAuthProvider}: respects user-defined model tier ordering`, () => {
      const spec = task({
        id: 'custom-tiers', title: 'Custom tiers', goal: 'Respect configured tiers',
        nodes: [{ id: 'node', prompt: 'Design the architecture.' }],
      });
      expect(resolveTaskNodeExecutionRoute({
        node: spec.nodes[0]!, spec, attempt: 1, defaultConnectionSlug: 'primary',
        connections: [{ ...openaiConnection, modelSelectionMode: 'userDefined3Tier' }],
      }).model).toBe('pi/gpt-5.6-sol');
    });

    it(`${piAuthProvider}: never crosses the policy boundary just to use Astra`, () => {
      const spec = task({
        id: 'restricted-astra', title: 'Restricted route', goal: 'Respect authorized providers',
        nodes: [{ id: 'node', prompt: 'Design the architecture.' }],
      });
      expect(resolveTaskNodeExecutionRoute({
        node: spec.nodes[0]!, spec, attempt: 1, defaultConnectionSlug: 'primary',
        connections: [openaiConnection, connection({ slug: 'allowed' })],
        routingPolicy: { version: 1, defaultAllowConnectionSlugs: ['allowed'] },
      })).toMatchObject({ llmConnection: 'allowed', model: 'claude-opus' });
    });
  }

  it('infers a specialist and promotes the model tier after failures', () => {
    const spec = task({
      id: 'implement-api',
      title: 'Implement API',
      goal: 'Implement the endpoint',
      nodes: [{ id: 'code', title: 'Implement endpoint', prompt: 'Implement the TypeScript API endpoint and test it.' }],
    });
    const node = spec.nodes[0]!;

    expect(inferTaskNodeProfile(node, 1)).toMatchObject({
      specialty: 'coding',
      difficulty: 'standard',
      modelTier: 'balanced',
      thinkingLevel: 'medium',
    });
    expect(inferTaskNodeProfile(node, 2)).toMatchObject({ modelTier: 'best', thinkingLevel: 'high' });
    expect(inferTaskNodeProfile(node, 3)).toMatchObject({ modelTier: 'best', thinkingLevel: 'xhigh' });
  });

  it('prioritizes the requested work over incidental technology keywords', () => {
    const spec = task({
      id: 'multi-intent',
      title: 'Multi intent',
      goal: 'Route by requested work',
      nodes: [
        { id: 'tests', prompt: 'Write TypeScript tests for the React API client.' },
        { id: 'review', prompt: 'Review the TypeScript API implementation for maintainability.' },
        { id: 'fix-test', prompt: 'Fix the failing Playwright regression test.' },
      ],
    });

    expect(inferTaskNodeProfile(spec.nodes[0]!).specialty).toBe('testing');
    expect(inferTaskNodeProfile(spec.nodes[1]!).specialty).toBe('review');
    expect(inferTaskNodeProfile(spec.nodes[2]!).specialty).toBe('testing');
  });

  it('routes explicit judge and verifier nodes as strongest-tier reviewers', () => {
    const spec = task({
      id: 'verify-outcome',
      title: 'Verify outcome',
      goal: 'Verify independently',
      nodes: [{ id: 'judge', kind: 'judge', prompt: 'Check the observable result.' }],
    });

    expect(inferTaskNodeProfile(spec.nodes[0]!, 1)).toMatchObject({
      specialty: 'review',
      modelTier: 'best',
      thinkingLevel: 'high',
    });
  });

  it('routes simple, standard, and retried work to fast, balanced, and best models', () => {
    const spec = task({
      id: 'adaptive',
      title: 'Adaptive',
      goal: 'Route work',
      nodes: [
        { id: 'simple', prompt: 'List files.' },
        { id: 'standard', prompt: 'Implement the TypeScript endpoint with validation.' },
      ],
    });
    const connections = [connection()];

    const simple = resolveTaskNodeExecutionRoute({
      node: spec.nodes[0]!,
      spec,
      attempt: 1,
      connections,
      defaultConnectionSlug: 'primary',
    });
    const standard = resolveTaskNodeExecutionRoute({
      node: spec.nodes[1]!,
      spec,
      attempt: 1,
      connections,
      defaultConnectionSlug: 'primary',
    });
    const retried = resolveTaskNodeExecutionRoute({
      node: spec.nodes[0]!,
      spec,
      attempt: 3,
      connections,
      defaultConnectionSlug: 'primary',
      lastFailure: 'timeout',
    });

    expect(simple).toMatchObject({ model: 'claude-haiku', llmConnection: 'primary', thinkingLevel: 'low' });
    expect(standard).toMatchObject({ model: 'claude-sonnet', llmConnection: 'primary', thinkingLevel: 'medium' });
    expect(retried).toMatchObject({ model: 'claude-opus', llmConnection: 'primary', thinkingLevel: 'xhigh' });
  });

  it('moves an unpinned retry to a different policy-authorized provider', () => {
    const spec = task({
      id: 'provider-fallback',
      title: 'Provider fallback',
      goal: 'Recover without repeating the failed route',
      nodes: [{ id: 'node', prompt: 'Inspect the repository.' }],
    });
    const connections = [
      connection(),
      connection({
        slug: 'secondary',
        name: 'Secondary',
        providerType: 'pi',
        models: ['gpt-best', 'gpt-balanced', 'gpt-fast'],
        defaultModel: 'gpt-balanced',
      }),
    ];

    const route = resolveTaskNodeExecutionRoute({
      node: spec.nodes[0]!,
      spec,
      attempt: 2,
      connections,
      defaultConnectionSlug: 'primary',
      lastFailure: 'service unavailable',
      previousRoute: { llmConnection: 'primary', model: 'claude-haiku' },
    });

    expect(route).toMatchObject({
      llmConnection: 'secondary',
      model: 'gpt-balanced',
      strategy: 'retry-fallback',
    });
  });

  it('does not override an explicitly pinned route during retry', () => {
    const spec = task({
      id: 'pinned-provider',
      title: 'Pinned provider',
      goal: 'Respect an explicit route',
      defaults: { llmConnection: 'primary' },
      nodes: [{ id: 'node', prompt: 'Inspect the repository.' }],
    });
    const route = resolveTaskNodeExecutionRoute({
      node: spec.nodes[0]!,
      spec,
      attempt: 2,
      connections: [connection(), connection({ slug: 'secondary', name: 'Secondary' })],
      defaultConnectionSlug: 'secondary',
      previousRoute: { llmConnection: 'primary' },
    });

    expect(route).toMatchObject({ llmConnection: 'primary', strategy: 'pinned' });
  });

  it('keeps an explicitly pinned node model while still adapting reasoning effort', () => {
    const spec = task({
      id: 'pinned',
      title: 'Pinned',
      goal: 'Use the selected model',
      nodes: [{ id: 'node', prompt: 'Implement the fix.', model: 'custom-model' }],
    });
    const route = resolveTaskNodeExecutionRoute({
      node: spec.nodes[0]!,
      spec,
      attempt: 3,
      connections: [connection()],
      defaultConnectionSlug: 'primary',
    });

    expect(route.model).toBe('custom-model');
    expect(route.thinkingLevel).toBe('xhigh');
  });

  it('fails closed when an enabled routing policy leaves no authorized connection', () => {
    const spec = task({
      id: 'blocked',
      title: 'Blocked',
      goal: 'Respect policy',
      nodes: [{ id: 'node', prompt: 'Inspect the repository.' }],
    });
    const policy: RoutingPolicy = {
      version: 1,
      enabled: true,
      defaultAllowConnectionSlugs: ['missing'],
    };
    const route = resolveTaskNodeExecutionRoute({
      node: spec.nodes[0]!,
      spec,
      attempt: 1,
      connections: [connection()],
      routingPolicy: policy,
      defaultConnectionSlug: 'primary',
    });

    expect(route.blockedReason).toContain('no allowed LLM connection');
    expect(route.model).toBeUndefined();
  });

  it('injects an autonomous, verification-oriented specialist contract', () => {
    const preamble = taskNodeSpecialistPreamble(
      { specialty: 'security', difficulty: 'complex', modelTier: 'best', thinkingLevel: 'high' },
      2,
    );

    expect(preamble).toContain('Role: security specialist');
    expect(preamble).toContain('Work autonomously');
    expect(preamble).toContain('change the approach');
    expect(preamble).toContain('verification');
  });
});
