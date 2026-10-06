/**
 * Regression test for #575
 *
 * spawn_session must expand `~`, `${HOME}`, and relative paths in
 * `workingDirectory` before handing the request to `onSpawnSession`.
 * Otherwise `child_process.spawn({ cwd })` receives a literal tilde-path
 * and the SDK fails with a misleading executable-not-found error.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type { SpawnSessionRequest, SpawnSessionResult } from '../base-agent.ts';
import { TestAgent, createMockBackendConfig } from './test-utils.ts';

// Expose the protected preExecuteSpawnSession for direct invocation.
class SpawnTestAgent extends TestAgent {
  public invokeSpawn(input: Record<string, unknown>) {
    return this.preExecuteSpawnSession(input);
  }
}

function setup() {
  const agent = new SpawnTestAgent(createMockBackendConfig());
  const captured: SpawnSessionRequest[] = [];
  agent.onSpawnSession = async (request) => {
    captured.push(request);
    const result: SpawnSessionResult = {
      sessionId: 'spawned-id',
      name: 'spawned',
      status: 'started',
    };
    return result;
  };
  return { agent, captured };
}

describe('preExecuteSpawnSession workingDirectory normalization', () => {
  let agent: SpawnTestAgent;
  let captured: SpawnSessionRequest[];
  let testDir: string;

  beforeEach(() => {
    ({ agent, captured } = setup());
    testDir = mkdtempSync(join(tmpdir(), 'robb-spawn-cwd-'));
  });

  afterEach(() => {
    agent.destroy();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('expands `~` to the home directory', async () => {
    await agent.invokeSpawn({ prompt: 'hi', workingDirectory: '~' });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.workingDirectory).toBe(homedir());
  });

  it('expands `~/foo` to an absolute path under home', async () => {
    await agent.invokeSpawn({ prompt: 'hi', workingDirectory: `~/${relative(homedir(), testDir)}` });
    expect(captured[0]?.workingDirectory).toBe(testDir);
  });

  it('expands `${HOME}/foo`', async () => {
    await agent.invokeSpawn({ prompt: 'hi', workingDirectory: '${HOME}/' + relative(homedir(), testDir) });
    expect(captured[0]?.workingDirectory).toBe(testDir);
  });

  it('expands `$HOME/foo`', async () => {
    await agent.invokeSpawn({ prompt: 'hi', workingDirectory: '$HOME/' + relative(homedir(), testDir) });
    expect(captured[0]?.workingDirectory).toBe(testDir);
  });

  it('leaves absolute paths unchanged (aside from normalization)', async () => {
    await agent.invokeSpawn({ prompt: 'hi', workingDirectory: testDir });
    expect(captured[0]?.workingDirectory).toBe(testDir);
  });

  it('resolves relative paths against cwd', async () => {
    const relativeDirectory = relative(process.cwd(), testDir);
    await agent.invokeSpawn({ prompt: 'hi', workingDirectory: relativeDirectory });
    expect(captured[0]?.workingDirectory).toBe(resolve(process.cwd(), relativeDirectory));
  });

  it('passes through undefined when workingDirectory is omitted', async () => {
    await agent.invokeSpawn({ prompt: 'hi' });
    expect(captured[0]?.workingDirectory).toBeUndefined();
  });

  it('treats empty string as undefined', async () => {
    await agent.invokeSpawn({ prompt: 'hi', workingDirectory: '' });
    expect(captured[0]?.workingDirectory).toBeUndefined();
  });

  it('rejects a missing local/remote directory before creating the child', async () => {
    await expect(agent.invokeSpawn({ prompt: 'hi', workingDirectory: join(testDir, 'srv/workspace/remote-project') }))
      .rejects.toThrow('For work over SSH');
    expect(captured).toHaveLength(0);
  });

  it('rejects an ordinary file before creating the child', async () => {
    const file = join(testDir, 'file.txt');
    writeFileSync(file, 'fixture');
    await expect(agent.invokeSpawn({ prompt: 'hi', workingDirectory: file }))
      .rejects.toThrow('not an accessible directory');
    expect(captured).toHaveLength(0);
  });

  it('accepts a directory symlink without rewriting it to another location', async () => {
    const link = join(testDir, 'link');
    symlinkSync(testDir, link);
    await agent.invokeSpawn({ prompt: 'hi', workingDirectory: link });
    expect(captured[0]?.workingDirectory).toBe(link);
  });

  it('rejects a broken directory symlink before creating the child', async () => {
    const link = join(testDir, 'broken');
    symlinkSync(join(testDir, 'missing'), link);
    await expect(agent.invokeSpawn({ prompt: 'hi', workingDirectory: link }))
      .rejects.toThrow('not an accessible directory');
    expect(captured).toHaveLength(0);
  });
});
