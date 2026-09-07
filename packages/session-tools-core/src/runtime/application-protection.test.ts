import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApplicationProtectionProfile, isProtectedApplicationPath, protectApplicationCommand } from './application-protection.ts';

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'robb-application-protection-'));
  scratch.push(dir);
  const parent = join(dir, 'installed');
  const app = join(parent, 'Robb Agents.app');
  mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true });
  const archive = join(app, 'Contents', 'Resources', 'app.asar');
  writeFileSync(archive, 'INTACT');
  const profile = buildApplicationProtectionProfile([app]);
  const run = (script: string) => spawnSync('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-e', `try { ${script} } catch (error) { console.error(String(error)); process.exitCode = 23; }`], { encoding: 'utf8', timeout: 15_000 });
  return { dir, app, parent, archive, profile, run };
}

describe.skipIf(process.platform !== 'darwin')('application protection — real macOS enforcement', () => {
  it('allows reads and ordinary project writes', () => {
    const f = fixture();
    const out = join(f.dir, 'result.txt');
    const result = f.run(`require('fs').writeFileSync(${JSON.stringify(out)}, require('fs').readFileSync(${JSON.stringify(f.archive)}))`);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('INTACT');
  });

  for (const action of ['overwrite', 'unlink', 'chmod', 'rename-bundle', 'rename-parent', 'hardlink', 'symlink', 'descendant', 'encoded-python', 'nested-sandbox'] as const) {
    it(`denies ${action} without touching the archive`, () => {
      const f = fixture();
      const archive = JSON.stringify(f.archive);
      const alias = join(f.dir, 'alias');
      symlinkSync(f.app, alias);
      const scripts: Record<typeof action | string, string> = {
        overwrite: `require('fs').writeFileSync(${archive}, 'BROKEN')`,
        unlink: `require('fs').unlinkSync(${archive})`,
        chmod: `require('fs').chmodSync(${archive}, 0)`,
        'rename-bundle': `require('fs').renameSync(${JSON.stringify(f.app)}, ${JSON.stringify(join(f.dir, 'moved'))})`,
        'rename-parent': `require('fs').renameSync(${JSON.stringify(f.parent)}, ${JSON.stringify(join(f.dir, 'moved'))})`,
        hardlink: `require('fs').linkSync(${archive}, ${JSON.stringify(join(f.dir, 'hardlink'))}); require('fs').writeFileSync(${JSON.stringify(join(f.dir, 'hardlink'))}, 'BROKEN')`,
        symlink: `require('fs').writeFileSync(${JSON.stringify(join(alias, 'Contents/Resources/app.asar'))}, 'BROKEN')`,
        descendant: `require('child_process').execFileSync('/bin/sh', ['-c', ${JSON.stringify(`printf BROKEN > '${f.archive.replace(/'/g, "'\\''")}'`)}])`,
        'encoded-python': `require('child_process').execFileSync('/usr/bin/python3', ['-c', ${JSON.stringify(`import base64; exec(base64.b64decode('${Buffer.from(`open(${JSON.stringify(f.archive)}, 'w').write('BROKEN')`).toString('base64')}'))`)}])`,
        'nested-sandbox': `require('child_process').execFileSync('/usr/bin/sandbox-exec', ['-p', '(version 1) (allow default)', '/bin/sh', '-c', ${JSON.stringify(`printf BROKEN > '${f.archive.replace(/'/g, "'\\''")}'`)}])`,
      };
      const result = f.run(scripts[action]!);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/not permitted|denied|EPERM|EACCES/i);
      expect(readFileSync(f.archive, 'utf8')).toBe('INTACT');
    });
  }

  it('cannot bypass path checks with a symlink or a future file', () => {
    const f = fixture();
    const alias = join(f.dir, 'alias');
    symlinkSync(f.app, alias);
    expect(isProtectedApplicationPath(join(alias, 'Contents/new/file'), [f.app])).toBe(true);
    expect(isProtectedApplicationPath(f.parent, [f.app])).toBe(true);
    expect(isProtectedApplicationPath(join(f.dir, 'project/file'), [f.app])).toBe(false);
  });

  it('does not start an invalid profile or fall back to an unprotected command', () => {
    const f = fixture();
    const marker = join(f.dir, 'must-not-exist');
    const result = spawnSync('/usr/bin/sandbox-exec', ['-p', `${f.profile}\n(invalid-policy)`, '/usr/bin/touch', marker]);
    expect(result.status).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(protectApplicationCommand('/usr/bin/true').command).toBe('/usr/bin/sandbox-exec');
  });
});
