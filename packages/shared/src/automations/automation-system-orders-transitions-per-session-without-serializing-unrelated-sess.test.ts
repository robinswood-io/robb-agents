/**
 * Tests for AutomationSystem facade
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AutomationSystem } from './automation-system.ts';
import { AUTOMATIONS_CONFIG_FILE } from './constants.ts';

describe('AutomationSystem', () => {
let tempDir: string;

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'automation-system-test-'));
  });

afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

describe('updateSessionMetadata', () => {
it('orders transitions per session without serializing unrelated sessions', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });
      system.setInitialSessionMetadata('session-1', { sessionStatus: 'todo' });
      system.setInitialSessionMetadata('session-2', { sessionStatus: 'todo' });
      let releaseFirst!: () => void;
      const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve; });
      let firstEntered!: () => void;
      const entered = new Promise<void>(resolve => { firstEntered = resolve; });
      const transitions: string[] = [];
      system.eventBus.on('SessionStatusChange', async payload => {
        transitions.push(`${payload.sessionId}:${payload.oldState}->${payload.newState}`);
        if (payload.sessionId === 'session-1' && payload.newState === 'in-progress') {
          firstEntered();
          await firstHeld;
        }
      });

      const first = system.updateSessionMetadata('session-1', { sessionStatus: 'in-progress' });
      await entered;
      const nextSameSession = system.updateSessionMetadata('session-1', { sessionStatus: 'needs-review' });
      const unrelated = await system.updateSessionMetadata('session-2', { sessionStatus: 'done' });

      expect(unrelated).toEqual(['SessionStatusChange']);
      expect(transitions).toEqual([
        'session-1:todo->in-progress',
        'session-2:todo->done',
      ]);
      releaseFirst();
      expect(await Promise.all([first, nextSameSession])).toEqual([
        ['SessionStatusChange'],
        ['SessionStatusChange'],
      ]);
      expect(transitions).toEqual([
        'session-1:todo->in-progress',
        'session-2:todo->done',
        'session-1:in-progress->needs-review',
      ]);

      await system.dispose();
    });

it('does not resurrect removed metadata from running or queued updates', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });
      system.setInitialSessionMetadata('session-1', { sessionStatus: 'todo' });
      let releaseFirst!: () => void;
      const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve; });
      let firstEntered!: () => void;
      const entered = new Promise<void>(resolve => { firstEntered = resolve; });
      const transitions: string[] = [];
      system.eventBus.on('SessionStatusChange', async payload => {
        transitions.push(`${payload.oldState}->${payload.newState}`);
        if (payload.newState === 'in-progress') {
          firstEntered();
          await firstHeld;
        }
      });

      const running = system.updateSessionMetadata('session-1', { sessionStatus: 'in-progress' });
      await entered;
      const queued = system.updateSessionMetadata('session-1', { sessionStatus: 'needs-review' });
      system.removeSessionMetadata('session-1');

      expect(system.getSessionMetadata('session-1')).toBeUndefined();
      releaseFirst();
      expect(await Promise.all([running, queued])).toEqual([
        ['SessionStatusChange'],
        [],
      ]);
      expect(transitions).toEqual(['todo->in-progress']);
      expect(system.getSessionMetadata('session-1')).toBeUndefined();

      await system.dispose();
    });

it('does not overwrite a fresh initial snapshot with stale queued updates', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });
      system.setInitialSessionMetadata('session-1', { sessionStatus: 'todo' });
      let releaseFirst!: () => void;
      const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve; });
      let firstEntered!: () => void;
      const entered = new Promise<void>(resolve => { firstEntered = resolve; });
      const transitions: string[] = [];
      system.eventBus.on('SessionStatusChange', async payload => {
        transitions.push(`${payload.oldState}->${payload.newState}`);
        if (payload.newState === 'in-progress') {
          firstEntered();
          await firstHeld;
        }
      });

      const running = system.updateSessionMetadata('session-1', { sessionStatus: 'in-progress' });
      await entered;
      const queued = system.updateSessionMetadata('session-1', { sessionStatus: 'needs-review' });
      system.setInitialSessionMetadata('session-1', { sessionStatus: 'done' });

      releaseFirst();
      expect(await Promise.all([running, queued])).toEqual([
        ['SessionStatusChange'],
        [],
      ]);
      expect(transitions).toEqual(['todo->in-progress']);
      expect(system.getSessionMetadata('session-1')?.sessionStatus).toBe('done');

      await system.dispose();
    });

it('invalidates running and queued metadata updates when disposed', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });
      system.setInitialSessionMetadata('session-1', { sessionStatus: 'todo' });
      let releaseFirst!: () => void;
      const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve; });
      let firstEntered!: () => void;
      const entered = new Promise<void>(resolve => { firstEntered = resolve; });
      const transitions: string[] = [];
      system.eventBus.on('SessionStatusChange', async payload => {
        transitions.push(`${payload.oldState}->${payload.newState}`);
        if (payload.newState === 'in-progress') {
          firstEntered();
          await firstHeld;
        }
      });

      const running = system.updateSessionMetadata('session-1', { sessionStatus: 'in-progress' });
      await entered;
      const queued = system.updateSessionMetadata('session-1', { sessionStatus: 'needs-review' });
      const disposing = system.dispose();

      expect(system.isDisposed()).toBe(true);
      await disposing;
      expect(system.getSessionMetadata('session-1')).toBeUndefined();
      releaseFirst();
      expect(await Promise.all([running, queued])).toEqual([
        ['SessionStatusChange'],
        [],
      ]);
      expect(transitions).toEqual(['todo->in-progress']);
      expect(await system.updateSessionMetadata('session-1', { sessionStatus: 'done' })).toEqual([]);
      expect(system.getSessionMetadata('session-1')).toBeUndefined();
    });

it('should not emit events when metadata unchanged', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      system.setInitialSessionMetadata('session-1', {
        permissionMode: 'explore',
        labels: ['label-1'],
        isFlagged: false,
      });

      const emitSpy = spyOn(system.eventBus, 'emit');

      const events = await system.updateSessionMetadata('session-1', {
        permissionMode: 'explore',
        labels: ['label-1'],
        isFlagged: false,
      });

      expect(events).toEqual([]);
      expect(emitSpy).not.toHaveBeenCalled();

      await system.dispose();
    });

it('should update stored metadata', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      await system.updateSessionMetadata('session-1', {
        permissionMode: 'execute',
        labels: ['label-1'],
      });

      const stored = system.getSessionMetadata('session-1');
      expect(stored?.permissionMode).toBe('execute');
      expect(stored?.labels).toEqual(['label-1']);

      await system.dispose();
    });
});

describe('removeSessionMetadata', () => {
it('should remove stored metadata', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      system.setInitialSessionMetadata('session-1', {
        permissionMode: 'explore',
      });

      expect(system.getSessionMetadata('session-1')).toBeDefined();

      system.removeSessionMetadata('session-1');

      expect(system.getSessionMetadata('session-1')).toBeUndefined();
      expect((system as unknown as {
        sessionMetadataTokens: Map<string, object>;
      }).sessionMetadataTokens.size).toBe(0);

      await system.dispose();
    });
});

describe('emitLabelConfigChange', () => {
it('should emit LabelConfigChange event', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const emitSpy = spyOn(system.eventBus, 'emit');

      await system.emitLabelConfigChange();

      expect(emitSpy).toHaveBeenCalledWith('LabelConfigChange', expect.objectContaining({
        workspaceId: 'test-workspace',
      }));

      await system.dispose();
    });
});

describe('executeAgentEvent', () => {
it('should match agent events when matcher and conditions pass', async () => {
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          PreToolUse: [
            {
              matcher: '^Bash$',
              conditions: [{ condition: 'state', field: 'hook_event_name', value: 'PreToolUse' }],
              actions: [{ type: 'prompt', prompt: 'check this' }],
            },
          ],
        },
      }));

      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const matched = await system.executeAgentEvent('PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
      });

      expect(matched).toBe(1);
      await system.dispose();
    });

it('should not match agent events when conditions fail', async () => {
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          PreToolUse: [
            {
              matcher: '^Bash$',
              conditions: [{ condition: 'state', field: 'hook_event_name', value: 'PostToolUse' }],
              actions: [{ type: 'prompt', prompt: 'check this' }],
            },
          ],
        },
      }));

      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const matched = await system.executeAgentEvent('PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
      });

      expect(matched).toBe(0);
      await system.dispose();
    });
});

describe('buildSdkHooks', () => {
it('should return empty object (command execution removed)', async () => {
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          PreToolUse: [
            { matcher: 'Bash', actions: [{ type: 'prompt', prompt: 'check this' }] },
          ],
        },
      }));

      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const result = system.buildSdkHooks();
      expect(result).toEqual({});

      await system.dispose();
    });
});

describe('dispose', () => {
it('should clean up all resources', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      system.setInitialSessionMetadata('session-1', { permissionMode: 'explore' });

      await system.dispose();

      expect(system.isDisposed()).toBe(true);
      expect(system.eventBus.isDisposed()).toBe(true);
      expect(system.getSessionMetadata('session-1')).toBeUndefined();
    });

it('should be idempotent', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      await system.dispose();
      await system.dispose(); // Should not throw
      expect(system.isDisposed()).toBe(true);
    });

it('makes concurrent dispose calls join the same teardown', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });
      const eventLogHandler = (system as unknown as {
        eventLogHandler: { dispose(): Promise<void> } | null;
      }).eventLogHandler;
      expect(eventLogHandler).not.toBeNull();
      const originalDispose = eventLogHandler!.dispose.bind(eventLogHandler);
      let releaseDispose!: () => void;
      const disposeHeld = new Promise<void>(resolve => { releaseDispose = resolve; });
      let disposeEntered!: () => void;
      const entered = new Promise<void>(resolve => { disposeEntered = resolve; });
      spyOn(eventLogHandler!, 'dispose').mockImplementation(async () => {
        disposeEntered();
        await disposeHeld;
        await originalDispose();
      });

      const first = system.dispose();
      await entered;
      const concurrent = system.dispose();
      let concurrentSettled = false;
      void concurrent.then(() => { concurrentSettled = true; });
      await Promise.resolve();

      expect(concurrent).toBe(first);
      expect(concurrentSettled).toBe(false);
      expect(system.eventBus.isDisposed()).toBe(false);
      releaseDispose();
      await Promise.all([first, concurrent]);
      expect(concurrentSettled).toBe(true);
      expect(system.eventBus.isDisposed()).toBe(true);
    });
});
});
