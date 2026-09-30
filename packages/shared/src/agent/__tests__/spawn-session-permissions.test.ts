import { describe, expect, it } from 'bun:test';
import { BaseAgent, type SpawnSessionRequest, type SpawnSessionResult } from '../base-agent.ts';
import {
  cleanupModeState,
  formatSessionState,
  getPermissionModeDiagnostics,
  hydratePreviousPermissionMode,
  initializeModeState,
  setPermissionMode,
} from '../mode-manager.ts';
import { requirePermissionMode } from '../mode-types.ts';
import { SpawnSessionSchema } from '../../../../session-tools-core/src/tool-defs.ts';

// Exercise the actual shared tool boundary without constructing a backend,
// creating a stored session, or contacting a model/provider.
const spawn = (BaseAgent.prototype as unknown as {
  preExecuteSpawnSession(input: Record<string, unknown>): Promise<SpawnSessionResult>;
}).preExecuteSpawnSession;

describe('spawn_session permission boundary', () => {
  it.each([
    ['safe', 'safe'],
    ['ask', 'ask'],
    ['allow-all', 'allow-all'],
  ] as const)('normalizes %s before creating the child and building session_state', async (input, expected) => {
    const sessionId = `spawn-permission-${input}`;
    const requests: SpawnSessionRequest[] = [];
    const context = {
      onSpawnSession: async (request: SpawnSessionRequest) => {
        requests.push(request);
        initializeModeState(sessionId, request.permissionMode!);
        // The production error occurred here, before sending the provider prompt.
        expect(() => formatSessionState(sessionId)).not.toThrow();
        return { sessionId } as SpawnSessionResult;
      },
    };
    try {
      const result = await spawn.call(context, {
        prompt: 'Read the supplied note.',
        permissionMode: input,
      });
      expect(result.sessionId).toBe(sessionId);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        permissionMode: expected,
      });
      expect(getPermissionModeDiagnostics(sessionId).permissionMode).toBe(expected);
      expect(SpawnSessionSchema.safeParse({ prompt: 'Read the supplied note.', permissionMode: input }).success).toBe(true);
    } finally {
      cleanupModeState(sessionId);
    }
  });

  it('leaves an omitted mode unset so the host inherits the parent choice', async () => {
    let request: SpawnSessionRequest | undefined;
    await spawn.call({ onSpawnSession: async (value: SpawnSessionRequest) => {
      request = value;
      return { sessionId: 'inherited-child' } as SpawnSessionResult;
    } }, { prompt: 'Read the supplied note.' });
    expect(request?.permissionMode).toBeUndefined();
  });

  it.each(['explore', 'execute', 'unknown', '', 'ALLOW EVERYTHING', null, 1, {}, []])('rejects invalid mode %j before invoking the host', async (permissionMode) => {
    let created = false;
    const context = { onSpawnSession: async () => {
      created = true;
      return { sessionId: 'must-not-exist' } as SpawnSessionResult;
    } };
    await expect(spawn.call(context, { prompt: 'Read the supplied note.', permissionMode }))
      .rejects.toThrow('Invalid spawn_session arguments');
    expect(created).toBe(false);
    expect(SpawnSessionSchema.safeParse({ prompt: 'Read the supplied note.', permissionMode }).success).toBe(false);
  });
});

describe('permission state accepts only normalized runtime values', () => {
  it('rejects source caller aliases before diagnostics and enforcement use them', () => {
    const sessionId = 'mode-caller-alias';
    try {
      expect(() => initializeModeState(sessionId, 'explore' as never)).toThrow('Invalid permission mode');
      expect(() => initializeModeState(sessionId, 'execute' as never)).toThrow('Invalid permission mode');
    } finally {
      cleanupModeState(sessionId);
    }
  });

  it('rejects unknown caller values without changing the last authorized mode', () => {
    const sessionId = 'mode-caller-invalid';
    try {
      initializeModeState(sessionId, 'safe');
      const before = getPermissionModeDiagnostics(sessionId);
      expect(() => setPermissionMode(sessionId, 'unknown' as never)).toThrow('Invalid permission mode');
      expect(getPermissionModeDiagnostics(sessionId)).toEqual(before);
      expect(formatSessionState(sessionId)).toContain('permissionMode: explore');
    } finally {
      cleanupModeState(sessionId);
    }
  });

  it('normalizes legacy transition metadata and drops unknown labels without changing authority', () => {
    const sessionId = 'mode-transition-legacy';
    try {
      initializeModeState(sessionId, 'safe');
      hydratePreviousPermissionMode(sessionId, 'execute' as never);
      expect(getPermissionModeDiagnostics(sessionId).transitionDisplay).toBe('Execute -> Explore');
      hydratePreviousPermissionMode(sessionId, 'unrecognized-mode' as never);
      expect(getPermissionModeDiagnostics(sessionId).previousPermissionMode).toBeUndefined();
      expect(getPermissionModeDiagnostics(sessionId).permissionMode).toBe('safe');
      expect(() => formatSessionState(sessionId)).not.toThrow();
    } finally {
      cleanupModeState(sessionId);
    }
  });

  it('uses the existing known alias parser and rejects every unknown type', () => {
    expect(requirePermissionMode(' EXECUTE ')).toBe('allow-all');
    expect(requirePermissionMode('ask-to-edit')).toBe('ask');
    for (const value of [undefined, null, {}, [], 0, false, 'unknown']) {
      expect(() => requirePermissionMode(value)).toThrow('Invalid permissionMode');
    }
  });
});
