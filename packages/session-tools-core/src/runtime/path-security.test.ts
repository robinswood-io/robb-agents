import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isPathWithinDirectory, isPathWithinDirectoryForCreation } from './path-security.ts';

describe('path-security', () => {
  let rootDir: string;
  let sessionDir: string;
  let dataDir: string;
  let outsideDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'path-security-'));
    sessionDir = join(rootDir, 'session');
    dataDir = join(sessionDir, 'data');
    outsideDir = join(rootDir, 'outside');

    mkdirSync(dataDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('blocks sibling prefix bypass', () => {
    const sibling = join(rootDir, 'session-evil', 'file.txt');
    expect(isPathWithinDirectory(sibling, sessionDir)).toBe(false);
    expect(isPathWithinDirectoryForCreation(sibling, sessionDir)).toBe(false);
  });

  it('blocks symlink escape for creation paths', () => {
    if (process.platform === 'win32') {
      // Symlink creation on Windows is permission-sensitive in CI/dev.
      return;
    }

    const escapeLink = join(dataDir, 'escape-link');
    symlinkSync(outsideDir, escapeLink, 'dir');

    const escapedOutput = join(escapeLink, 'out.json');
    expect(isPathWithinDirectoryForCreation(escapedOutput, dataDir)).toBe(false);
  });

  it('blocks symlink escape for existing files', () => {
    if (process.platform === 'win32') {
      return;
    }

    const outsideFile = join(outsideDir, 'secret.txt');
    writeFileSync(outsideFile, 'secret');

    const linkInSession = join(sessionDir, 'linked-secret.txt');
    symlinkSync(outsideFile, linkInSession, 'file');

    expect(isPathWithinDirectory(linkInSession, sessionDir)).toBe(false);
    expect(isPathWithinDirectoryForCreation(linkInSession, sessionDir)).toBe(false);
  });

  it('permits replacing a contained file when the session parent is a symlink alias', () => {
    if (process.platform === 'win32') return;
    const alias = join(rootDir, 'session-alias');
    symlinkSync(sessionDir, alias, 'dir');
    writeFileSync(join(dataDir, 'output.json'), '{}');
    expect(isPathWithinDirectoryForCreation(join(alias, 'data', 'output.json'), join(alias, 'data'))).toBe(true);
  });
});
