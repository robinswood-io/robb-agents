import { describe, expect, it } from 'bun:test';
import { createProtectedClaudeSpawner } from '../claude-process.ts';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe.skipIf(process.platform !== 'darwin')('protected Claude process', () => {
  it('preserves stdout/stderr and blocks bundle writes at the SDK spawn boundary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-claude-spawn-'));
    const resources = join(root, 'Robb Agents.app/Contents/Resources');
    mkdirSync(resources, { recursive: true });
    const archive = join(resources, 'app.asar');
    writeFileSync(archive, 'INTACT');
    const host = process as unknown as { resourcesPath?: string };
    const previous = host.resourcesPath;
    try {
      host.resourcesPath = resources;
      let stderr = '';
      const child = createProtectedClaudeSpawner(data => { stderr += data; })({
        command: '/bin/sh', args: ['-c', 'printf ready; printf diagnostic >&2; printf BROKEN > "$1"', 'probe', archive],
        env: {}, signal: new AbortController().signal,
      });
      let stdout = '';
      child.stdout.on('data', data => { stdout += data.toString(); });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', resolve);
      });
      expect(code).not.toBe(0);
      expect(stdout).toBe('ready');
      expect(stderr).toContain('diagnostic');
      expect(stderr).toMatch(/not permitted|denied/);
      expect(readFileSync(archive, 'utf8')).toBe('INTACT');
    } finally {
      if (previous === undefined) delete host.resourcesPath; else host.resourcesPath = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
