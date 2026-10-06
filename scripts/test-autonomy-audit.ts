import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dir, '..');
const scratch = mkdtempSync(join(tmpdir(), 'robb-autonomy-verification-'));
const groups = [
  { id: 'objectives', scenarios: ['E01','E03','E04','E05','E11','E12','E14'], files: ['packages/server-core/src/sessions/objective-contract.test.ts','packages/server-core/src/sessions/objective-outcome.test.ts','packages/server-core/src/sessions/objective-acceptance-criteria.test.ts','packages/server-core/src/sessions/session-objective-outcome-integration.test.ts','packages/server-core/src/sessions/turn-recovery.test.ts','packages/shared/src/sessions/__tests__/active-objective-persistence.test.ts'] },
  { id: 'routing', scenarios: ['E02'], files: ['packages/server-core/src/sessions/routing-fallback.test.ts','packages/server-core/src/tasks/task-node-routing.test.ts'] },
  { id: 'delivery', scenarios: ['E05','E13'], files: ['packages/server-core/src/sessions/agent-delivery.test.ts','packages/server-core/src/sessions/sendmessage-durability.test.ts','packages/server-core/src/sessions/internal-message-coalescing.test.ts'] },
  { id: 'tool-contracts', scenarios: ['E08','E09'], files: ['packages/session-tools-core/src','packages/shared/src/agent/backend/claude/session-tool-parity.test.ts','packages/shared/src/agent/backend/pi/session-tool-parity.test.ts','packages/pi-agent-server/src/craft-metadata-schema.test.ts'] },
  { id: 'browser-prerequisites', scenarios: ['E07'], files: ['./packages/shared/src/agent/core/__tests__/prerequisite-manager.isolated.ts'] },
  { id: 'learning', scenarios: ['E15'], files: ['packages/server-core/src/sessions/project-learning.test.ts','packages/shared/src/projects/__tests__/memory-v2.test.ts','packages/shared/src/governance/workspace-governance-store.test.ts'] },
  { id: 'benchmark-gates', scenarios: ['E16'], files: ['packages/server-core/src/sessions/human-benchmark.test.ts','packages/server-core/src/sessions/autonomy-acceptance.test.ts'] },
];
const results: Array<{ id: string; scenarios: string[]; command: string[]; exitCode: number; pass: number; fail: number; logSha256: string; log: string }> = [];
async function run(id: string, scenarios: string[], command: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, CRAFT_CONFIG_DIR: join(scratch, id, 'profile') };
  if (command[0] !== 'python3') { delete env.UV_CACHE_DIR; delete env.UV_OFFLINE; }
  const child = Bun.spawn(command, { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const output = stdout + stderr;
  const log = join(scratch, `${id}.log`); writeFileSync(log, output);
  const pass = Number(output.match(/\n\s*(\d+) pass\b/)?.[1] ?? (exitCode === 0 ? output.match(/Ran (\d+) tests?/)?.[1] : 0) ?? 0);
  const fail = Number(output.match(/\n\s*(\d+) fail\b/)?.[1] ?? (exitCode === 0 ? 0 : 1));
  results.push({ id, scenarios, command, exitCode, pass, fail, logSha256: createHash('sha256').update(output).digest('hex'), log });
  console.log(`${id}: ${exitCode === 0 ? 'PASS' : 'FAIL'} (${pass} tests); ${log}`);
}
for (const group of groups) await run(group.id, group.scenarios, [process.execPath, 'test', ...group.files]);
await run('document-runtime', ['E06'], ['python3','-m','unittest','apps.electron.resources.scripts.tests.test_python_wrapper']);
await run('document-rendering', ['E10'], ['python3','-m','unittest','apps.electron.resources.scripts.tests.test_pdf_tool_smoke']);
const specPath = join(root, 'docs/robinswood/reports/autonomy-100-chats-2026-09-06/regression-scenarios.json');
const spec = JSON.parse(readFileSync(specPath, 'utf8')) as { scenarios: Array<{ id: string }> };
const coverage = spec.scenarios.map(scenario => {
  const evidence = results.filter(result => result.scenarios.includes(scenario.id));
  return { id: scenario.id, status: evidence.length && evidence.every(e => e.exitCode === 0) ? 'automated_regression_passed' : 'failed_or_missing', groups: evidence.map(e => e.id), limitation: 'Automated fixture coverage; historical production runs and human superiority are not requalified by this test.' };
});
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), target: 'isolated development test profiles', empiricalHumanBenchmark: 'not_measured', specificationSha256: createHash('sha256').update(readFileSync(specPath)).digest('hex'), passed: results.every(r => r.exitCode === 0) && coverage.every(c => c.status === 'automated_regression_passed'), testCount: results.reduce((a,r) => a+r.pass,0), results, coverage };
const output = resolve(process.argv[2] ?? join(root, 'docs/robinswood/reports/autonomy-implementation-2026-09-07/verification.json'));
mkdirSync(resolve(output, '..'), { recursive: true }); writeFileSync(output, JSON.stringify(report,null,2)+'\n');
console.log(`Report: ${output}`); process.exitCode = report.passed ? 0 : 1;
