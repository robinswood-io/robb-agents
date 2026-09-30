/**
 * Compress human-facing Bash output without changing the command being run.
 * Native `rtk rewrite` remains the eligibility/config gate. Execution captures
 * the ORIGINAL command once, then uses the pinned binary's stdin-only filter.
 * Permissions and conversation history continue to use the original input.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parse as parseShell, quote } from 'shell-quote';
import { RTK_METRICS_PATH, RTK_STATE_DIR } from './rtk-state.ts';

const SPAWN_TIMEOUT_MS = 200;
const MAX_ARCHIVES_PER_SESSION = 100;
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;

export interface RtkRewriteResult {
  modified: boolean;
  input: Record<string, unknown>;
}

export interface RtkContext {
  enabled: boolean;
  path: string | null;
  exclude: string[];
}

export interface RtkOutputContext {
  /** Must be the host-resolved session data directory, never a tool argument. */
  dataFolderPath?: string;
  workingDirectory?: string;
}

/** Fail soft for syntax or output formats whose semantics a filter can change. */
export function getRtkOutputFilter(command: string, exclude: string[] = []): string | undefined {
  // No pipelines, substitutions, shell state, redirections, remote wrappers or
  // multiline scripts: their stdout may be a program's input or durable proof.
  if (/[|&;<>()\r\n`$]/.test(command)) return undefined;
  let parsed: ReturnType<typeof parseShell>;
  try { parsed = parseShell(command); } catch { return undefined; }
  if (!parsed.length || parsed.some(token => typeof token !== 'string')) return undefined;
  const [name, ...args] = parsed as string[];
  if (!name || exclude.includes(name)) return undefined;
  // Explicit machine-readable/raw requests and output-file/report contracts
  // always retain their byte-for-byte native output.
  if (args.some(arg => /^(?:--(?:json|jsonl|ndjson|xml|csv|tsv|porcelain|raw|binary|null|null-data|null-output|print0|format|pretty|name-only|name-status|numstat|output|output-file|reporter|junitxml)(?:[=\-]|$)|-[^-]*[z0][^-]*$|-print0$|-printf$|-o$)/i.test(arg))) return undefined;
  if (name === 'git') {
    // Git global options can alter output/dispatch; use only literal forms.
    if (args[0] === 'status') return 'git-status';
    if (args[0] === 'log' && !args.some(arg => /^-[pGcS]/.test(arg))) return 'git-log';
    // Patches, show output and source reads stay intact for review/evidence.
    return undefined;
  }
  if (name === 'cargo' && args[0] === 'test') return 'cargo-test';
  if (name === 'pytest') return 'pytest';
  if (name === 'tsc') return 'tsc';
  if (name === 'vitest') return 'vitest';
  if (name === 'mypy') return 'mypy';
  if (name === 'prettier' && args.includes('--check')) return 'prettier';
  if (name === 'rg' || name === 'grep') return 'grep';
  if (name === 'fd') return 'find';
  if (name === 'find' && !args.some(arg => /^-(?:exec|execdir|ok|okdir|delete|fprint|fprintf)/.test(arg))) return 'find';
  // Supported direct runners; no arbitrary npm scripts or nested shell eval.
  if ((name === 'npx' || name === 'bunx') && ['tsc', 'vitest', 'prettier'].includes(args[0] ?? '')) {
    return getRtkOutputFilter(quote(args), exclude);
  }
  return undefined;
}

export function rewriteBashWithRtk(
  toolName: string,
  input: Record<string, unknown>,
  rtkPath: string | null,
  excludeCommands: string[],
  onDebug?: (msg: string) => void,
  context: RtkOutputContext = {},
): RtkRewriteResult {
  const unchanged = { modified: false, input };
  if (toolName !== 'Bash' || !rtkPath || !isAbsolute(rtkPath)
    || !context.dataFolderPath || !isAbsolute(context.dataFolderPath)) return unchanged;
  const command = typeof input.command === 'string' ? input.command : '';
  const filter = getRtkOutputFilter(command, excludeCommands);
  if (!filter) return unchanged;

  try {
    const eligibility = spawnSync(rtkPath, ['rewrite', command], {
      encoding: 'utf-8', timeout: SPAWN_TIMEOUT_MS,
      cwd: context.workingDirectory,
      env: { ...process.env, RTK_TELEMETRY_DISABLED: '1' },
    });
    // RTK's allow/ask are eligibility only; never override Robb's permissions.
    if (eligibility.error || ![0, 3].includes(eligibility.status ?? -1)
      || !eligibility.stdout.trim() || eligibility.stdout.trim() === command) return unchanged;

    // A model may have replaced its writable data directory with a symlink.
    // Decline optimization before creating any archive outside the host path.
    mkdirSync(context.dataFolderPath, { recursive: true, mode: 0o700 });
    if (lstatSync(context.dataFolderPath).isSymbolicLink()) return unchanged;
    const archiveRoot = join(context.dataFolderPath, 'rtk');
    mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
    if (lstatSync(archiveRoot).isSymbolicLink()) return unchanged;
    // Do not rotate away evidence during the task. Once the session's archive
    // allowance is used, run subsequent commands normally without compression.
    if (readdirSync(archiveRoot).length >= MAX_ARCHIVES_PER_SESSION) return unchanged;
    const archive = mkdtempSync(join(archiveRoot, 'output-'));
    chmodSync(archive, 0o700);
    mkdirSync(RTK_STATE_DIR, { recursive: true, mode: 0o700 });
    if (lstatSync(RTK_STATE_DIR).isSymbolicLink()) return unchanged;
    const q = (value: string) => quote([value]);
    const stdout = q(join(archive, 'stdout.log'));
    const stderr = q(join(archive, 'stderr.log'));
    const shown = q(join(archive, 'shown.log'));
    const filterError = q(join(archive, 'filter-error.log'));
    const exitCode = q(join(archive, 'exit-code'));
    const hint = `\n[RTK full output: ${join(archive, 'stdout.log')}; stderr.log and exit-code in the same directory]\n`;

    // The subshell isolates temporary variables/umask. Only simple commands are
    // eligible, so there is no persistent cd/export state to lose. Never rerun
    // the original command on filter failure (it may mutate files).
    const wrapped = `(
robb_rtk_original_umask=$(umask)
umask 077
: >${stdout}
: >${stderr}
umask "$robb_rtk_original_umask"
robb_rtk_started=$SECONDS
if { ${command}; } >${stdout} 2>${stderr}; then robb_rtk_exit=0; else robb_rtk_exit=$?; fi
umask 077
printf '%s\\n' "$robb_rtk_exit" >${exitCode}
robb_rtk_in=$(wc -c <${stdout})
robb_rtk_err=$(wc -c <${stderr})
if [ "$robb_rtk_exit" -eq 0 ] && [ "$((robb_rtk_in + robb_rtk_err))" -le ${MAX_ARCHIVE_BYTES} ] && RTK_TELEMETRY_DISABLED=1 ${q(process.platform === 'win32' ? rtkPath.replaceAll('\\', '/') : rtkPath)} pipe --filter ${q(filter)} <${stdout} >${shown} 2>${filterError} && [ -s ${shown} ]; then
  printf '%s' ${q(hint)} >>${shown}
  robb_rtk_out=$(wc -c <${shown})
  if [ "$robb_rtk_out" -lt "$robb_rtk_in" ] && [ -s ${shown} ]; then
    cat ${shown}
    printf '%s %s %s\\n' "$((robb_rtk_in + robb_rtk_err))" "$((robb_rtk_out + robb_rtk_err))" "$(((SECONDS - robb_rtk_started) * 1000))" >>${q(RTK_METRICS_PATH)} 2>/dev/null || :
  else cat ${stdout}; fi
else cat ${stdout}; fi
cat ${stderr} >&2
if [ "$((robb_rtk_in + robb_rtk_err))" -gt ${MAX_ARCHIVE_BYTES} ]; then
  rm -f ${stdout} ${stderr} ${shown} ${filterError}
fi
exit "$robb_rtk_exit"
)`;
    onDebug?.(`[rtk] ${filter}: capture original output, then filter with detected binary`);
    return { modified: true, input: { ...input, command: wrapped } };
  } catch {
    onDebug?.('[rtk] capture/filter unavailable; preserving original command');
    return unchanged;
  }
}
