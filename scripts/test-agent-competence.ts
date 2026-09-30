import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const scratch = mkdtempSync(join(tmpdir(), 'robb-competence-verification-'));
const outputPath = resolve(process.argv[2] ?? join(root, 'docs/robinswood/reports/agent-competence-2026-09-08/verification.json'));
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

// These are anonymized behavioral probes inspired by the September 8 audit,
// not replayed private transcripts or measurements of human performance.
const scenarios = [
  { id: 'D08-memory-correction', sourceAliases: ['S001', 'S005'], behavior: 'Retain a direct user correction as sourced inactive data; retrieve reviewed local knowledge across French/English phrasing.' },
  { id: 'D08-campaign-coverage', sourceAliases: ['S005'], behavior: 'Distinguish campaign coverage and relevance from a structurally valid contact count.' },
  { id: 'D08-document-completeness', sourceAliases: ['S166'], behavior: 'An exact delivery receipt does not prove the package inventory, completeness or recipient usability.' },
  { id: 'D08-objective-revision', sourceAliases: ['S063', 'S005'], behavior: 'Preserve the original objective and budget while invalidating stale acceptance evidence after substantive corrections.' },
  { id: 'D08-bounded-review', sourceAliases: ['S108', 'S063'], behavior: 'Bound reviewer recursion and family delegation; distinguish dispatched work from verified outcomes.' },
  { id: 'D08-permissions-prerequisites', sourceAliases: ['S009', 'S001'], behavior: 'Keep child authority within the parent boundary and require successful prerequisite acquisition before tool use.' },
  { id: 'D08-user-outcome', sourceAliases: ['S122', 'S165'], behavior: 'Require version, observed user journey and operational evidence instead of technical PASS alone.' },
  { id: 'D08-quality-speed-qualification', sourceAliases: [], behavior: 'Require independent paired quality and execution-speed measurements; synthetic fixtures cannot qualify superiority over humans.' },
];

const groups = [
  { id: 'spawn-contracts', scenarios: ['D08-bounded-review', 'D08-permissions-prerequisites'], files: [
    'packages/session-tools-core/src/spawn-session-schema.test.ts',
    'packages/shared/src/agent/__tests__/spawn-session-thinking-level.test.ts',
    'packages/shared/src/agent/__tests__/spawn-session-tilde-expansion.test.ts',
    'packages/shared/src/agent/__tests__/spawn-admission-backends.test.ts',
    'packages/shared/src/agent/backend/pi/session-tool-parity.test.ts',
    'packages/shared/src/agent/backend/claude/session-tool-parity.test.ts',
  ] },
  { id: 'modes-provenance', scenarios: ['D08-permissions-prerequisites', 'D08-objective-revision'], files: [
    'packages/shared/src/agent/__tests__/mode-session-state.test.ts',
    'packages/shared/src/agent/core/__tests__/tool-effect-permissions.test.ts',
    'packages/server-core/src/sessions/model-provenance.test.ts',
    'packages/server-core/src/sessions/session-app-provenance-persist.test.ts',
  ] },
  // These modules install process-level mocks and must run in separate Bun VMs.
  { id: 'prerequisites', scenarios: ['D08-permissions-prerequisites'], files: ['./packages/shared/src/agent/core/__tests__/prerequisite-manager.isolated.ts'] },
  { id: 'pre-tool-use', scenarios: ['D08-permissions-prerequisites'], files: ['./packages/shared/src/agent/core/__tests__/pre-tool-use-checks.isolated.ts'] },
  { id: 'business-amendments-delegation', scenarios: ['D08-campaign-coverage', 'D08-document-completeness', 'D08-objective-revision', 'D08-bounded-review', 'D08-user-outcome'], files: [
    'packages/server-core/src/sessions/competence-regressions.test.ts',
    'packages/server-core/src/sessions/objective-amendment-revision.test.ts',
    'packages/server-core/src/sessions/delegation-budget.test.ts',
    'packages/server-core/src/sessions/delegation-host.test.ts',
  ] },
  { id: 'memory-runtime', scenarios: ['D08-memory-correction', 'D08-objective-revision'], files: [
    'packages/server-core/src/sessions/project-learning.test.ts',
    'packages/server-core/src/sessions/project-learning-runtime.test.ts',
    'packages/shared/src/projects/__tests__/memory-v2.test.ts',
    'packages/shared/src/projects/__tests__/storage.test.ts',
    'packages/shared/src/governance/workspace-governance-store.test.ts',
  ] },
  { id: 'benchmark', scenarios: ['D08-quality-speed-qualification'], files: [
    'packages/server-core/src/sessions/human-benchmark.test.ts',
    'packages/server-core/src/sessions/autonomy-acceptance.test.ts',
  ] },
  { id: 'objective-existing-integration', scenarios: ['D08-objective-revision', 'D08-bounded-review', 'D08-user-outcome'], files: [
    'packages/server-core/src/sessions/objective-contract.test.ts',
    'packages/server-core/src/sessions/objective-outcome.test.ts',
    'packages/server-core/src/sessions/objective-acceptance-criteria.test.ts',
    'packages/server-core/src/sessions/session-objective-outcome-integration.test.ts',
    'packages/server-core/src/sessions/turn-recovery.test.ts',
    'packages/shared/src/agent/core/__tests__/objective-evidence-gate.test.ts',
  ] },
  { id: 'playbooks-persistence', scenarios: ['D08-document-completeness', 'D08-campaign-coverage', 'D08-user-outcome', 'D08-objective-revision'], files: [
    'packages/shared/src/playbooks/builtins.test.ts',
    'packages/shared/src/playbooks/storage.test.ts',
    'packages/shared/src/playbooks/validation.test.ts',
    'packages/shared/src/sessions/__tests__/active-objective-persistence.test.ts',
    'packages/shared/src/sessions/__tests__/execution-isolation-persistence.test.ts',
    'packages/server-core/src/sessions/sendmessage-durability.test.ts',
  ] },
];

function git(args: string[]): string {
  const child = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (child.exitCode !== 0) throw new Error(`Cannot record source provenance: git ${args[0]}`);
  return child.stdout.toString();
}
function sourceSnapshot() {
  const scope = ['packages', 'apps', 'scripts', 'package.json', 'bun.lock', 'bun.lockb', 'tsconfig.json'];
  const patch = git(['diff', '--binary', 'HEAD', '--', ...scope]);
  const changed = git(['diff', '--name-only', '-z', 'HEAD', '--', ...scope]).split('\0').filter(Boolean);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...scope]).split('\0').filter(Boolean).sort();
  const files = [...new Set([...changed, ...untracked])].sort().map(path => ({
    path, sha256: existsSync(join(root, path)) ? sha256(readFileSync(join(root, path))) : null,
  }));
  return {
    head: git(['rev-parse', 'HEAD']).trim(), branch: git(['branch', '--show-current']).trim(),
    sourcePatchSha256: sha256(JSON.stringify({ patch, untracked: files.filter(file => untracked.includes(file.path)) })),
    definition: 'SHA-256 of the HEAD binary diff plus sorted untracked source-file hashes under packages/apps/scripts and root package/lock/TypeScript configuration. Generated reports and logs are excluded.',
    files,
  };
}

interface Result {
  id: string; scenarios: string[]; command: string[]; exitCode: number; timedOut: boolean;
  pass: number; fail: number; skipped: number; durationMs: number; log: string; logSha256: string;
}
const startedAt = new Date().toISOString();
const sourceBefore = sourceSnapshot();
const results: Result[] = [];
for (const group of groups) {
  const command = [process.execPath, 'test', ...group.files];
  const log = join(scratch, `${group.id}.log`);
  const missing = group.files.filter(file => !existsSync(resolve(root, file)));
  const started = Date.now();
  let output: string, exitCode: number, timedOut = false;
  if (missing.length) {
    output = `Missing test files: ${missing.join(', ')}\n`; exitCode = 1;
  } else {
    const profile = mkdtempSync(join(scratch, `${group.id}-profile-`));
    const env: NodeJS.ProcessEnv = { ...process.env, CRAFT_CONFIG_DIR: profile, ROBB_BUILD_CHANNEL: 'development' };
    for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY']) delete env[key];
    const child = Bun.spawn(command, { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 300_000);
    try {
      const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      output = stdout + stderr; exitCode = status;
    } finally { clearTimeout(timeout); }
  }
  writeFileSync(log, output);
  const pass = Number(output.match(/\n\s*(\d+) pass\b/)?.[1] ?? 0);
  const fail = Number(output.match(/\n\s*(\d+) fail\b/)?.[1] ?? (exitCode === 0 ? 0 : 1));
  const skipped = Number(output.match(/\n\s*(\d+) skip\b/)?.[1] ?? 0);
  // An empty discovery or timeout is not a passing qualification group.
  if (!pass || fail || timedOut) exitCode = exitCode || 1;
  results.push({ id: group.id, scenarios: group.scenarios, command, exitCode, timedOut, pass, fail, skipped, durationMs: Date.now() - started, log, logSha256: sha256(output) });
  console.log(`${group.id}: ${exitCode === 0 ? 'PASS' : 'FAIL'} (${pass} pass, ${fail} fail, ${skipped} skip); ${log}`);
}
const sourceAfter = sourceSnapshot();
const sourceStable = sourceBefore.head === sourceAfter.head && sourceBefore.sourcePatchSha256 === sourceAfter.sourcePatchSha256;
const coverage = scenarios.map(scenario => {
  const evidence = results.filter(result => result.scenarios.includes(scenario.id));
  return { ...scenario, groups: evidence.map(result => result.id),
    status: evidence.length && evidence.every(result => result.exitCode === 0) ? 'automated_fixture_tests_passed' : 'failed_or_missing',
    limitation: 'Behavioral fixtures only: no private transcript replay, live-system requalification, observed commercial outcome or human comparison.',
  };
});
const report = {
  schemaVersion: 1, startedAt, generatedAt: new Date().toISOString(),
  target: 'isolated development test profiles', synthetic: true,
  profileIsolation: 'Fresh temporary CRAFT_CONFIG_DIR per subprocess; development channel; provider API credentials removed.',
  qualification: { empiricalHumanBenchmark: 'not_measured', humanSuperiorityQualified: false, productionRequalified: false },
  sourceBefore, sourceAfter, sourceStable,
  specificationSha256: sha256(JSON.stringify({ scenarios, groups })),
  passed: sourceStable && results.every(result => result.exitCode === 0) && coverage.every(item => item.status === 'automated_fixture_tests_passed'),
  testCount: results.reduce((count, result) => count + result.pass, 0),
  failedTestCount: results.reduce((count, result) => count + result.fail, 0),
  skippedTestCount: results.reduce((count, result) => count + result.skipped, 0),
  results, coverage,
};
mkdirSync(resolve(outputPath, '..'), { recursive: true });
writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
console.log(`Report: ${outputPath}; source stable: ${sourceStable}; qualified against humans: false`);
process.exitCode = report.passed ? 0 : 1;
