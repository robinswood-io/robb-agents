import { expect, it } from 'bun:test';
import { rollbackFailedBranchCreation } from './session-branch-cleanup.ts';

it('waits for asynchronous runtime cleanup before removing the failed branch', async () => {
  const steps: string[] = [];
  let releaseStop: () => void = () => {};
  const stopGate = new Promise<void>(resolve => { releaseStop = resolve; });
  const cleanup = rollbackFailedBranchCreation({
    managed: {
      agent: { destroy: async () => { steps.push('agent'); } },
      poolServer: { stop: async () => {
        steps.push('pool-start');
        await stopGate;
        steps.push('pool-stopped');
      } },
    },
    workspaceRootPath: '/fixture', sessionId: 'failed-branch',
    deleteFromRuntimeSessions: () => { steps.push('runtime-removed'); },
    deleteStoredSession: async () => { steps.push('storage-removed'); },
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(steps).toEqual(['agent', 'pool-start']);
  releaseStop();
  await cleanup;
  expect(steps).toEqual(['agent', 'pool-start', 'pool-stopped', 'runtime-removed', 'storage-removed']);
});

it('observes asynchronous cleanup failures and still removes the failed branch', async () => {
  const removed: string[] = [];
  await expect(rollbackFailedBranchCreation({
    managed: {
      agent: { destroy: async () => { throw new Error('fixture agent stop failure'); } },
      poolServer: { stop: async () => { throw new Error('fixture pool stop failure'); } },
    },
    workspaceRootPath: '/fixture', sessionId: 'failed-branch',
    deleteFromRuntimeSessions: id => { removed.push(id); },
    deleteStoredSession: async () => { removed.push('storage'); },
  })).resolves.toBeUndefined();
  expect(removed).toEqual(['failed-branch', 'storage']);
});
