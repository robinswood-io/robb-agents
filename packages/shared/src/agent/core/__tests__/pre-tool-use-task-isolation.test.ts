import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setPermissionMode } from '../../mode-manager.ts';
import type { SessionExecutionIsolation } from '../../../tasks/durable-execution.ts';
import {
  runPreToolUseChecks,
  type PermissionManagerLike,
  type PreToolUseInput,
} from '../pre-tool-use.ts';

let root = '';
let sessionId = '';

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: (command) => command.split(/\s+/)[0] ?? command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'robb-pretool-isolation-'));
  sessionId = `task-isolation-${randomUUID()}`;
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'artifacts'));
  writeFileSync(join(root, 'src', 'input.txt'), 'input');
  setPermissionMode(sessionId, 'allow-all', { changedBy: 'restore' });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function envelope(effect: SessionExecutionIsolation['effect']): SessionExecutionIsolation {
  return {
    effect,
    policy: {
      workspaceRoot: root,
      allowedReadPaths: ['src', 'artifacts'],
      allowedWritePaths: ['artifacts'],
      networkAccess: 'disabled',
      allowedHosts: [],
      maxCpuPercent: 100,
      maxMemoryMb: 1024,
      timeoutMs: 60_000,
    },
  };
}

function check(
  toolName: string,
  input: Record<string, unknown>,
  effect: SessionExecutionIsolation['effect'] = 'read',
) {
  const ctx: PreToolUseInput = {
    toolName,
    input,
    sessionId,
    permissionMode: 'allow-all',
    workspaceRootPath: root,
    workspaceId: 'workspace-1',
    workingDirectory: join(root, 'src'),
    executionIsolation: envelope(effect),
    activeSourceSlugs: [],
    allSourceSlugs: [],
    hasSourceActivation: false,
    permissionManager,
  };
  return runPreToolUseChecks(ctx);
}

describe('central pre-tool pipeline task isolation', () => {
  it('enforces read and write paths even in allow-all mode', () => {
    expect(check('Read', { file_path: join(root, 'src', 'input.txt') }).type).toBe('allow');
    expect(check('Read', { file_path: join(root, 'task.yaml') }).type).toBe('block');
    expect(check(
      'Write',
      { file_path: join(root, 'artifacts', 'report.md'), content: 'report' },
      'workspace-write',
    ).type).toBe('allow');
    expect(check(
      'Write',
      { file_path: join(root, 'src', 'output.txt'), content: 'output' },
      'workspace-write',
    ).type).toBe('block');
  });

  it('blocks direct network and process execution before source activation or prompting', () => {
    const bash = check('Bash', { command: 'curl https://example.com' });
    expect(bash.type).toBe('block');
    if (bash.type === 'block') expect(bash.reason).toContain('task isolation allow-list');

    const mcp = check('mcp__google__drive_search', { query: 'secret' });
    expect(mcp.type).toBe('block');
    if (mcp.type === 'block') expect(mcp.reason).toContain('task isolation allow-list');
  });
});
