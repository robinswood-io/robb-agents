import { describe, expect, it } from 'bun:test';
import type { LlmConnection, RoutingPolicy } from '@craft-agent/shared/config';
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
