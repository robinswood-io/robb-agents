import type { AgentEvent } from '@craft-agent/core/types';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiAgent } from '../pi-agent.ts';
import { ClaudeAgent } from '../claude-agent.ts';
import { parseError } from '../errors.ts';
import { InvalidWorkingDirectoryError } from '../spawn-helpers.ts';
import { createMockBackendConfig, createMockSession, createMockWorkspace } from './test-utils.ts';

describe('persisted invalid working directory', () => {
  let fixture: string;
  beforeEach(() => { fixture = mkdtempSync(join(tmpdir(), 'robb-invalid-cwd-')); });
  afterEach(() => { rmSync(fixture, { recursive: true, force: true }); });

  it('keeps directory names out of provider/auth error heuristics', () => {
    const error = parseError(new InvalidWorkingDirectoryError(join(fixture, '401-network-rate-privacy-abort')));
    expect(error.code).toBe('sdk_cwd_missing');
    expect(error.canRetry).toBe(false);
    expect(error.message).toContain('Select an existing working directory');
    expect(error.message).toContain('For work over SSH');
  });

  it.each(['remote-project', 'abort-401-network-rate-project'])('Pi rejects %s once, before credentials/spawn, and retains resume state', async (name) => {
    const config = createMockBackendConfig({
      provider: 'pi',
      workspace: createMockWorkspace({ rootPath: fixture }),
      session: createMockSession({ workingDirectory: join(fixture, name), sdkCwd: join(fixture, name) }),
      runtime: { paths: { node: process.execPath, piServer: join(fixture, 'never-spawn.ts') } },
    });
    const agent = new PiAgent(config);
    const runtime = agent;
    runtime['emitAutomationEvent'] = async () => {};
    runtime['piSessionId'] = 'existing-transcript';
    const spawn = mock(runtime['spawnSubprocess'].bind(runtime));
    runtime['spawnSubprocess'] = spawn;
    const auth = mock(runtime['getPiAuth'].bind(runtime)).mockRejectedValue(new Error('must not read credentials'));
    runtime['getPiAuth'] = auth;
    const clear = mock(runtime['clearSessionForRecovery'].bind(runtime));
    runtime['clearSessionForRecovery'] = clear;
    try {
      const events = [];
      for await (const event of runtime['chatImpl']('Continue the existing task.')) events.push(event);
      expect(events.map(event => event.type)).toEqual(['typed_error', 'complete']);
      expect((events[0]! as Extract<AgentEvent, { type: 'typed_error' }>).error.code).toBe('sdk_cwd_missing');
      expect((events[0]! as Extract<AgentEvent, { type: 'typed_error' }>).error.canRetry).toBe(false);
      expect((events[0]! as Extract<AgentEvent, { type: 'typed_error' }>).error.message).toContain(join(fixture, name));
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(auth).not.toHaveBeenCalled();
      expect(clear).not.toHaveBeenCalled();
      expect(runtime['piSessionId']).toBe('existing-transcript');
      expect(runtime['subprocess']).toBeNull();
      expect(agent.isProcessing()).toBe(false);

      // The ordinary directory picker updates workingDirectory. No fallback or
      // transcript reset is needed to get past this check on the next attempt.
      agent.updateWorkingDirectory(fixture);
      await expect(runtime['ensureSubprocess']()).rejects.toThrow('must not read credentials');
      expect(auth).toHaveBeenCalledTimes(1);
    } finally {
      spawn.mockRestore(); auth.mockRestore(); clear.mockRestore();
      agent.destroy();
    }
  });

  it('Claude reports a stored remote working directory before SDK setup or fork recovery', async () => {
    // Exercise the actual generator at its first preflight without provider
    // configuration, stored profile reads, or spawning the SDK.
    const agent = Object.create(ClaudeAgent.prototype) as ClaudeAgent;
    agent['config'] = ({ session: { id: 'existing-child', workingDirectory: join(fixture, 'srv-remote') } } satisfies { session: Pick<NonNullable<ClaudeAgent['config']['session']>, 'id' | 'workingDirectory'> }) as ClaudeAgent['config'];
    const resolve = mock(() => { throw new Error('must not reach SDK setup'); });
    agent.resolveSpawnCwd = resolve;
    const events = [];
    for await (const event of agent['chatImpl']('Continue the existing task.')) events.push(event);
    expect(events.map(event => event.type)).toEqual(['typed_error', 'complete']);
    expect((events[0]! as Extract<AgentEvent, { type: 'typed_error' }>).error.code).toBe('sdk_cwd_missing');
    expect((events[0]! as Extract<AgentEvent, { type: 'typed_error' }>).error.canRetry).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
  });
});
