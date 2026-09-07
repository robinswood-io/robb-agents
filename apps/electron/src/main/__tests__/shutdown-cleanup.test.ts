import { expect, it } from 'bun:test';
import { runShutdownCleanup } from '../shutdown-cleanup';

it('continues through synchronous and asynchronous failures to release the runtime lock', async () => {
  const completed: string[] = [];
  const errors: string[] = [];
  await runShutdownCleanup([
    ['flush', async () => { completed.push('persisted'); }],
    ['sessions', async () => { throw new Error('cleanup failed'); }],
    ['browser', () => { throw new TypeError('webContents is destroyed'); }],
    ['messaging', async () => { completed.push('worker-stopped'); }],
    ['lock', () => { completed.push('lock-released'); }],
  ], step => { errors.push(step); });
  expect(completed).toEqual(['persisted', 'worker-stopped', 'lock-released']);
  expect(errors).toEqual(['sessions', 'browser']);
});
