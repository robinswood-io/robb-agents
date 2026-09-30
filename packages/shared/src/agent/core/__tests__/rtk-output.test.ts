import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

it('validates RTK execution with an isolated app profile', () => {
  const profile = mkdtempSync(join(tmpdir(), 'robb-rtk-profile-'));
  try {
    const result = Bun.spawnSync([process.execPath, 'test', join(import.meta.dir, 'rtk-output.isolated.ts')], {
      env: { ...process.env, CRAFT_CONFIG_DIR: profile }, stdout: 'pipe', stderr: 'pipe',
    });
    expect(new TextDecoder().decode(result.stderr)).not.toContain('(fail)');
    expect(result.exitCode).toBe(0);
  } finally { rmSync(profile, { recursive: true, force: true }); }
});
