import { describe, expect, it } from 'bun:test';
import type { SessionExecutionIsolation } from '../../tasks/durable-execution.ts';
import { SESSION_PERSISTENT_FIELDS } from '../types.ts';
import { pickSessionFields } from '../utils.ts';

describe('session persistence: execution ownership', () => {
  it('preserves the isolation envelope and Mission v2 dispatch identity across JSONL projections', () => {
    const executionIsolation: SessionExecutionIsolation = {
      effect: 'workspace-write',
      policy: {
        workspaceRoot: '/tmp/workspace',
        allowedReadPaths: ['.'],
        allowedWritePaths: ['artifacts'],
        networkAccess: 'disabled',
        allowedHosts: [],
        maxCpuPercent: 80,
        maxMemoryMb: 1024,
        timeoutMs: 30_000,
      },
    };

    expect(SESSION_PERSISTENT_FIELDS).toContain('executionIsolation');
    expect(SESSION_PERSISTENT_FIELDS).toContain('missionDispatchId');
    const picked = pickSessionFields({
      id: 'session-1',
      workspaceRootPath: '/tmp/workspace',
      createdAt: 1,
      lastUsedAt: 2,
      executionIsolation,
      missionId: 'mission-one',
      missionWorkItemId: 'task-one',
      missionDispatchId: 'dispatch-one',
      missionRole: 'worker',
      ignoredRuntimeField: 'not-persisted',
    });

    expect(picked.executionIsolation).toEqual(executionIsolation);
    expect(picked).toMatchObject({
      missionId: 'mission-one',
      missionWorkItemId: 'task-one',
      missionDispatchId: 'dispatch-one',
      missionRole: 'worker',
    });
    expect((picked as Record<string, unknown>).ignoredRuntimeField).toBeUndefined();
  });
});
