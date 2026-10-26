import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyPiAgentServer, type BuildConfig } from '../build/common.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(withNativeBinary: boolean) {
  const rootDir = mkdtempSync(join(tmpdir(), 'robb-runtime-assets-'));
  directories.push(rootDir);
  const electronDir = join(rootDir, 'apps', 'electron');
  const config: BuildConfig = {
    rootDir, electronDir, platform: 'darwin', arch: 'arm64',
    upload: false, uploadLatest: false, uploadScript: false,
  };
  const source = join(rootDir, 'packages', 'pi-agent-server', 'dist');
  mkdirSync(source, { recursive: true });
  for (const name of ['index.js', 'antigravity-server.js', 'vibe-acp-server.js']) {
    writeFileSync(join(source, name), `// QA runtime ${name}\n`);
  }
  const koffi = join(rootDir, 'node_modules', 'koffi');
  const native = join(koffi, 'build', 'koffi', 'darwin_arm64');
  const other = join(koffi, 'build', 'koffi', 'linux_x64');
  mkdirSync(native, { recursive: true });
  mkdirSync(other, { recursive: true });
  writeFileSync(join(koffi, 'package.json'), JSON.stringify({ name: 'koffi', version: 'qa' }));
  writeFileSync(join(koffi, 'index.js'), '// QA loader\n');
  writeFileSync(join(other, 'koffi.node'), 'OTHER PLATFORM');
  if (withNativeBinary) writeFileSync(join(native, 'koffi.node'), 'QA NATIVE PAYLOAD');
  const destination = join(electronDir, 'resources', 'pi-agent-server');
  return { config, destination, copiedNative: join(destination, 'node_modules', 'koffi', 'build', 'koffi') };
}

describe('Pi runtime packaging', () => {
  it('copies the complete bridge set and only the requested native platform', () => {
    const f = fixture(true);
    copyPiAgentServer(f.config);
    for (const name of ['index.js', 'antigravity-server.js', 'vibe-acp-server.js']) {
      expect(readFileSync(join(f.destination, name), 'utf8')).toBe(`// QA runtime ${name}\n`);
    }
    expect(readFileSync(join(f.copiedNative, 'darwin_arm64', 'koffi.node'), 'utf8')).toBe('QA NATIVE PAYLOAD');
    expect(existsSync(join(f.copiedNative, 'linux_x64'))).toBe(false);
  });

  it('rejects an empty native directory before copying it into the application', () => {
    const f = fixture(false);
    expect(() => copyPiAgentServer(f.config)).toThrow('Koffi native binary directory is empty');
    expect(existsSync(join(f.copiedNative, 'darwin_arm64'))).toBe(false);
  });
});
