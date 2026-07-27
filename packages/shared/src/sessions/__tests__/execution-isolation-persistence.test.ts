import { describe, expect, it } from 'bun:test';
import type { SessionExecutionIsolation } from '../../tasks/durable-execution.ts';
import { SESSION_PERSISTENT_FIELDS } from '../types.ts';
import { pickSessionFields } from '../utils.ts';

describe('session persistence: execution isolation', () => {
  it('preserves the complete host-enforced envelope across JSONL projections', () => {
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
    const picked = pickSessionFields({
      id: 'session-1',
      workspaceRootPath: '/tmp/workspace',
      createdAt: 1,
      lastUsedAt: 2,
      executionIsolation,
      ignoredRuntimeField: 'not-persisted',
    });

    expect(picked.executionIsolation).toEqual(executionIsolation);
    expect((picked as Record<string, unknown>).ignoredRuntimeField).toBeUndefined();
  });
});
