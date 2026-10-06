import { describe, it, expect } from 'bun:test';
import { applyFilesystemIsolation, buildDarwinSandboxProfile } from './filesystem-isolation.ts';

describe('buildDarwinSandboxProfile', () => {
  it('includes session subpath write allow', () => {
    const profile = buildDarwinSandboxProfile('/tmp/craft-session');
    expect(profile).toContain('(allow file-write* (subpath "/tmp/craft-session"))');
    expect(profile).not.toContain('(deny network*)');
  });

  it('includes deny network when requested', () => {
    const profile = buildDarwinSandboxProfile('/tmp/craft-session', { includeNetworkDeny: true });
    expect(profile).toContain('(deny network*)');
  });

  it('uses the immutable system sandbox path on macOS', () => {
    if (process.platform !== 'darwin') return;
    const plan = applyFilesystemIsolation('/usr/bin/true', [], '/tmp/craft-session', { includeNetworkDeny: true });
    expect(plan).toMatchObject({ status: 'enforced', backend: 'sandbox-exec', command: '/usr/bin/sandbox-exec' });
  });
});
