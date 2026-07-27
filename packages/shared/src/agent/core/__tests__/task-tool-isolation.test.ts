import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionExecutionIsolation } from '../../../tasks/durable-execution.ts';
import { enforceTaskToolIsolation } from '../task-tool-isolation.ts';

let root = '';
let outside = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'robb-task-isolation-'));
  outside = mkdtempSync(join(tmpdir(), 'robb-task-outside-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'artifacts'));
  writeFileSync(join(root, 'src', 'input.txt'), 'input');
  writeFileSync(join(outside, 'secret.txt'), 'secret');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function isolation(effect: SessionExecutionIsolation['effect']): SessionExecutionIsolation {
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

function decide(
  toolName: string,
  input: Record<string, unknown>,
  effect: SessionExecutionIsolation['effect'] = 'read',
) {
  return enforceTaskToolIsolation({
    toolName,
    input,
    workspaceRootPath: root,
    workingDirectory: join(root, 'src'),
    isolation: isolation(effect),
  });
}

describe('task tool isolation', () => {
  it('allows reads only in configured paths', () => {
    expect(decide('Read', { file_path: join(root, 'src', 'input.txt') }).allowed).toBe(true);
    expect(decide('Glob', { pattern: '**/*.txt' }).allowed).toBe(true);
    expect(decide('Grep', { pattern: 'input', path: join(root, 'artifacts') }).allowed).toBe(true);
    expect(decide('Read', { file_path: join(root, 'task.yaml') }).allowed).toBe(false);
  });

  it('rejects traversal and symbolic-link escapes', () => {
    expect(decide('Read', { file_path: join(root, 'src', '..', '..', 'outside.txt') }).allowed).toBe(false);
    symlinkSync(outside, join(root, 'src', 'escape'));
    expect(decide('Read', { file_path: join(root, 'src', 'escape', 'secret.txt') }).allowed).toBe(false);
  });

  it('allows writes only for workspace-write nodes and configured targets', () => {
    const target = join(root, 'artifacts', 'report.md');
    expect(decide('Write', { file_path: target, content: 'ok' }, 'workspace-write').allowed).toBe(true);
    expect(decide('Edit', { file_path: target }, 'read').allowed).toBe(false);
    expect(decide('Write', { file_path: join(root, 'src', 'input.txt') }, 'workspace-write').allowed).toBe(false);
    expect(decide('NotebookEdit', {}, 'workspace-write').allowed).toBe(false);
  });

  it('blocks shell, network, browser, nested-agent, direct MCP, and unknown tools', () => {
    for (const toolName of [
      'Bash',
      'WebFetch',
      'WebSearch',
      'browser_tool',
      'Task',
      'TaskOutput',
      'mcp__session__call_llm',
      'mcp__google__drive_search',
      'FuturePowerTool',
    ]) {
      expect(decide(toolName, {}).allowed).toBe(false);
    }
  });

  it('allows only reviewed local state tools and rejects all tools for external mutation nodes', () => {
    expect(decide('TodoWrite', {}).allowed).toBe(true);
    expect(decide('Skill', { skill: 'reviewed-skill' }).allowed).toBe(true);
    expect(decide('Read', { file_path: join(root, 'src', 'input.txt') }, 'external-mutation').allowed).toBe(false);
  });
});
