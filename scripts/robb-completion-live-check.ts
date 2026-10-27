/**
 * Live acceptance with independent file checks and an existing selected connection.
 * The normal profile is accessible only with the explicit --local-staging option.
 * No credential export, external business action or new connection.
 * Run from the repo: CRAFT_CONFIG_DIR=~/.craft-agent-dev bun scripts/robb-completion-live-check.ts <evidence-directory>
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { saveSourceConfig, getSourcePath } from '../packages/shared/src/sources/storage.ts';
import { SessionManager, setSessionPlatform } from '../packages/server-core/src/sessions/SessionManager.ts';
import { loadRobbOperationsModule } from '../packages/server-core/src/operations/module-loader.ts';
import { createHeadlessPlatform } from '../packages/server-core/src/runtime/platform-headless.ts';
import { getDefaultLlmConnection, getLlmConnection, getWorkspaces } from '../packages/shared/src/config/storage.ts';
import { CONFIG_DIR } from '../packages/shared/src/config/paths.ts';

const localStaging = process.argv.includes('--local-staging');
const selectedMission = process.argv.find(arg => arg.startsWith('--mission='))?.slice('--mission='.length);
const operationsBundle = process.argv.find(arg => arg.startsWith('--operations-bundle='))?.slice('--operations-bundle='.length);
if (!CONFIG_DIR.endsWith('/.craft-agent-dev') && !(localStaging && CONFIG_DIR.endsWith('/.craft-agent'))) {
  throw new Error('Use the development profile, or explicitly select --local-staging for the normal profile.');
}
if (!process.argv[2]) throw new Error('An evidence directory is required.');
const output = resolve(process.argv[2]);
mkdirSync(output, { recursive: true });
const connectionSlug = process.argv.find(arg => arg.startsWith('--connection='))?.slice('--connection='.length) ?? getDefaultLlmConnection();
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
const operations = operationsBundle ? await loadRobbOperationsModule({
  dataRoot: CONFIG_DIR, appVersion: 'completion-live-check', buildChannel: 'production',
  isPackaged: false, env: process.env, modulePath: operationsBundle,
}) : null;
const manager = new SessionManager();
// Deliberately do not initialize/recover other sessions from the development profile.
type ObservedEvent = { sessionId?: string; type?: string; toolName?: string; toolUseId?: string; isError?: boolean; executed?: boolean; a?: number; b?: number; observedAt: number };
const events: ObservedEvent[] = [];
const firstTool = new Map<string, (event: ObservedEvent) => boolean>();
const compactions = new Set<string>();
let qaSourcePath: string | undefined;
let qaSourceSlug: string | undefined;
manager.setEventSink((_channel, _target, ...payload: unknown[]) => {
  const value = payload[0];
  if (!value || typeof value !== 'object') return;
  const event = value as { sessionId?: string; type?: string; toolName?: string; toolUseId?: string; isError?: boolean; executed?: boolean; toolInput?: { a?: number; b?: number }; message?: string };
  const observed = { sessionId: event.sessionId, type: event.type, toolName: event.toolName, toolUseId: event.toolUseId, isError: event.isError, executed: event.executed, ...(event.toolName?.endsWith('qa_sum') ? { a: event.toolInput?.a, b: event.toolInput?.b } : {}), observedAt: Date.now() };
  events.push(observed);
  if (event.type === 'info' && event.message?.startsWith('Compacted') && event.sessionId) compactions.add(event.sessionId);
  if (event.type === 'tool_start' && event.sessionId) {
    const resolveTool = firstTool.get(event.sessionId);
    if (resolveTool?.(observed)) firstTool.delete(event.sessionId);
  }
});

type Result = { name: string; passed: boolean; sessionId: string; checks: string[]; durationMs: number; toolCalls: number; toolErrors: number; firstToolLatencyMs?: number; sourceErrors: number; tokenUsage?: unknown; limit?: string };
const results: Result[] = [];
function metrics(sessionId: string, startedAt: number) {
  const scoped = events.filter(event => event.sessionId === sessionId);
  const calls = scoped.filter(event => event.type === 'tool_start');
  const errors = scoped.filter(event => event.type === 'tool_result' && event.isError);
  return {
    toolCalls: new Set(calls.map(event => event.toolUseId).filter(Boolean)).size,
    toolErrors: new Set(errors.map(event => event.toolUseId).filter(Boolean)).size,
    firstToolLatencyMs: calls[0] ? calls[0].observedAt - startedAt : undefined,
    sourceErrors: scoped.filter(event => event.type === 'typed_error').length,
  };
}
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
      const owned = manager['runtimeState'].sessions.get(sessionId);
      if (owned?.autoRetryPending && !owned.autoRetryPending.cancelled && !owned.autoRetryPending.committed) return;
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
  if (selectedMission && selectedMission !== name) return;
  const started = Date.now();
  const dir = join(output, name);
  mkdirSync(dir, { recursive: true });
  const session = await manager.createSession(workspace!.id, {
    name: `QA completion ${name}`, workingDirectory: dir, llmConnection: connection!.slug,
    model: connection!.defaultModel, connectionRoutePinned: true, modelRoutePinned: true,
    permissionMode: 'allow-all', enabledSourceSlugs: [], thinkingLevel: 'medium',
  });
  try {
    const checks = await body(dir, session.id);
    const state = await manager.getSession(session.id);
    requireCheck(state?.activeObjective?.terminalState === 'complete_verified', 'The host did not complete the mission.');
    requireCheck(!state?.pendingTurnRecovery, 'Automatic recovery is still pending.');
    results.push({ name, passed: true, sessionId: session.id, checks, durationMs: Date.now() - started, tokenUsage: state?.tokenUsage,
      ...metrics(session.id, started) });
  } catch (error) {
    await manager.cancelProcessing(session.id, false).catch(() => {});
    results.push({ name, passed: false, sessionId: session.id, checks: [], durationMs: Date.now() - started,
      ...metrics(session.id, started),
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

  await mission('missing-input-recovery', async (dir, sessionId) => {
    mkdirSync(join(dir, 'secours'), { recursive: true });
    writeFileSync(join(dir, 'secours', 'entree.csv'), 'label,value\na,8\nb,13\n');
    const answer = await send(sessionId, `${boundary}\nEssaie d'abord de lire entree.csv à la racine. S'il est absent, trouve sa copie dans ce dossier et poursuis sans demander mon aide. Livre resultat.json avec count et total, puis rapport.md décrivant le chemin réellement utilisé. Cite les deux fichiers dans la réponse finale.`);
    const data = JSON.parse(readFileSync(join(dir, 'resultat.json'), 'utf8')) as { count?: number; total?: number };
    requireCheck(data.count === 2 && data.total === 21, 'Fallback calculation is incomplete.');
    requireCheck(readFileSync(join(dir, 'rapport.md'), 'utf8').includes('secours'), 'Actual fallback input is not identified.');
    requireCheck(answer.includes('resultat.json') && answer.includes('rapport.md'), 'Fallback deliverables are not linked.');
    return ['Missing initial input did not block completion', 'Fallback source identified', 'Both outputs checked independently'];
  });
  await mission('midstream-amendment', async (dir, sessionId) => {
    const toolStarted = new Promise<void>(resolveTool => firstTool.set(sessionId, () => { resolveTool(); return true; }));
    const initial = send(sessionId, `${boundary}\nCrée pret.txt contenant PRET, puis attends 5 secondes avec un outil local avant de continuer. Crée ensuite resultat.txt contenant exactement VERSION ALPHA et livre un lien vers ce résultat.`);
    await Promise.race([toolStarted, initial.then(() => { throw new Error('No tool observed before the first completion.'); })]);
    await manager.sendMessage(sessionId, `${boundary}\nCorrection de la demande en cours : le résultat définitif doit contenir exactement VERSION BETA (et aucune occurrence de ALPHA). Ajoute aussi controle.json contenant {"version":"BETA","complete":true}. Vérifie les DEUX fichiers et cite-les dans la réponse finale.`);
    await initial;
    const deadline = Date.now() + 180_000;
    let final = '';
    while (Date.now() < deadline) {
      const state = await manager.getSession(sessionId);
      if (!state?.isProcessing && existsSync(join(dir, 'controle.json'))) {
        final = state?.messages.filter(message => message.role === 'assistant' && !message.isIntermediate).at(-1)?.content ?? '';
        break;
      }
      await new Promise(resolveTick => setTimeout(resolveTick, 250));
    }
    requireCheck(readFileSync(join(dir, 'resultat.txt'), 'utf8').trim() === 'VERSION BETA', 'The midstream correction was lost.');
    const control = JSON.parse(readFileSync(join(dir, 'controle.json'), 'utf8')) as { version?: string; complete?: boolean };
    requireCheck(control.version === 'BETA' && control.complete === true, 'The additional requirement was omitted.');
    requireCheck(final.includes('resultat.txt') && final.includes('controle.json'), 'Corrected final deliverables are not linked.');
    return ['A real human correction arrived during tool execution', 'Latest requested content retained', 'Additional requirement delivered and linked'];
  });
  await mission('source-activation-amendment', async (dir, sessionId) => {
    qaSourceSlug = `qa-autonomy-${randomUUID().slice(0, 8)}`;
    qaSourcePath = getSourcePath(workspace!.rootPath, qaSourceSlug);
    requireCheck(!existsSync(qaSourcePath), 'The QA source path must be new.');
    saveSourceConfig(workspace!.rootPath, {
      id: qaSourceSlug, slug: qaSourceSlug, name: 'Disposable local autonomy QA',
      provider: 'qa-local', type: 'mcp', enabled: true, isAuthenticated: false,
      mcp: { transport: 'stdio', command: process.execPath, args: [join(import.meta.dir, 'robb-qa-local-source.mjs')], authType: 'none' },
      tagline: 'Read-only synthetic arithmetic fixture; qa_sum has no side effects.',
    });
    writeFileSync(join(qaSourcePath, 'guide.md'), '# QA local source\n\nRead-only synthetic fixture. Use qa_sum with a and b; result has sum and fixture. No authentication, filesystem writes or network.\n');
    const activationStarted = new Promise<void>(resolveTool => firstTool.set(sessionId, event => {
      if (!event.toolName?.endsWith('source_test')) return false;
      resolveTool(); return true;
    }));
    const initial = send(sessionId, `${boundary}\nException limitée au seul connecteur local fictif ${qaSourceSlug} (aucun réseau). Lis son guide, exécute source_test sur ce slug pour activer les outils, puis utilise son outil qa_sum avec a=1 et b=2. Livre calcul.json contenant exactement le résultat de cet outil et cite le fichier.`);
    await Promise.race([activationStarted, initial.then(() => { throw new Error('Source activation was not observed before completion.'); })]);
    await manager.sendMessage(sessionId, `${boundary}\nCorrection de la demande en cours : utilise uniquement le même connecteur local fictif ${qaSourceSlug}, avec qa_sum a=19 et b=23. Le calcul final doit venir de ce connecteur et valoir 42. Crée aussi controle.txt contenant exactement SOURCE_BETA. Vérifie et cite les DEUX fichiers calcul.json et controle.txt. Aucun autre connecteur ni réseau.`);
    await initial;
    const deadline = Date.now() + 180_000;
    let final = '';
    while (Date.now() < deadline) {
      const state = await manager.getSession(sessionId);
      if (!state?.isProcessing && existsSync(join(dir, 'controle.txt'))) {
        final = state?.messages.filter(message => message.role === 'assistant' && !message.isIntermediate).at(-1)?.content ?? '';
        break;
      }
      await new Promise(resolveTick => setTimeout(resolveTick, 250));
    }
    const data = JSON.parse(readFileSync(join(dir, 'calcul.json'), 'utf8')) as { sum?: number; fixture?: string };
    requireCheck(data.sum === 42 && data.fixture === 'synthetic-local-qa', 'The corrected source result is missing.');
    requireCheck(readFileSync(join(dir, 'controle.txt'), 'utf8').trim() === 'SOURCE_BETA', 'The correction requirement was omitted.');
    requireCheck(final.includes('calcul.json') && final.includes('controle.txt'), 'The source deliverables are not linked.');
    const correctedCalls = new Set(events.filter(event => event.sessionId === sessionId && event.type === 'tool_start' && event.toolName?.endsWith('qa_sum') && event.a === 19 && event.b === 23).map(event => event.toolUseId));
    requireCheck(events.some(event => event.sessionId === sessionId && event.type === 'tool_result' && correctedCalls.has(event.toolUseId) && !event.isError && event.executed !== false), 'No successful corrected QA connector result observed.');
    return ['A correction arrived during source testing', 'Corrected arithmetic came from the read-only local connector', 'Both corrected requirements delivered and linked'];
  });
  await mission('compaction-continuation', async (dir, sessionId) => {
    await send(sessionId, `${boundary}\nPour cette première étape, crée uniquement acquis.json avec {"count":3,"total":15}, relis-le et termine. Garde pour nos prochains livrables la règle suivante : un rapport final devra contenir la mention QA-COMPACT-23. Ne crée pas ce rapport maintenant.`);
    const acquired = join(dir, 'acquis.json');
    const before = { sha256: sha(acquired), modifiedAt: statSync(acquired).mtimeMs };
    // The SDK retains its most recent 20k tokens. A short task correctly has
    // nothing to compact; a bounded synthetic history makes the first task old
    // enough to exercise a real summary without changing runtime settings.
    const history = 'Observation QA synthétique sans exigence supplémentaire.\n'.repeat(1_800);
    const archived = await send(sessionId, `${boundary}\nToutes les exigences précédentes restent applicables. Les observations fictives ci-dessous servent uniquement à tester la compaction. N'exécute aucun outil et réponds uniquement HISTORY_READY.\n${history}`);
    requireCheck(archived.includes('HISTORY_READY'), 'Synthetic history was not accepted.');
    const objectiveBefore = (await manager.getSession(sessionId))?.activeObjective?.objectiveId;
    await manager.sendMessage(sessionId, '/compact Préserve toutes les exigences utilisateur, règles de présentation, résultats acquis et chemins de fichiers.');
    requireCheck(compactions.has(sessionId), 'No actual compaction success event observed.');
    requireCheck((await manager.getSession(sessionId))?.activeObjective?.objectiveId === objectiveBefore, 'Compaction replaced the accepted objective.');
    const answer = await send(sessionId, `${boundary}\nReprends acquis.json sans le réécrire. Crée final.md contenant les chiffres acquis et applique la règle de présentation convenue avant la compaction. Crée manifest.json avec acquiredSha256 et finalSha256 calculés réellement. Vérifie les deux nouveaux fichiers et donne leurs liens.`);
    requireCheck(sha(acquired) === before.sha256 && statSync(acquired).mtimeMs === before.modifiedAt, 'Compaction continuation rewrote acquired work.');
    const final = readFileSync(join(dir, 'final.md'), 'utf8');
    requireCheck(final.includes('15') && final.includes('QA-COMPACT-23'), 'Compaction lost a requirement.');
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { acquiredSha256?: string; finalSha256?: string };
    requireCheck(manifest.acquiredSha256 === sha(acquired) && manifest.finalSha256 === sha(join(dir, 'final.md')), 'Compaction manifest hashes do not match.');
    requireCheck(answer.includes('final.md') && answer.includes('manifest.json'), 'Compaction deliverables are not linked.');
    return ['Real SDK compaction completed', 'Previously accepted objective and presentation requirement retained', 'Acquired file unchanged', 'New outputs and hashes verified'];
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
  const snapshot = operations?.getSnapshot?.(workspace.id) as {
    sessions?: Array<{ sessionId: string; completedTurns: number; toolCalls: number; toolErrors: number }>;
  } | undefined;
  const qaSessionIds = new Set(results.map(result => result.sessionId));
  const qaOperationsSessions = snapshot?.sessions?.filter(session => qaSessionIds.has(session.sessionId)) ?? [];
  const operationsComplete = !operations || qaOperationsSessions.length === results.length;
  if (qaSourcePath && existsSync(qaSourcePath)) renameSync(qaSourcePath, join(output, 'retired-qa-source'));
  const sourceFiles = ['packages/server-core/src/sessions/SessionManager.ts', 'packages/server-core/src/sessions/turn-completion.ts', 'packages/shared/src/prompts/result-presentation.ts'];
  writeFileSync(join(output, 'report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), missionSelection: selectedMission ?? 'all-seven', environment: localStaging ? 'local-staging-profile' : 'local-development-profile',
    connection: { slug: connection.slug, provider: connection.providerType, model: connection.defaultModel },
    operations: operations ? { available: true, extensionId: operations.id, qaSessions: qaOperationsSessions, complete: operationsComplete } : { available: false },
    sourceFiles: Object.fromEntries(sourceFiles.map(path => [path, sha(path)])), results, diagnosticCounts,
    limitations: ['Real provider calls and real file operations; headless session runtime, not an Electron UI journey.',
      'Seven synthetic local missions do not establish a general success rate; the QA connector is local and read-only.'] }, null, 2) + '\n');
  if (!operationsComplete) process.exitCode = 1;
}
if (results.length !== (selectedMission ? 1 : 7) || results.some(result => !result.passed)) process.exitCode = 1;
