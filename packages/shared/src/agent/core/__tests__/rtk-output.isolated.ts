import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getRtkOutputFilter, rewriteBashWithRtk } from '../rtk-rewrite.ts';
import { getRtkStatus, getRtkGain, resetRtkPathCache, parseRtkOutputMetrics } from '../rtk-detector.ts';
import { setBundledAssetsRoot } from '../../../utils/paths.ts';
import { PiAgent } from '../../pi-agent.ts';
import type { BackendConfig } from '../../backend/types.ts';
import { RTK_METRICS_PATH } from '../rtk-state.ts';
import { runPreToolUseChecks } from '../pre-tool-use.ts';
import { buildApplicationProtectionProfile } from '../../../../../session-tools-core/src/runtime/application-protection.ts';

const root = mkdtempSync(join(tmpdir(), 'robb-rtk-output-'));
const bin = join(root, 'bin');
mkdirSync(bin);
// Spaces and apostrophes exercise absolute-path quoting, independently of PATH.
const rtk = join(root, "bundled optimizer's rtk");
writeFileSync(rtk, `#!/bin/sh
if [ "$1" = --version ]; then printf 'rtk 0.43.0\n'; exit 0; fi
if [ "$RTK_TELEMETRY_DISABLED" != 1 ]; then exit 98; fi
if [ "$1" = rewrite ]; then printf 'rtk %s' "$2"; exit "\${ROBB_REWRITE_STATUS:-3}"; fi
if [ "$1" = pipe ]; then
  if [ "$2" = --help ]; then printf 'Usage: rtk pipe <runner>\\n'; exit 0; fi
  cat >/dev/null
  printf '%s' "\${ROBB_FILTER_OUTPUT:-Summary: all 100 tests passed.}"
  printf '%s' 'private filter diagnostic' >&2
  exit "\${ROBB_FILTER_STATUS:-0}"
fi
exit 99
`);
chmodSync(rtk, 0o755);
spawnSync(rtk, ['rewrite', 'pytest warmup.py'], { env: { ...process.env, RTK_TELEMETRY_DISABLED: '1' }, timeout: 2_000 });
writeFileSync(join(bin, 'pytest'), `#!/bin/sh
printf x >>"$ROBB_RUN_COUNT"
if [ -n "$ROBB_PROTECTED_TARGET" ]; then printf BROKEN >"$ROBB_PROTECTED_TARGET" || exit 19; fi
cat "$ROBB_STDOUT"
printf '%s' 'original warning on stderr' >&2
exit "\${ROBB_ORIGINAL_STATUS:-0}"
`);
chmodSync(join(bin, 'pytest'), 0o755);
const raw = Array.from({ length: 100 }, (_, i) => `test_${i}: long detailed success message.............................................`).join('\n') + '\n';
const output = join(root, 'fixture.txt');
writeFileSync(output, raw);
let run = 0;
const originalRewriteStatus = process.env.ROBB_REWRITE_STATUS;
beforeEach(() => { delete process.env.ROBB_REWRITE_STATUS; });
afterAll(() => {
  if (originalRewriteStatus === undefined) delete process.env.ROBB_REWRITE_STATUS;
  else process.env.ROBB_REWRITE_STATUS = originalRewriteStatus;
  rmSync(root, { recursive: true, force: true });
});

function fixture(command = 'pytest test_example.py') {
  const data = join(root, `session-${++run}`, 'data with spaces');
  const input = { command, timeout: 120_000, description: 'Run suite' };
  const rewritten = rewriteBashWithRtk('Bash', input, rtk, [], undefined, { dataFolderPath: data, workingDirectory: root });
  const count = join(root, `count-${run}`);
  const execute = (extraEnv: Record<string, string> = {}, executable = '/bin/bash') => spawnSync(executable, ['-c', String(rewritten.input.command)], {
    cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, ROBB_RUN_COUNT: count, ROBB_STDOUT: output, ...extraEnv },
  });
  return { data, input, rewritten, count, execute };
}

function archive(data: string): string {
  const files = readdirSync(join(data, 'rtk'));
  expect(files).toHaveLength(1);
  return join(data, 'rtk', files[0]!);
}

describe('RTK lossless execution boundary', () => {
  it('executes original once, pins optimizer, stores exact private raw streams and reports net savings', () => {
    const f = fixture();
    expect(f.rewritten.modified).toBe(true);
    expect(f.input.command).toBe('pytest test_example.py');
    expect(f.rewritten.input.timeout).toBe(120_000);
    const result = f.execute();
    expect(result.status).toBe(0);
    expect(readFileSync(f.count, 'utf8')).toBe('x');
    expect(result.stdout).toContain('all 100 tests passed');
    expect(result.stdout).toContain('RTK full output:');
    expect(result.stdout.length).toBeLessThan(raw.length);
    expect(result.stderr).toBe('original warning on stderr');
    const dir = archive(f.data);
    expect(readFileSync(join(dir, 'stdout.log'), 'utf8')).toBe(raw);
    expect(readFileSync(join(dir, 'stderr.log'), 'utf8')).toBe(result.stderr);
    expect(readFileSync(join(dir, 'exit-code'), 'utf8')).toBe('0\n');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'stdout.log')).mode & 0o777).toBe(0o600);
    const metrics = parseRtkOutputMetrics(readFileSync(RTK_METRICS_PATH, 'utf8'));
    expect(metrics.totalCommands).toBeGreaterThan(0);
    expect(metrics.totalSaved).toBeGreaterThan(0);
  });

  for (const [name, env] of [
    ['filter failure', { ROBB_FILTER_STATUS: '1' }],
    ['filter expansion', { ROBB_FILTER_OUTPUT: raw + raw }],
    ['original failure', { ROBB_ORIGINAL_STATUS: '17' }],
  ] as const) {
    it(`preserves exact output, stderr and exit without rerun on ${name}`, () => {
      const f = fixture();
      const result = f.execute(env);
      expect(result.status).toBe(Number((env as Record<string, string>).ROBB_ORIGINAL_STATUS ?? 0));
      expect(result.stdout).toBe(raw);
      expect(result.stderr).toBe('original warning on stderr');
      expect(readFileSync(f.count, 'utf8')).toBe('x');
    });
  }

  it('preserves the same execution/exit contract in zsh', () => {
    if (!existsSync('/bin/zsh')) return;
    const f = fixture();
    const result = f.execute({ ROBB_ORIGINAL_STATUS: '7' }, '/bin/zsh');
    expect(result.status).toBe(7);
    expect(result.stdout).toBe(raw);
    expect(result.stderr).toBe('original warning on stderr');
    expect(readFileSync(f.count, 'utf8')).toBe('x');
  });

  it('bounds retained raw archives and returns oversized output unchanged', () => {
    const large = join(root, 'large.txt');
    const bytes = 'x'.repeat(2 * 1024 * 1024 + 1);
    writeFileSync(large, bytes);
    const f = fixture();
    const result = f.execute({ ROBB_STDOUT: large });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(bytes);
    expect(existsSync(join(archive(f.data), 'stdout.log'))).toBe(false);
    expect(readFileSync(f.count, 'utf8')).toBe('x');
  });

  it('leaves commands native when the archive allowance is exhausted', () => {
    const data = join(root, 'full-data');
    const rootArchive = join(data, 'rtk');
    mkdirSync(rootArchive, { recursive: true });
    for (let i = 0; i < 100; i++) mkdirSync(join(rootArchive, `output-${i}`));
    const input = { command: 'pytest test.py' };
    expect(rewriteBashWithRtk('Bash', input, rtk, [], undefined, { dataFolderPath: data }).modified).toBe(false);
  });

  it('keeps denied/unsupported rewrites and missing capture/binary unchanged', () => {
    const input = { command: 'pytest test.py' };
    for (const status of ['1', '2', '7']) {
      process.env.ROBB_REWRITE_STATUS = status;
      expect(fixture().rewritten.modified).toBe(false);
    }
    expect(rewriteBashWithRtk('Bash', input, rtk, []).input).toBe(input);
    expect(rewriteBashWithRtk('Bash', input, null, []).input).toBe(input);
    expect(rewriteBashWithRtk('mcp__ssh__execute', input, rtk, []).input).toBe(input);
  });

  it('preserves the app permission decision for the original command', () => {
    const data = join(root, 'permission-data');
    const result = runPreToolUseChecks({
      toolName: 'Bash', input: { command: 'pytest test.py' },
      sessionId: 'rtk-permission-test', permissionMode: 'ask', activeSourceSlugs: [], allSourceSlugs: [], hasSourceActivation: false,
      permissionManager: { getBaseCommand: () => 'pytest', isCommandWhitelisted: () => false, isDangerousCommand: () => false, extractDomainFromNetworkCommand: () => null, isDomainWhitelisted: () => false },
      workspaceRootPath: root, workspaceId: 'rtk-test', dataFolderPath: data,
      workingDirectory: root, rtkContext: { enabled: true, path: rtk, exclude: [] },
    });
    expect(result.type).toBe('prompt');
    if (result.type === 'prompt') {
      expect(result.command).toBe('pytest test.py');
      expect(result.modifiedInput?.command).toContain('RTK_TELEMETRY_DISABLED=1');
    }
  });
});

describe('RTK output contract eligibility', () => {
  for (const command of [
    'ls | wc -l', 'git status --porcelain=v1', 'git log --format=%H',
    'git diff', 'git diff --name-only', 'git show HEAD', 'cat proof.json',
    'rg --json pattern .', 'rg -0 pattern .', 'find . -print0',
    'pytest --junitxml=results.xml', 'vitest --reporter=json',
    'git status > evidence.txt', 'cd /tmp && git status', 'ssh host git status',
    'docker exec service git status', 'RTK_DISABLED=1 git status',
    'git status $(echo argument)', 'git status\ngit log',
    'find . -delete', 'rtk git status', 'bash -c "git status"',
  ]) {
    it(`keeps native semantics for ${command}`, () => expect(getRtkOutputFilter(command)).toBeUndefined());
  }
  it('honors exclusions and supported literal runner names', () => {
    expect(getRtkOutputFilter('git status', ['git'])).toBeUndefined();
    expect(getRtkOutputFilter('npx vitest run')).toBe('vitest');
    expect(getRtkOutputFilter('npx vitest run', ['vitest'])).toBeUndefined();
  });
  it('rejects malformed accounting and computes weighted byte-based savings', () => {
    const stats = parseRtkOutputMetrics('400 100 1000\n1200 1000 3000\nmalformed\n1 2 3\n');
    expect(stats).toEqual({ totalCommands: 2, totalInput: 400, totalOutput: 275, totalSaved: 125, avgSavingsPct: 31.25, totalTimeMs: 4000, avgTimeMs: 2000 });
  });
});

const nativeRtk = process.env.ROBB_TEST_RTK_PATH;
it.skipIf(!nativeRtk)('filters a real pytest fixture with the bundled RTK while retaining exact raw output', () => {
  const nativeOutput = join(root, 'native-pytest.txt');
  const nativeRaw = [
    '============================= test session starts ==============================',
    'platform darwin -- Python 3.12.0, pytest-8.0.0',
    'collected 100 items',
    ...Array.from({ length: 100 }, (_, i) => `test_example.py::test_example_${i} PASSED [${i + 1}%]`),
    '============================= 100 passed in 1.00s ==============================',
    '',
  ].join('\n');
  writeFileSync(nativeOutput, nativeRaw);
  const data = join(root, 'native-data');
  const count = join(root, 'native-count');
  const result = rewriteBashWithRtk('Bash', { command: 'pytest test_example.py' }, nativeRtk!, [], undefined, { dataFolderPath: data, workingDirectory: root });
  expect(result.modified).toBe(true);
  const executed = spawnSync('/bin/bash', ['-c', String(result.input.command)], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, ROBB_RUN_COUNT: count, ROBB_STDOUT: nativeOutput },
  });
  expect(executed.status).toBe(0);
  expect(executed.stderr).toBe('original warning on stderr');
  expect(executed.stdout).toContain('100 passed');
  expect(executed.stdout).toContain('RTK full output:');
  expect(executed.stdout.length).toBeLessThan(nativeRaw.length);
  expect(readFileSync(join(archive(data), 'stdout.log'), 'utf8')).toBe(nativeRaw);
  expect(readFileSync(count, 'utf8')).toBe('x');
  console.log(JSON.stringify({ rtkFixtureRawBytes: Buffer.byteLength(nativeRaw), rtkShownBytesIncludingHint: Buffer.byteLength(executed.stdout) }));
});


it('applies the same output/permission contract through the Pi subprocess adapter and live toggle', async () => {
  const assets = join(root, 'assets');
  const bundled = join(assets, 'resources', 'bin', `${process.platform}-${process.arch}`);
  mkdirSync(bundled, { recursive: true });
  copyFileSync(rtk, join(bundled, process.platform === 'win32' ? 'rtk.exe' : 'rtk'));
  setBundledAssetsRoot(assets);
  resetRtkPathCache();
  expect(getRtkStatus().source).toBe('bundled');
  expect(getRtkGain()?.totalSaved).toBeGreaterThan(0);
  const profileConfig = join(process.env.CRAFT_CONFIG_DIR!, 'config.json');
  writeFileSync(profileConfig, JSON.stringify({ workspaces: [], activeWorkspaceId: null, activeSessionId: null, rtkEnabled: true }));
  const config: BackendConfig = {
    provider: 'pi', workspace: { id: 'rtk-pi', name: 'RTK Pi', rootPath: root } as never,
    session: { id: 'rtk-pi-child', workspaceRootPath: root, workingDirectory: root, createdAt: Date.now(), lastUsedAt: Date.now() } as never,
    isHeadless: true,
  };
  const agent = new PiAgent(config);
  const sent: Record<string, unknown>[] = [];
  const runtime = agent as unknown as {
    send: (message: Record<string, unknown>) => void;
    emitAutomationEvent: () => Promise<void>;
    handlePreToolUseRequest: (message: Record<string, unknown>) => Promise<void>;
    subprocessRuntimeContext?: { runtimeId: string; sessionId: string };
  };
  runtime.send = message => sent.push(message);
  runtime.emitAutomationEvent = async () => {};
  runtime.subprocessRuntimeContext = { runtimeId: 'rtk-pi-runtime', sessionId: 'rtk-pi-child' };
  agent.setPermissionMode('allow-all');
  try {
    const request = {
      requestId: 'rtk-pi-on', toolCallId: 'rtk-pi-tool-on',
      toolName: 'Bash', input: { command: 'pytest test_example.py' },
    };
    await runtime.handlePreToolUseRequest(request);
    expect(sent.at(-1)).toMatchObject({ action: 'modify' });
    expect(String((sent.at(-1)?.input as Record<string, unknown>).command)).toContain('RTK full output:');
    expect(request.input.command).toBe('pytest test_example.py');
    writeFileSync(profileConfig, JSON.stringify({ workspaces: [], activeWorkspaceId: null, activeSessionId: null, rtkEnabled: false }));
    await runtime.handlePreToolUseRequest({
      ...request, requestId: 'rtk-pi-off', toolCallId: 'rtk-pi-tool-off',
    });
    expect(sent.at(-1)?.action).toBe('allow');
  } finally {
    agent.destroy();
    resetRtkPathCache();
  }
});


it('does not write archives through a replaced session data directory or archive symlink', () => {
  for (const component of ['data', 'rtk']) {
    const base = join(root, `symlink-${component}`);
    const outside = join(root, `outside-${component}`);
    mkdirSync(base); mkdirSync(outside);
    const data = join(base, 'data');
    if (component === 'rtk') mkdirSync(data);
    symlinkSync(outside, component === 'data' ? data : join(data, 'rtk'));
    const result = rewriteBashWithRtk('Bash', { command: 'pytest test.py' }, rtk, [], undefined, { dataFolderPath: data });
    expect(result.modified).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
  }
});

it.skipIf(process.platform !== 'darwin')('preserves real macOS bundle protection for original and optimized commands', () => {
  const bundle = join(root, 'fixture Robb Agents.app');
  mkdirSync(bundle);
  const marker = join(bundle, 'app.asar');
  writeFileSync(marker, 'INTACT');
  const profile = buildApplicationProtectionProfile([bundle]);
  const f = fixture();
  for (const command of [f.input.command, String(f.rewritten.input.command)]) {
    const result = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/bash', '-c', command], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, ROBB_RUN_COUNT: f.count, ROBB_STDOUT: output, ROBB_PROTECTED_TARGET: marker },
    });
    expect(result.status).toBe(19);
    expect(result.stderr).toMatch(/not permitted|denied/i);
    expect(readFileSync(marker, 'utf8')).toBe('INTACT');
  }
  expect(readFileSync(f.count, 'utf8')).toBe('xx');
});

function withHostResourceRoots(physical: string | undefined, server: string | undefined, action: () => void) {
  const original = {
    CRAFT_RESOURCES_BASE: process.env.CRAFT_RESOURCES_BASE,
    CRAFT_BUNDLED_ASSETS_ROOT: process.env.CRAFT_BUNDLED_ASSETS_ROOT,
    PATH: process.env.PATH,
  };
  try {
    if (physical) process.env.CRAFT_RESOURCES_BASE = physical; else delete process.env.CRAFT_RESOURCES_BASE;
    if (server) process.env.CRAFT_BUNDLED_ASSETS_ROOT = server; else delete process.env.CRAFT_BUNDLED_ASSETS_ROOT;
    process.env.PATH = '/usr/bin:/bin';
    resetRtkPathCache();
    action();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    resetRtkPathCache();
  }
}

function stageDetectorFixture(base: string): string {
  const target = join(base, 'resources', 'bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'rtk.exe' : 'rtk');
  mkdirSync(join(target, '..'), { recursive: true });
  copyFileSync(rtk, target);
  return target;
}

it('prefers physical Electron resources over an existing ASAR member and PATH', () => {
  const resources = join(root, 'detector-app', 'Contents', 'Resources');
  const asarRoot = join(resources, 'app.asar');
  const physicalRoot = join(resources, 'app');
  const virtualBinary = stageDetectorFixture(asarRoot);
  const expected = stageDetectorFixture(physicalRoot);
  const serverRoot = join(root, 'detector-server-alternative');
  stageDetectorFixture(serverRoot);
  setBundledAssetsRoot(asarRoot);
  withHostResourceRoots(physicalRoot, serverRoot, () => {
    // The problematic layout is reproduced even outside Electron: an existing
    // virtual-looking member must never win over the actual packaged binary.
    expect(existsSync(virtualBinary)).toBe(true);
    process.env.PATH = `${join(expected, '..')}:/usr/bin:/bin`;
    const status = getRtkStatus({ forceRecheck: true });
    expect(status).toEqual({ installed: true, path: expected, version: '0.43.0', source: 'bundled' });
  });
});

it('finds the standalone server binary from its host resource root', () => {
  const serverRoot = join(root, 'detector-server');
  const expected = stageDetectorFixture(serverRoot);
  withHostResourceRoots(join(root, 'missing-electron-root'), serverRoot, () => {
    expect(getRtkStatus({ forceRecheck: true }).path).toBe(expected);
    expect(getRtkStatus().source).toBe('bundled');
  });
});

it('rejects ASAR executable candidates and accepts a physical .asar.unpacked directory', () => {
  const asar = join(root, 'detector-only', 'app.asar');
  const virtual = stageDetectorFixture(asar);
  setBundledAssetsRoot(asar);
  withHostResourceRoots(asar, undefined, () => {
    process.env.PATH = `${join(virtual, '..')}:/usr/bin:/bin`;
    expect(getRtkStatus({ forceRecheck: true })).toEqual({ installed: false, path: null, version: null, source: null });
  });
  const unpacked = join(root, 'detector-only', 'app.asar.unpacked');
  const expected = stageDetectorFixture(unpacked);
  withHostResourceRoots(unpacked, undefined, () => {
    expect(getRtkStatus({ forceRecheck: true }).path).toBe(expected);
    expect(getRtkStatus().source).toBe('bundled');
  });
});

it.skipIf(!nativeRtk)('identifies the real native binary as bundled with an ASAR main assets root', () => {
  const expected = nativeRtk!;
  // Layout: <physical-root>/resources/bin/<platform>-<arch>/rtk.
  const physicalRoot = join(expected, '..', '..', '..', '..');
  setBundledAssetsRoot(join(root, 'real-native-main', 'app.asar'));
  withHostResourceRoots(physicalRoot, undefined, () => {
    const status = getRtkStatus({ forceRecheck: true });
    expect(status.path).toBe(expected);
    expect(status.source).toBe('bundled');
    expect(status.version).toBe('0.43.0');
  });
});
