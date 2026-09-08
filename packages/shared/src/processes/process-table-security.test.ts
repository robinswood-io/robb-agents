import { describe, expect, it } from 'bun:test';
import { getSuspectedOrphanPidsFromProcessTable } from './long-running-supervisor.ts';

describe('process table parsing (CodeQL #71)', () => {
  it('preserves process ownership, tracked children and Electron helper filtering', () => {
    const output = [
      ' PID PPID COMMAND',
      ' 11\t2\tworker --argument with spaces',
      ' 12 2 tracked worker',
      ' 13 3 other parent',
      ' 14 2 /Applications/Robb.app/Contents/Frameworks/Helper --type=renderer',
      ' malformed input',
    ].join('\n');
    const first = getSuspectedOrphanPidsFromProcessTable(output, 2, new Set([12]), new Map(), '/Applications/Robb.app/Contents/MacOS/Robb');
    expect(first.pids).toEqual([]);
    expect([...first.sightings.keys()]).toEqual([11]);
    const second = getSuspectedOrphanPidsFromProcessTable(output, 2, new Set([12]), first.sightings, '/Applications/Robb.app/Contents/MacOS/Robb');
    expect(second.pids).toEqual([11]);
  });

  it('bounds adversarial whitespace parsing in a separately timed process', () => {
    const modulePath = new URL('./long-running-supervisor.ts', import.meta.url).pathname;
    const script = `
      import { getSuspectedOrphanPidsFromProcessTable } from ${JSON.stringify(modulePath)};
      const output = '1 2' + '\\t'.repeat(200000) + 'worker\\r!';
      const result = getSuspectedOrphanPidsFromProcessTable(output, 2, new Set(), new Map([[1, 1]]));
      console.log(JSON.stringify(result.pids));
    `;
    // A child timeout also bounds the vulnerable pre-fix baseline; a synchronous
    // regexp cannot be interrupted by the test runner's own timeout.
    const child = Bun.spawnSync([process.execPath, '-e', script], {
      timeout: 5_000,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeUndefined();
    expect(JSON.parse(new TextDecoder().decode(child.stdout))).toEqual([1]);
  }, 10_000);
});
