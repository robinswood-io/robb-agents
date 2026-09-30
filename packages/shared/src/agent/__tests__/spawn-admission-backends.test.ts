import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PiAgent } from '../pi-agent.ts';
import { createSpawnSessionTool } from '../spawn-session-tool.ts';
import { createMockBackendConfig } from './test-utils.ts';
import type { PrerequisiteManager } from '../core/prerequisite-manager.ts';

describe('backend spawn admission', () => {
  it('Pi help exposes explicit reviewer selection without dispatch or reading the real profile', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'spawn-role-help-'));
    try {
      const script = `
        const { PiAgent } = await import(${JSON.stringify(new URL('../pi-agent.ts', import.meta.url).href)});
        const { createMockBackendConfig } = await import(${JSON.stringify(new URL('./test-utils.ts', import.meta.url).href)});
        const config = createMockBackendConfig({ provider: 'pi' });
        config.workspace.rootPath = process.env.CRAFT_CONFIG_DIR;
        config.session.workspaceRootPath = process.env.CRAFT_CONFIG_DIR;
        const agent = new PiAgent(config);
        agent.onSpawnSession = () => { throw new Error('Help must not spawn'); };
        const result = await agent.executeSessionTool('spawn_session', { help: true });
        process.stdout.write(JSON.stringify(result));
      `;
      const child = spawnSync(process.execPath, ['-e', script], {
        env: { ...process.env, CRAFT_CONFIG_DIR: fixture }, encoding: 'utf8', timeout: 15_000,
      });
      expect(child.status).toBe(0);
      const result = JSON.parse(child.stdout);
      expect(result.isError).toBe(false);
      const help = JSON.parse(result.content);
      expect(help.roleHelp.defaultRole).toBe('worker');
      expect(help.roleHelp.reviewerExample).toMatchObject({ role: 'reviewer', permissionMode: 'safe' });
      expect(help.roleHelp.roles.reviewer).toContain('cannot delegate');
      expect(help.roleHelp.legacyLabel).toContain('Explicit role always wins');
      expect(help.defaults.permissionMode).toBe('ask');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('both backend dispatches resolve the exact legacy label without overriding an explicit worker', async () => {
    const agent = new PiAgent(createMockBackendConfig({ provider: 'pi' }));
    const requests: unknown[] = [];
    const callback = async (request: unknown) => {
      requests.push(request);
      return { sessionId: 'accepted', name: 'accepted', status: 'started' as const };
    };
    agent.onSpawnSession = callback;
    const backend = agent as unknown as {
      executeSessionTool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean }>;
    };
    const definition = createSpawnSessionTool({ sessionId: 'test', getSpawnSessionFn: () => callback });
    const handler = (definition as unknown as {
      handler(input: unknown): Promise<{ isError?: boolean }>;
    }).handler;
    for (const dispatch of [
      (input: Record<string, unknown>) => backend.executeSessionTool('spawn_session', input),
      handler,
    ]) {
      expect((await dispatch({ prompt: 'Inspect final evidence', labels: ['reviewer'] })).isError).not.toBe(true);
      expect(requests.at(-1)).toMatchObject({ labels: ['reviewer'], role: 'reviewer' });
      expect((await dispatch({ prompt: 'Bounded task', labels: ['reviewer'], role: 'worker' })).isError).not.toBe(true);
      expect(requests.at(-1)).toMatchObject({ role: 'worker' });
    }
    expect(requests).toHaveLength(4);
  });

  it('Pi returns a structured rejection before dispatch, then admits a corrected request once', async () => {
    const agent = new PiAgent(createMockBackendConfig({ provider: 'pi' }));
    const requests: unknown[] = [];
    agent.onSpawnSession = async request => {
      requests.push(request);
      return { sessionId: 'accepted', name: 'accepted', status: 'started' };
    };
    const backend = agent as unknown as {
      executeSessionTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }>;
    };
    const rejected = await backend.executeSessionTool('spawn_session', { prompt: 'Inspect evidence', permissionMode: 'read-only' });
    expect(rejected.isError).toBe(true);
    expect(JSON.parse(rejected.content)).toMatchObject({ code: 'invalid_spawn_session_arguments', retryable: false });
    expect(requests).toHaveLength(0);
    const accepted = await backend.executeSessionTool('spawn_session', { prompt: 'Inspect evidence', permissionMode: 'safe', role: 'reviewer' });
    expect(accepted.isError).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ permissionMode: 'safe', role: 'reviewer' });
  });

  it('Claude standalone uses the same admission checks even when a caller bypasses SDK schema parsing', async () => {
    const requests: unknown[] = [];
    const definition = createSpawnSessionTool({ sessionId: 'test', getSpawnSessionFn: () => async input => {
      requests.push(input);
      return { sessionId: 'accepted', name: 'accepted', status: 'started' };
    } });
    const handler = (definition as unknown as {
      handler(input: unknown): Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
    }).handler;
    const rejected = await handler({ prompt: 'Inspect evidence', permissionMode: 'execute' });
    expect(rejected.isError).toBe(true);
    expect(JSON.parse(rejected.content[0]!.text)).toMatchObject({ code: 'invalid_spawn_session_arguments', retryable: false });
    expect(requests).toHaveLength(0);
    const accepted = await handler({ prompt: 'Inspect evidence', permissionMode: 'safe', role: 'reviewer', projectId: 'project-1' });
    expect(accepted.isError).not.toBe(true);
    expect(requests[0]).toMatchObject({ permissionMode: 'safe', role: 'reviewer', projectId: 'project-1' });
  });
});

describe('Pi prerequisite result integration', () => {
  it('credits successful read results, preserving the gate after a start, error or checkpoint', () => {
    const agent = new PiAgent(createMockBackendConfig({ provider: 'pi' }));
    const backend = agent as unknown as {
      prerequisiteManager: PrerequisiteManager;
      handleSubprocessEvent(event: Record<string, unknown>): void;
    };
    const manager = backend.prerequisiteManager;
    const path = '/test/workspace/skills/review/SKILL.md';
    manager.registerSkillPrerequisites([path]);
    const start = (id: string) => backend.handleSubprocessEvent({ type: 'tool_execution_start', toolCallId: id, toolName: 'read', args: { path } });
    const finish = (id: string, isError: boolean, details = {}) => backend.handleSubprocessEvent({
      type: 'tool_execution_end', toolCallId: id, toolName: 'read', isError,
      result: { content: [{ type: 'text', text: 'Complete instruction document' }], details },
    });
    start('failed-read');
    expect(manager.checkPrerequisites('WebSearch').allowed).toBe(false);
    finish('failed-read', true);
    expect(manager.checkPrerequisites('WebSearch').allowed).toBe(false);
    start('checkpoint-read');
    finish('checkpoint-read', false, { executed: false });
    expect(manager.checkPrerequisites('WebSearch').allowed).toBe(false);
    start('completed-read');
    finish('completed-read', false);
    expect(manager.checkPrerequisites('WebSearch').allowed).toBe(true);
  });
});
