/**
 * Live acceptance with independent file checks and an existing selected connection.
 * The normal profile is accessible only with the explicit --local-staging option.
 * No credential export, external business action or new connection.
 * Run from the repo: CRAFT_CONFIG_DIR=~/.craft-agent-dev bun scripts/robb-completion-live-check.ts <evidence-directory>
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { SessionManager, setSessionPlatform } from '../packages/server-core/src/sessions/SessionManager.ts';
import { createHeadlessPlatform } from '../packages/server-core/src/runtime/platform-headless.ts';
import { getDefaultLlmConnection, getLlmConnection, getWorkspaces } from '../packages/shared/src/config/storage.ts';
import { CONFIG_DIR } from '../packages/shared/src/config/paths.ts';

const localStaging = process.argv.includes('--local-staging');
if (!CONFIG_DIR.endsWith('/.craft-agent-dev') && !(localStaging && CONFIG_DIR.endsWith('/.craft-agent'))) {
  throw new Error('Use the development profile, or explicitly select --local-staging for the normal profile.');
}
if (!process.argv[2]) throw new Error('An evidence directory is required.');
const output = resolve(process.argv[2]);
mkdirSync(output, { recursive: true });
const connectionSlug = getDefaultLlmConnection();
const connection = connectionSlug ? getLlmConnection(connectionSlug) : undefined;
const workspace = getWorkspaces()[0];
if (!connection || !workspace) throw new Error('The development profile needs an existing connection and workspace.');

const platform = createHeadlessPlatform({ appVersion: 'completion-live-check', buildChannel: localStaging ? 'local-staging' : 'development' });
const diagnosticCounts: Record<string, number> = {};
platform.logger = {
  info: () => {}, debug: () => {},
  warn: () => { diagnosticCounts.warnings = (diagnosticCounts.warnings ?? 0) + 1; },
  error: () => { diagnosticCounts.errors = (diagnosticCounts.errors ?? 0) + 1; },
};
setSessionPlatform(platform);
const manager = new SessionManager();
// Deliberately do not initialize/recover other sessions from the development profile.
const events: Array<{ sessionId?: string; type?: string; toolName?: string }> = [];
manager.setEventSink((_channel, _target, ...payload: unknown[]) => {
  const value = payload[0];
  if (!value || typeof value !== 'object') return;
  const event = value as { sessionId?: string; type?: string; toolName?: string };
  events.push({ sessionId: event.sessionId, type: event.type, toolName: event.toolName });
});

type Result = { name: string; passed: boolean; sessionId: string; checks: string[]; durationMs: number; toolCalls: number; sourceErrors: number; limit?: string };
const results: Result[] = [];
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const requireCheck = (condition: boolean, label: string) => { if (!condition) throw new Error(label); };

async function send(sessionId: string, prompt: string): Promise<string> {
  let release = () => {};
  const done = new Promise<string>((resolveDone, reject) => {
    const timer = setTimeout(() => {
      release();
      void manager.cancelProcessing(sessionId, false);
      reject(new Error('Live mission timed out after 180 seconds.'));
    }, 180_000);
    release = manager.onSessionComplete(event => {
      if (event.sessionId !== sessionId) return;
      clearTimeout(timer); release();
      if (event.reason !== 'complete') reject(new Error(`Mission stopped: ${event.reason}`));
      else resolveDone(event.finalText ?? '');
    });
  });
  // Attach rejection handling while provider execution is in progress.
  void done.catch(() => {});
  await manager.sendMessage(sessionId, prompt);
  return done;
}

async function mission(name: string, body: (dir: string, sessionId: string) => Promise<string[]>) {
  const started = Date.now();
  const dir = join(output, name);
  mkdirSync(dir, { recursive: true });
  const session = await manager.createSession(workspace.id, {
    name: `QA completion ${name}`, workingDirectory: dir, llmConnection: connection!.slug,
    model: connection!.defaultModel, connectionRoutePinned: true, modelRoutePinned: true,
    permissionMode: 'allow-all', enabledSourceSlugs: [], thinkingLevel: 'standard',
  });
  try {
    const checks = await body(dir, session.id);
    const state = await manager.getSession(session.id);
    requireCheck(state?.activeObjective?.terminalState === 'complete_verified', 'The host did not complete the mission.');
    requireCheck(!state?.pendingTurnRecovery, 'Automatic recovery is still pending.');
    results.push({ name, passed: true, sessionId: session.id, checks, durationMs: Date.now() - started,
      toolCalls: events.filter(event => event.sessionId === session.id && event.type === 'tool_start').length,
      sourceErrors: events.filter(event => event.sessionId === session.id && event.type === 'typed_error').length });
  } catch (error) {
    results.push({ name, passed: false, sessionId: session.id, checks: [], durationMs: Date.now() - started,
      toolCalls: events.filter(event => event.sessionId === session.id && event.type === 'tool_start').length,
      sourceErrors: events.filter(event => event.sessionId === session.id && event.type === 'typed_error').length,
      limit: error instanceof Error ? error.message : 'Unknown live mission failure' });
  }
  console.log(`${name}: ${results.at(-1)!.passed ? 'PASS' : 'FAIL'}`);
}

const boundary = 'Travaille uniquement dans le dossier courant de cette mission. Aucun réseau, aucune autre source, aucun autre fichier utilisateur. Utilise les outils locaux, vérifie les fichiers livrés, puis fournis des liens absolus. Aucun sous-agent ni contrat JSON de complétion.';
try {
  await mission('two-targets', async (dir, sessionId) => {
    writeFileSync(join(dir, 'cleanup.json'), JSON.stringify({ timer: 'cleanup', enabled: true }));
    writeFileSync(join(dir, 'archive.json'), JSON.stringify({ timer: 'archive', enabled: false }));
    const answer = await send(sessionId, `${boundary}\nVérifie les DEUX minuteurs représentés par cleanup.json et archive.json. Livre observations.json : un tableau de deux objets {timer, enabled} fidèles aux fichiers. Relis le résultat avant de conclure.`);
    const data: unknown = JSON.parse(readFileSync(join(dir, 'observations.json'), 'utf8'));
    requireCheck(Array.isArray(data) && data.length === 2, 'Both targets must be delivered.');
    const rows = data as Array<{ timer?: string; enabled?: boolean }>;
    requireCheck(rows.some(row => row.timer === 'cleanup' && row.enabled === true), 'cleanup state missing or wrong.');
    requireCheck(rows.some(row => row.timer === 'archive' && row.enabled === false), 'archive state missing or wrong.');
    requireCheck(answer.includes('observations.json'), 'The requested deliverable link is missing.');
    return ['Both named targets read and represented', 'True and false states preserved', 'Deliverable linked'];
  });

  await mission('three-deliverables', async (dir, sessionId) => {
    writeFileSync(join(dir, 'source.csv'), 'label,value\na,3\nb,5\nc,7\n');
    const answer = await send(sessionId, `${boundary}\nÀ partir de source.csv, livre les TROIS fichiers : totals.json {count, total}, rapport.md expliquant le total calculé, et delivery.txt listant les deux premiers fichiers. Vérifie les trois fichiers après écriture ; ne t'arrête pas après le calcul.`);
    const totals = JSON.parse(readFileSync(join(dir, 'totals.json'), 'utf8')) as { count?: number; total?: number };
    requireCheck(totals.count === 3 && totals.total === 15, 'The total or row count is wrong.');
    requireCheck(readFileSync(join(dir, 'rapport.md'), 'utf8').includes('15'), 'The report omits the result.');
    const delivery = readFileSync(join(dir, 'delivery.txt'), 'utf8');
    requireCheck(delivery.includes('totals.json') && delivery.includes('rapport.md'), 'Delivery inventory incomplete.');
    for (const name of ['totals.json', 'rapport.md', 'delivery.txt']) requireCheck(answer.includes(name), `Missing final link: ${name}`);
    return ['Correct count and total', 'Three real deliverables inspected independently', 'All final files linked'];
  });

  await mission('continuation', async (dir, sessionId) => {
    await send(sessionId, `${boundary}\nCrée uniquement brouillon.md contenant exactement « ALPHA — résultat acquis ». N'écris pas encore la version finale : je donnerai sa consigne ensuite.`);
    const draft = join(dir, 'brouillon.md');
    requireCheck(existsSync(draft), 'The first bounded task did not produce its draft.');
    const before = { sha256: sha(draft), modifiedAt: statSync(draft).mtimeMs };
    const answer = await send(sessionId, `${boundary}\nReprends ce travail. Conserve brouillon.md sans le réécrire. Crée maintenant final.md reprenant le texte du brouillon puis une section « Vérification » avec « BETA ». Livre aussi manifest.json {draftSha256, finalSha256} calculé depuis les octets réels des deux fichiers. Vérifie les fichiers et donne les liens du final et du manifeste.`);
    requireCheck(sha(draft) === before.sha256 && statSync(draft).mtimeMs === before.modifiedAt, 'The completed draft was rewritten.');
    const content = readFileSync(join(dir, 'final.md'), 'utf8');
    requireCheck(content.includes('ALPHA') && content.includes('BETA') && content.includes('Vérification'), 'Continuation lost an earlier or amended requirement.');
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { draftSha256?: string; finalSha256?: string };
    requireCheck(manifest.draftSha256 === sha(draft) && manifest.finalSha256 === sha(join(dir, 'final.md')), 'Delivered hashes do not match the files.');
    requireCheck(answer.includes('final.md') && answer.includes('manifest.json'), 'Continuation deliverables are not linked.');
    return ['Original result preserved without rewrite', 'Amendment delivered', 'Independent byte hashes match', 'Final deliverables linked'];
  });
} finally {
  await manager.cleanup();
  const sourceFiles = ['packages/server-core/src/sessions/SessionManager.ts', 'packages/server-core/src/sessions/turn-completion.ts', 'packages/shared/src/prompts/result-presentation.ts'];
  writeFileSync(join(output, 'report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), environment: localStaging ? 'local-staging-profile' : 'local-development-profile',
    connection: { slug: connection.slug, provider: connection.providerType, model: connection.defaultModel },
    sourceFiles: Object.fromEntries(sourceFiles.map(path => [path, sha(path)])), results, diagnosticCounts,
    limitations: ['Real provider calls and real file operations; headless session runtime, not an Electron UI journey.',
      'Three synthetic local missions do not establish a general success rate.'] }, null, 2) + '\n');
}
if (results.length !== 3 || results.some(result => !result.passed)) process.exitCode = 1;
