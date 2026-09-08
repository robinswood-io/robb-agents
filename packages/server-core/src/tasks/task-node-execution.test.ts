import { describe, expect, it } from 'bun:test';
import { parseTaskSpec, type TaskSpec } from '@craft-agent/shared/tasks';
import { inferTaskNodeProfile, resolveTaskModelSettings, taskNodeSpecialistPreamble } from './task-node-execution';

function task(raw: unknown): TaskSpec {
  const result = parseTaskSpec(raw);
  if (!result.success) throw new Error(JSON.stringify(result.error.issues));
  return result.data;
}

describe('task node explicit model settings', () => {
  it('uses the same selected model and reasoning for simple, complex and reviewer work', () => {
    const spec = task({ id: 'manual', title: 'Manual', goal: 'Keep settings', nodes: [
      { id: 'simple', prompt: 'List files.' },
      { id: 'complex', prompt: 'Implement the production architecture across packages.' },
      { id: 'review', kind: 'judge', prompt: 'Verify the result.' },
    ] });
    const selected = { model: 'selected-model', llmConnection: 'selected-connection', thinkingLevel: 'medium' as const };
    for (const node of spec.nodes) expect(resolveTaskModelSettings(node, spec, selected)).toEqual(selected);
    expect(inferTaskNodeProfile(spec.nodes[2]!).specialty).toBe('review');
    expect(inferTaskNodeProfile(spec.nodes[2]!)).not.toHaveProperty('modelTier');
    expect(inferTaskNodeProfile(spec.nodes[2]!)).not.toHaveProperty('thinkingLevel');
  });

  it('preserves explicit node overrides, then task defaults, then selected parent settings', () => {
    const spec = task({ id: 'overrides', title: 'Overrides', goal: 'Manual precedence',
      defaults: { model: 'task-model', llmConnection: 'task-connection', thinkingLevel: 'high' },
      nodes: [{ id: 'node', prompt: 'Inspect.', model: 'node-model', llmConnection: 'node-connection', thinkingLevel: 'off' },
        { id: 'default', prompt: 'Inspect.' }],
    });
    const parent = { model: 'parent-model', llmConnection: 'parent-connection', thinkingLevel: 'low' as const };
    expect(resolveTaskModelSettings(spec.nodes[0]!, spec, parent)).toEqual({ model: 'node-model', llmConnection: 'node-connection', thinkingLevel: 'off' });
    expect(resolveTaskModelSettings(spec.nodes[1]!, spec, parent)).toEqual({ model: 'task-model', llmConnection: 'task-connection', thinkingLevel: 'high' });
  });

  it('does not invent a model or transplant another connection model when a connection is explicitly changed', () => {
    const spec = task({ id: 'connection', title: 'Connection', goal: 'Use its configured default',
      nodes: [{ id: 'node', prompt: 'Work.', llmConnection: 'other' }],
    });
    expect(resolveTaskModelSettings(spec.nodes[0]!, spec, { llmConnection: 'parent', model: 'parent-model' }).model).toBeUndefined();
    expect(resolveTaskModelSettings(spec.nodes[0]!, spec).thinkingLevel).toBeUndefined();
  });

  it('keeps specialist guidance independent from model selection', () => {
    const preamble = taskNodeSpecialistPreamble({ specialty: 'security', difficulty: 'complex' }, 2);
    expect(preamble).toContain('Role: security specialist');
    expect(preamble).toContain('change the approach');
    expect(preamble).toContain('verification');
  });

  it('uses the selected node connection default without carrying the task model across providers', () => {
    for (const taskConnection of ['task-connection', undefined]) {
      const spec = task({ id: 'connection-override', title: 'Override', goal: 'Respect the selected connection',
        defaults: { model: 'task-model', llmConnection: taskConnection, thinkingLevel: 'high' },
        nodes: [{ id: 'node', prompt: 'Work.', llmConnection: 'node-connection' }],
      });
      expect(resolveTaskModelSettings(spec.nodes[0]!, spec, {
        llmConnection: 'node-connection', model: 'node-connection-default', thinkingLevel: 'low',
      })).toEqual({
        llmConnection: 'node-connection', model: 'node-connection-default', thinkingLevel: 'high',
      });
    }
  });

  it('keeps the task model when the node explicitly selects the same task connection', () => {
    const spec = task({ id: 'same-connection', title: 'Same', goal: 'Keep the explicit model',
      defaults: { model: 'task-model', llmConnection: 'task-connection' },
      nodes: [{ id: 'node', prompt: 'Work.', llmConnection: 'task-connection' }],
    });
    expect(resolveTaskModelSettings(spec.nodes[0]!, spec, {
      llmConnection: 'task-connection', model: 'connection-default',
    }).model).toBe('task-model');
  });
});
