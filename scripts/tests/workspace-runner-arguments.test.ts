import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const recoverySuite = 'TaskRunner-recovers-non-terminal-paused-runs-after-restart-without-schedulin.test.ts';

function runFixture(extraArgs: string | undefined): string[][] {
  const root = mkdtempSync(join(tmpdir(), 'robb runner args '));
  try {
    const scripts = join(root, 'scripts');
    const bin = join(root, 'bin');
    const workspace = join(root, 'packages', 'fixture');
    for (const directory of [scripts, bin, workspace]) mkdirSync(directory, { recursive: true });
    copyFileSync(resolve(import.meta.dir, '../run-workspace-tests.sh'), join(scripts, 'run-workspace-tests.sh'));
    writeFileSync(join(workspace, 'sample.test.ts'), '// Source discovery fixture.\n');
    const taskDirectory = join(root, 'packages', 'server-core', 'src', 'tasks');
    mkdirSync(taskDirectory, { recursive: true });
    writeFileSync(join(taskDirectory, recoverySuite), '// Isolated recovery discovery fixture.\n');
    writeFileSync(join(root, 'glob-canary'), 'Must never expand into a test argument.\n');
    const log = join(root, 'arguments.log');
    const bun = join(bin, 'bun');
    writeFileSync(bun, '#!/usr/bin/env bash\nprintf "<call>\n" >> "$ARGUMENT_LOG"\nprintf "%s\n" "$@" >> "$ARGUMENT_LOG"\n', { mode: 0o755 });
    writeFileSync(join(bin, 'python3'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}`,
      BUN_BIN: bun,
      ARGUMENT_LOG: log,
    };
    delete env['CRAFT_CONFIG_DIR'];
    if (extraArgs === undefined) delete env['BUN_TEST_ARGS'];
    else env['BUN_TEST_ARGS'] = extraArgs;
    const result = spawnSync('bash', [join(scripts, 'run-workspace-tests.sh')], {
      cwd: root, env, encoding: 'utf8', timeout: 10_000,
    });
    if (result.error) throw result.error;
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    return readFileSync(log, 'utf8').split('<call>\n').slice(1)
      .map(call => call.trimEnd().split('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('workspace runner argument boundaries', () => {
  test('executes the durable recovery suite exactly once in its own process', () => {
    const path = `./packages/server-core/src/tasks/${recoverySuite}`;
    const calls = runFixture(undefined).filter(args => args.includes(path));
    expect(calls).toEqual([['test', '--timeout', '10000', path]]);
  });
  for (const value of [undefined, '']) {
    test(`accepts ${value === undefined ? 'unset' : 'empty'} extra arguments with nounset enabled`, () => {
      expect(runFixture(value)[0]).toEqual([
        'test', '--timeout', '10000', './packages/fixture/sample.test.ts',
      ]);
    });
  }
  test('preserves wildcard arguments literally instead of expanding repository paths', () => {
    expect(runFixture('--bail --test-name-pattern *')[0]).toEqual([
      'test', '--timeout', '10000', '--bail', '--test-name-pattern', '*',
      './packages/fixture/sample.test.ts',
    ]);
  });
});
