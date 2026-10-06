import { describe, expect, it } from 'bun:test';
import { parseSpawnSessionInput, SpawnSessionInputError, SpawnSessionSchema } from './spawn-session-schema.ts';

describe('spawn_session admission contract', () => {
  it('preserves canonical modes, project, role and attachments across backend schemas', () => {
    for (const permissionMode of ['safe', 'ask', 'allow-all'] as const) {
      const input = { prompt: 'Inspect the supplied evidence', permissionMode, projectId: 'project-1', role: 'reviewer' as const,
        attachments: [{ path: '/tmp/evidence.json', name: 'Evidence' }] };
      expect(parseSpawnSessionInput(input)).toEqual(input);
      expect(SpawnSessionSchema.safeParse(input).success).toBe(true);
    }
    expect(parseSpawnSessionInput({ prompt: 'Bounded task' }).permissionMode).toBeUndefined();
  });

  it('rejects the observed display labels before any session can be created', () => {
    for (const permissionMode of ['read-only', 'execute', 'explore', 'Explore', 'Execute', '', null, 1]) {
      try {
        parseSpawnSessionInput({ prompt: 'Review', permissionMode });
        throw new Error('Unexpected admission');
      } catch (error) {
        expect(error).toBeInstanceOf(SpawnSessionInputError);
        expect((error as SpawnSessionInputError).toJSON()).toMatchObject({
          code: 'invalid_spawn_session_arguments', retryable: false, fields: ['permissionMode'],
        });
      }
    }
  });

  it('rejects misspelled fields, malformed optional fields and missing prompts without echoing values', () => {
    for (const input of [
      { prompt: 'Review', permission_mode: 'read-only' }, { prompt: 42 }, { prompt: '  ' }, {},
      { prompt: 'Review', attachments: ['/private/secret-document'] },
      { prompt: 'Review', thinkingLevel: 'high' }, { prompt: 'Review', model: 'pi/gpt-5.6-luna' },
      { prompt: 'Review', llmConnection: 'another-provider' },
      { help: 'false' }, { prompt: 'Review', role: 'supervisor' },
    ]) expect(() => parseSpawnSessionInput(input)).toThrow(SpawnSessionInputError);
    try { parseSpawnSessionInput({ prompt: 'private text', permissionMode: 'private-secret-value' }); }
    catch (error) { expect(JSON.stringify(error)).not.toContain('private-secret-value'); }
  });

  it('allows help and strips only root UI metadata', () => {
    expect(parseSpawnSessionInput({ help: true })).toEqual({ help: true });
    expect(parseSpawnSessionInput({ prompt: 'Review', _intent: 'inspect', _displayName: 'Review' })).toEqual({ prompt: 'Review' });
    expect(() => parseSpawnSessionInput({ prompt: 'Review', attachments: [{ path: '/tmp/a', _intent: 'hidden' }] }))
      .toThrow(SpawnSessionInputError);
  });

  it('restricts the exact legacy reviewer label only when role was omitted', () => {
    expect(parseSpawnSessionInput({ prompt: 'Review', labels: ['reviewer'] }).role).toBe('reviewer');
    expect(parseSpawnSessionInput({ prompt: 'Task', role: 'worker', labels: ['reviewer'] }).role).toBe('worker');
    for (const labels of [[], ['Reviewer'], ['reviewer:team'], ['not-reviewer'], ['worker']]) {
      expect(parseSpawnSessionInput({ prompt: 'Task', labels }).role).toBeUndefined();
    }
    expect(parseSpawnSessionInput({ prompt: 'Reviewer in prose only' }).role).toBeUndefined();
  });
});
