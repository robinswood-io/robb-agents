import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalExecutionIsolationToolInput } from '../../tasks/durable-execution.ts';
import { enforceTaskToolIsolation } from './task-tool-isolation.ts';
import type { MissionCapabilityLock } from '../../sessions/types.ts';

describe('task tool isolation exact Mission reads', () => {
  it('admits only the preflighted MCP tool and canonical input', () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-mission-read-'));
    const input = { server: 'dev', cwd: '/srv/app', command: 'sed -n 1,20p README.md' };
    const isolation = {
      effect: 'read' as const,
      policy: {
        workspaceRoot: root,
        allowedReadPaths: ['.'],
        allowedWritePaths: [],
        allowedReadToolInvocations: [{
          toolName: 'mcp__rbw-servers__ssh_execute',
          inputJson: canonicalExecutionIsolationToolInput(input)!,
        }],
        networkAccess: 'disabled' as const,
        allowedHosts: [],
        maxCpuPercent: 100,
        maxMemoryMb: 512,
        timeoutMs: 60_000,
      },
    };
    try {
      expect(enforceTaskToolIsolation({
        toolName: 'mcp__rbw-servers__ssh_execute',
        input: { ...input, _intent: 'inspect', _displayName: 'Read' },
        workspaceRootPath: root,
        isolation,
      })).toEqual({ allowed: true });
      expect(enforceTaskToolIsolation({
        toolName: 'mcp__rbw-servers__ssh_execute',
        input: { ...input, command: 'touch /srv/app/file' },
        workspaceRootPath: root,
        isolation,
      })).toMatchObject({ allowed: false });

      const missionCapabilityLock: MissionCapabilityLock = {
        schemaVersion: 1,
        capabilityEnvelopeSha256: 'a'.repeat(64),
        capabilities: [
          { kind: 'source', name: 'rbw-servers' },
          { kind: 'tool', name: 'mcp__rbw-servers__ssh_execute' },
        ],
      };
      expect(enforceTaskToolIsolation({
        toolName: 'mcp__rbw-servers__ssh_execute',
        input: { ...input, command: 'touch /srv/app/file' },
        workspaceRootPath: root,
        isolation,
        missionCapabilityLock,
      })).toMatchObject({ allowed: false });
      expect(enforceTaskToolIsolation({
        toolName: 'mcp__rbw-servers__ssh_execute',
        input,
        workspaceRootPath: root,
        isolation,
        missionCapabilityLock,
      })).toEqual({ allowed: true });
      expect(enforceTaskToolIsolation({
        toolName: 'mcp__other__ssh_execute',
        input,
        workspaceRootPath: root,
        isolation,
      })).toMatchObject({ allowed: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
