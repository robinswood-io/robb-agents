import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

it('validates all native session watcher lifecycles in the Node runtime used by the host', async () => {
  const root = mkdtempSync(join(tmpdir(), 'robb-node-watcher-suite-'));
  try {
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, 'sessions-file-watches.node-fixture.ts')],
      outdir: root, target: 'node', format: 'cjs', naming: 'watchers.cjs',
    });
    expect(result.success, result.logs.map(message => message.message).join('\n')).toBe(true);
    const child = Bun.spawn(['node', '--test', '--test-reporter=tap', join(root, 'watchers.cjs')], {
      env: { ...process.env, CRAFT_CONFIG_DIR: join(root, 'profile') }, stdout: 'pipe', stderr: 'pipe',
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(exit, stdout + stderr).toBe(0);
    expect(stdout).toMatch(/^# tests 5$/m);
    expect(stdout).toMatch(/^# pass 5$/m);
    expect(stdout).toMatch(/^# fail 0$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
