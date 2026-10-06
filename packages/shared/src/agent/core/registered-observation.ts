/// <reference path="../bash-parser.d.ts" />
import bashParser from 'bash-parser';
import {
  isAllowlistedReadOnlyGitArguments,
  READ_ONLY_GIT_HARDENING_ARGS,
  validateBashCommand,
} from '../bash-validator.ts';
import type { CompiledBashPattern } from '../mode-types.ts';

const OBJECTIVE_SHELL_EXECUTOR_TOOL_NAME = /(?:^|[_:.])(?:bash|shell|exec_command|ssh_execute)$/i;

/** Native or namespaced tools whose command/cmd/script input executes a shell. */
export function isObjectiveShellExecutorToolName(toolName: string): boolean {
  return toolName.length > 0 && toolName.length <= 512
    && OBJECTIVE_SHELL_EXECUTOR_TOOL_NAME.test(toolName);
}

const OBJECTIVE_READ_ONLY_SHELL_PATTERNS: CompiledBashPattern[] = [
  {
    regex: /^cd(?:\s|$)/,
    source: 'working-directory selection within the bounded shell process',
  },
  {
    // The AST validator still rejects redirects, substitutions, expansions and
    // background execution. Exclude both spellings of -v and the %n conversion:
    // each assigns a shell variable rather than writing only to stdout.
    regex: /^printf\b(?!\s+-v(?:[A-Za-z_][A-Za-z0-9_]*)?(?:\s|$))(?![^\r\n]*%(?:[0-9]+\$)?[-+ #0']*(?:\*|[0-9]+)?(?:\.(?:\*|[0-9]+))?(?:hh|h|ll|l|j|z|t|L)?n)/,
    source: 'stdout-only printf without variable assignment',
  },
  {
    regex: /^(?:cat|grep|head|ls|pwd|stat|tail|test|wc)(?:\s|$)/,
    source: 'closed objective read-only utilities',
  },
  {
    regex: /^diff\b(?![^\n]*\s--output(?:=|\s|$))/,
    source: 'diff without output-file mutation',
  },
  {
    regex: /^(?:cmp\s+-s\s+[A-Za-z0-9_@%+=:,./-]+\s+[A-Za-z0-9_@%+=:,./-]+|shasum\s+-a\s+256\s+[A-Za-z0-9_@%+=:,./-]+)$/,
    source: 'closed static file integrity checks',
  },
  {
    regex: /^find(?:\s|$)/,
    source: 'find without execution or deletion flags',
  },
  {
    regex: /^rg(?![^\n]*(?:--pre(?:-glob)?)(?:=|\s))(?:\s|$)/,
    source: 'ripgrep without command preprocessors',
  },
  {
    // Options are validated per subcommand by
    // objectiveGitReadsUseAllowlistedOptions below. The pattern only selects
    // the closed read-only operation set.
    regex: /^git\s+--no-optional-locks\s+-c\s+core\.fsmonitor=false\s+-c\s+core\.hooksPath=\/dev\/null\s+-c\s+log\.showSignature=false\s+-c\s+format\.pretty=medium\s+--no-pager\s+(?:-C\s+[^\s]+\s+)?(?:branch\s+--show-current|grep|log|ls-files|merge-base|rev-parse)(?:\s|$)/,
    source: 'closed read-only git operations',
  },
  {
    // Only numeric line-range printing over literal paths. sed's in-place,
    // file-write and shell-execution forms deliberately cannot match.
    regex: /^sed\s+(?:-n|--quiet|--silent)\s+[1-9]\d*(?:,[1-9]\d*)?p(?:\s+(?!-)(?![^\s]*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_@%+=:,./()\-]+)*$/,
    source: 'closed sed numeric line-range inspection',
  },
];

// Keep this list aligned with the test/check commands that the objective
// outcome gate already treats as observations. Unlike Explore permissions,
// this is only evidence classification after an exact completed invocation.
const OBJECTIVE_TEST_SHELL_PATTERNS: CompiledBashPattern[] = [
  {
    regex: /^(?:bun|npm|pnpm|yarn)\s+(?:test(?:\s|$)|run\s+(?:check|lint|test|typecheck)(?=$|[\s:_-]))/,
    source: 'closed objective test commands',
  },
  {
    regex: /^(?:pytest|go\s+test|cargo\s+test)(?:\s|$)/,
    source: 'closed objective test runners',
  },
  {
    regex: /^tsc\b(?=[^\n]*--noEmit(?:\s|$))/,
    source: 'TypeScript no-emit validation',
  },
];

/**
 * Conservative shell-state classifier for evidence chronology. This is not a
 * permission grant: it only decides whether a completed command can safely
 * leave an older target observation current.
 */
export function isProvablyReadOnlyShellCommand(command: string): boolean {
  return validateBashCommand(command, OBJECTIVE_READ_ONLY_SHELL_PATTERNS).allowed
    && objectiveGitReadsUseAllowlistedOptions(command);
}

function objectiveGitReadsUseAllowlistedOptions(command: string): boolean {
  let ast: unknown;
  try { ast = bashParser(command); } catch { return false; }
  let safe = true;
  const visit = (value: unknown): void => {
    if (!safe || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = value as Record<string, unknown>;
    if (node.type === 'Command') {
      const invocation = literalCommand(node, true);
      if (invocation?.name === 'git' && !isAllowlistedReadOnlyGitArguments(invocation.args)) {
        safe = false;
        return;
      }
    }
    Object.values(node).forEach(visit);
  };
  visit(ast);
  return safe;
}

function isHardenableGitRead(invocation: { name: string; args: string[] }): boolean {
  if (invocation.name !== 'git') return false;
  const args = [...invocation.args];
  const scopedCwd: string[] = [];
  if (args[0] === '-C' && args[1]) scopedCwd.push(...args.splice(0, 2));
  return isAllowlistedReadOnlyGitArguments([
    ...READ_ONLY_GIT_HARDENING_ARGS,
    ...scopedCwd,
    ...args,
  ]);
}

function isUnsupportedGitObservationCandidate(invocation: { name: string; args: string[] }): boolean {
  if (invocation.name !== 'git') return false;
  const args = [...invocation.args];
  if (args[0] === '-C' && args[1]) args.splice(0, 2);
  // These familiar observation subcommands are deliberately not allowlisted:
  // status/diff/show and patch/stat log can invoke repository filters. Still
  // classify their plain form as recoverable so the refusal can direct the
  // agent to target-bound Read/rg/cmp or a supported metadata Git probe.
  if (['status', 'diff', 'show'].includes(args[0] ?? '')) return true;
  if (args[0] === 'log' && args.some(argument => /^(?:-p|--patch|--stat|--numstat|--shortstat|--name-only|--name-status|--raw)$/.test(argument))) {
    return true;
  }
  return false;
}

function isRecoverablePlainGitStatus(invocation: { name: string; args: string[] }): boolean {
  if (invocation.name !== 'git') return false;
  const args = [...invocation.args];
  if (args[0] === '-C' && args[1] && !args[1].startsWith('-')) args.splice(0, 2);
  if (args.shift() !== 'status') return false;
  return args.every(argument => /^(?:--short|--branch|--porcelain(?:=v[12])?|--untracked-files(?:=(?:no|normal|all))?|--ignored(?:=(?:traditional|matching|no))?|--ahead-behind|--no-ahead-behind|-s|-b|-u(?:no|normal|all)?)$/.test(argument));
}

/**
 * Additional shell observations usable only after an exact registered check
 * matched this invocation, target, output and chronology. This grants no tool
 * permission and is deliberately narrower than arbitrary shell execution.
 */
export function isRegisteredShellObservation(command: string): boolean {
  let ast: { commands?: Array<Record<string, unknown>> };
  try { ast = bashParser(command) as typeof ast; } catch { return false; }
  if (ast.commands?.length !== 1) return false;
  const node = ast.commands[0]!;
  if (node.async) return false;
  if (node.type === 'LogicalExpression') {
    if (node.op !== 'and') return false;
    const validator = literalCommand(node.left, true);
    const marker = literalCommand(node.right, false);
    // This marker can run only if the actual validator exited successfully.
    // It is not a substitute for the registered target/result/chronology
    // checks, and printf alone never proves an observation.
    return !!validator && isValidationScript(validator)
      && marker?.name === 'printf' && marker.args.length === 1
      && marker.args[0]!.length > 0 && marker.args[0]!.length <= 1024
      && !marker.args[0]!.includes('%');
  }
  const invocation = literalCommand(node, true);
  if (!invocation) return false;
  if (invocation.name === 'ssh' || invocation.name === '/usr/bin/ssh') {
    return command.length <= 8192 && isRemoteValidation(invocation.args);
  }
  if (isBoundedRegisteredInspection(invocation)) return true;
  return isTrustedCurlExecutable(invocation.name)
    ? isSingleHttpRead(invocation.args) : isValidationScript(invocation);
}

/**
 * Registered observations whose command grammar itself proves that they do
 * not mutate state. This deliberately excludes opaque validation scripts and
 * remote SSH validators: registration binds their target and expected result,
 * but a friendly executable name cannot prove their implementation is read
 * only.
 */
export function isReadOnlyRegisteredShellObservation(command: string): boolean {
  if (!command || command.length > 32_000) return false;
  let ast: { commands?: Array<Record<string, unknown>> };
  try { ast = bashParser(command) as typeof ast; } catch { return false; }
  if (ast.commands?.length !== 1) return false;
  const node = ast.commands[0]!;
  if (node.async || node.type !== 'Command') return false;
  const invocation = literalCommand(node, true);
  if (!invocation) return false;
  return isBoundedRegisteredInspection(invocation)
    || (isTrustedCurlExecutable(invocation.name) && isSingleHttpRead(invocation.args));
}

function isStaticSourceInspectionInvocation(
  invocation: { name: string; args: string[] } | undefined,
): invocation is { name: string; args: string[] } {
  if (!invocation || !['sed', '/bin/sed', '/usr/bin/sed'].includes(invocation.name)
    || invocation.args.length < 3 || invocation.args.length > 8) return false;
  const [option, range] = invocation.args;
  return (option === '-n' || option === '--quiet' || option === '--silent')
    && /^[1-9]\d{0,6}(?:,[1-9]\d{0,6})?p$/.test(range ?? '');
}

function staticSourceInspectionInvocation(
  command: string,
): { name: string; args: string[] } | undefined {
  if (!command || command.length > 32_000) return undefined;
  let ast: { commands?: Array<Record<string, unknown>> };
  try { ast = bashParser(command) as typeof ast; } catch { return undefined; }
  if (ast.commands?.length !== 1) return undefined;
  const node = ast.commands[0]!;
  if (node.async || node.type !== 'Command') return undefined;
  const invocation = literalCommand(node, true);
  return isStaticSourceInspectionInvocation(invocation) ? invocation : undefined;
}

/** Identify the exact single-command `sed -n` shape before deciding whether
 * its remote path is admissible. This is used only to fail closed on a source
 * read that resembles the supported form but targets a secret or unsafe path. */
export function isRemoteStaticSourceInspectionCandidate(command: string): boolean {
  return staticSourceInspectionInvocation(command) !== undefined;
}

/** Return the one literal source path from the closed `sed -n` grammar.
 * Relative paths are intentionally returned but are not authorized here: the
 * structured-SSH caller must resolve them against its separately authenticated
 * remote cwd/root tuple before granting the read. */
export function remoteStaticSourceInspectionLiteralPath(command: string): string | undefined {
  const invocation = staticSourceInspectionInvocation(command);
  if (!invocation || invocation.args.length !== 3) return undefined;
  const path = invocation.args[2];
  if (!path || path.length > 2_048 || path.startsWith('-')
    || !/^(?:\/srv\/|\.\/)?[A-Za-z0-9_@%+=:,./()\-]+\.(?:c?js|mjs|ts|tsx|json|sql|ya?ml|toml|ini|conf|md|service)$/i.test(path)) {
    return undefined;
  }
  const segments = (path.startsWith('/') ? path.slice(1) : path.replace(/^\.\//u, '')).split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')
    || /(?:^|\/)(?:\.env(?:\.[^\/]*)?|\.ssh|secret[^\/]*|credentials?[^\/]*|private[_-]?key[^\/]*|id_(?:rsa|dsa|ecdsa|ed25519))(?=\/|$)/i.test(path)) {
    return undefined;
  }
  return path;
}

/** Multiple literal source reads share the same per-file confinement as the
 * single-file form. No shell graph, option or unvalidated file may piggyback. */
export function remoteStaticSourceInspectionLiteralPaths(command: string): string[] | undefined {
  const invocation = staticSourceInspectionInvocation(command);
  if (!invocation || invocation.args.length < 4) return undefined;
  const files = invocation.args.slice(2);
  if (files.some(path => !path || path.length > 2_048 || path.startsWith('-')
    || !/^(?:\/srv\/|\.\/)?[A-Za-z0-9_@%+=:,./()\-]+\.(?:c?js|mjs|ts|tsx|json|sql|ya?ml|toml|ini|conf|md|service)$/i.test(path)
    || (path.startsWith('/') ? path.slice(1) : path.replace(/^\.\//u, '')).split('/')
      .some(segment => !segment || segment === '.' || segment === '..')
    || /(?:^|\/)(?:\.env(?:\.[^\/]*)?|\.ssh|secret[^\/]*|credentials?[^\/]*|private[_-]?key[^\/]*|id_(?:rsa|dsa|ecdsa|ed25519))(?=\/|$)/i.test(path))) return undefined;
  return files;
}

/** Detect the supported `sed -n` shape anywhere in a shell AST. This does not
 * grant execution: it prevents a broad workspace permission regex from
 * classifying a composite remote source read as generically read-only. */
export function containsRemoteStaticSourceInspectionCandidate(command: string): boolean {
  if (!command || command.length > 32_000) return false;
  let ast: unknown;
  try { ast = bashParser(command); } catch { return false; }
  let found = false;
  const visit = (value: unknown): void => {
    if (found || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = value as Record<string, unknown>;
    if (node.type === 'Command'
      && isStaticSourceInspectionInvocation(literalCommand(node, true))) {
      found = true;
      return;
    }
    Object.values(node).forEach(visit);
  };
  visit(ast);
  return found;
}

/** A numeric `sed -n` range over one literal technical source below `/srv`.
 * This proves only the command/path shape. The caller must additionally bind
 * it to an explicitly authorized structured-SSH server and objective; it is
 * intentionally not part of the generic registered-observation read grant. */
export function isBoundedRemoteStaticSourceInspection(command: string): boolean {
  const invocation = staticSourceInspectionInvocation(command);
  if (!invocation || invocation.args.length !== 3) return false;
  const path = invocation.args[2];
  const segments = path?.startsWith('/srv/') ? path.slice('/srv/'.length).split('/') : [];
  return !!path
    && /^\/srv\/[A-Za-z0-9_@%+=:,./()\-]{1,2044}\.(?:c?js|mjs|ts|tsx|json|sql|ya?ml|toml|ini|conf|md|service)$/i.test(path)
    && segments.length > 0
    && segments.every(segment => !!segment && segment !== '.' && segment !== '..')
    && !/(?:^|\/)(?:\.env(?:\.[^\/]*)?|\.ssh|secret[^\/]*|credentials?[^\/]*|private[_-]?key[^\/]*)(?=\/|$)/i.test(path);
}

export type BoundedTargetedRemoteOperationalInspection =
  | { kind: 'http'; method: 'GET' | 'HEAD'; url: string; followsRedirects: boolean }
  | {
      kind: 'docker-image';
      targets: string[];
      output: 'image-id' | 'repo-digests' | 'unsafe';
    }
  | { kind: 'docker-manifest'; target: string }
  | { kind: 'docker-compose'; path: string };

interface BoundedDockerImageInspection {
  targets: string[];
  output: 'image-id' | 'repo-digests' | 'unsafe';
}

function boundedDockerImageInspection(
  sourceArgs: string[],
): BoundedDockerImageInspection | undefined {
  if (!isBoundedDockerInspection(['inspect', ...sourceArgs])) return undefined;
  const args = [...sourceArgs];
  const targets: string[] = [];
  let format: string | undefined;
  while (args.length) {
    const arg = args.shift()!;
    // Calculating image size is unnecessary for the bounded identity check.
    if (arg === '-s' || arg === '--size') return undefined;
    if (arg === '-f' || arg === '--format') {
      if (format !== undefined) return undefined;
      format = args.shift();
      if (format === undefined) return undefined;
      continue;
    }
    if (arg.startsWith('--format=')) {
      if (format !== undefined) return undefined;
      format = arg.slice('--format='.length);
      continue;
    }
    // `docker image inspect` does not need the generic inspect `--type`
    // selector. Rejecting it keeps the target family explicit here.
    if (arg === '--type' || arg.startsWith('--type=')) return undefined;
    targets.push(arg);
  }
  if (targets.length === 0) return undefined;
  const output = format === '{{.Id}}'
    ? 'image-id'
    : format === '{{json .RepoDigests}}'
      ? 'repo-digests'
      : 'unsafe';
  return { targets, output };
}

/** Parse the closed operational-read grammar while retaining the exact target
 * that pre-tool-use must bind to the current human objective. A recognized
 * redirecting curl remains a candidate so the caller can fail it closed, but
 * it is never returned as a bounded observation by the boolean wrapper. */
export function classifyBoundedTargetedRemoteOperationalInspection(
  command: string,
): BoundedTargetedRemoteOperationalInspection | undefined {
  if (!command || command.length > 32_000) return undefined;
  let ast: { commands?: Array<Record<string, unknown>> };
  try { ast = bashParser(command) as typeof ast; } catch { return undefined; }
  if (ast.commands?.length !== 1) return undefined;
  const invocation = literalCommand(ast.commands[0], true);
  if (!invocation) return undefined;

  if (isTrustedCurlExecutable(invocation.name)) {
    if (!invocation.args.includes('--fail-with-body')
      || !isSingleHttpRead(invocation.args, true)) return undefined;
    const rawUrl = invocation.args.find(arg => /^https?:\/\//i.test(arg));
    if (!rawUrl) return undefined;
    try {
      const url = new URL(rawUrl);
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase())) {
        return undefined;
      }
      const followsRedirects = invocation.args.some(arg => arg === '--location'
        || /^-[sSfIL]*L[sSfIL]*$/.test(arg));
      const explicitMethodIndex = invocation.args.findIndex(arg => arg === '-X' || arg === '--request');
      const method = invocation.args.includes('--head')
        || invocation.args.some(arg => /^-[sSfIL]*I[sSfIL]*$/.test(arg))
        || explicitMethodIndex >= 0 && invocation.args[explicitMethodIndex + 1] === 'HEAD'
        ? 'HEAD' : 'GET';
      return { kind: 'http', method, url: url.toString(), followsRedirects };
    } catch { return undefined; }
  }

  const executable = invocation.name.split('/').at(-1) ?? invocation.name;
  if (executable !== 'docker' || !isTrustedOperationalExecutable(invocation.name, executable)) {
    return undefined;
  }
  const [family, operation, ...rest] = invocation.args;
  if (family === 'image' && operation === 'inspect') {
    const inspection = boundedDockerImageInspection(rest);
    return inspection ? { kind: 'docker-image', ...inspection } : undefined;
  }
  if (family === 'manifest' && operation === 'inspect') {
    const args = [...rest];
    let verbose = false;
    if (args[0] === '--verbose') {
      args.shift();
      verbose = true;
    }
    if (args.at(-1) === '--verbose') {
      if (verbose) return undefined;
      args.pop();
    }
    return args.length === 1
      && /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,511}$/.test(args[0]!)
      ? { kind: 'docker-manifest', target: args[0]! }
      : undefined;
  }
  if (family !== 'compose') return undefined;
  const args = [operation, ...rest];
  if (!['-f', '--file'].includes(args[0] ?? '')
    || args.length !== 4
    || args[2] !== 'config'
    || args[3] !== '--images') return undefined;
  const path = args[1];
  const segments = path?.startsWith('/srv/') ? path.slice('/srv/'.length).split('/') : [];
  return path
    && /^\/srv\/[A-Za-z0-9_@%+=:,./()\-]{1,2044}\.ya?ml$/i.test(path)
    && segments.length > 0
    && segments.every(segment => !!segment && segment !== '.' && segment !== '..')
    && !/(?:^|\/)(?:\.env(?:\.[^\/]*)?|\.ssh|secret[^\/]*|credentials?[^\/]*|private[_-]?key[^\/]*)(?=\/|$)/i.test(path)
    ? { kind: 'docker-compose', path }
    : undefined;
}

export function isBoundedTargetedRemoteOperationalInspection(command: string): boolean {
  const inspection = classifyBoundedTargetedRemoteOperationalInspection(command);
  return !!inspection
    && (inspection.kind !== 'http' || !inspection.followsRedirects)
    && (inspection.kind !== 'docker-image' || inspection.output !== 'unsafe');
}

export type ReadOnlyRemoteObservationRepair =
  | 'split-composite'
  | 'git-hardening'
  | 'postgres-guards'
  | 'opaque-validator';

/**
 * Explain a recoverable *shape* mismatch without weakening the read-only
 * grammar. Remote agents commonly bundle a loop with otherwise harmless
 * inspections, or send a plain SELECT through the explicitly configured psql tuple.
 * Those calls must stay fail-closed, but the refusal should tell the agent how
 * to retry safely instead of presenting missing user authority as the cause.
 */
export function classifyReadOnlyRemoteObservationRepair(
  command: string,
): ReadOnlyRemoteObservationRepair | undefined {
  if (!command || command.length > 32_000 || isReadOnlyRegisteredShellObservation(command)) {
    return undefined;
  }

  let ast: { commands?: Array<Record<string, unknown>> };
  try {
    ast = bashParser(command) as typeof ast;
  } catch {
    // bash-parser 0.5 rejects the valid compact `do if ...; then` spelling.
    // Retry only that syntactic normalization so a harmless inspection loop
    // receives split/literal guidance. Heredocs and every other parse failure
    // remain indistinguishable from executable content and fail closed.
    if (/<<-?\s*['"]?[A-Za-z_]/.test(command) || !/;\s*do\s+if\b/.test(command)) {
      return undefined;
    }
    try {
      ast = bashParser(command.replace(/;\s*do\s+if\b/g, '; do\nif')) as typeof ast;
    } catch {
      return undefined;
    }
  }
  if (!ast.commands?.length) return undefined;

  if (ast.commands.length === 1) {
    const invocation = literalCommand(ast.commands[0], true);
    if (invocation && (isHardenableGitRead(invocation)
      || isUnsupportedGitObservationCandidate(invocation))) {
      return 'git-hardening';
    }
    if (invocation && isValidationScript(invocation)) {
      return 'opaque-validator';
    }
  }

  return isPlausiblyReadOnlyComposite(ast)
    ? 'split-composite'
    : undefined;
}

/**
 * Apply the same recoverable remote-command diagnostics when an agent tries
 * to bypass an `ssh_execute` refusal with a literal local `ssh` command. This
 * never grants SSH execution: it only recognizes a closed, passive transport
 * shape and classifies the quoted remote payload with the existing grammar.
 */
export function classifyNestedSshReadOnlyRemoteObservationRepair(
  command: string,
): ReadOnlyRemoteObservationRepair | undefined {
  if (!command || command.length > 32_000) return undefined;
  let ast: { commands?: Array<Record<string, unknown>> };
  try { ast = bashParser(command) as typeof ast; } catch { return undefined; }
  if (ast.commands?.length !== 1) return undefined;
  const invocation = literalCommand(ast.commands[0], false);
  if (!invocation || !['ssh', '/usr/bin/ssh'].includes(invocation.name)) return undefined;

  const args = [...invocation.args];
  let identitySeen = false;
  while (args[0]?.startsWith('-')) {
    const option = args.shift();
    if (option === '-i' && !identitySeen
      && /^(?:\/|~\/\.ssh\/)[A-Za-z0-9_@%+=,./-]+$/.test(args[0] ?? '')) {
      args.shift();
      identitySeen = true;
      continue;
    }
    if (option === '-o'
      && /^(?:BatchMode=yes|ConnectTimeout=[1-9]\d{0,2})$/.test(args[0] ?? '')) {
      args.shift();
      continue;
    }
    if (option === '-p' && /^(?:[1-9]\d{0,4})$/.test(args[0] ?? '')) {
      const port = Number(args.shift());
      if (port <= 65_535) continue;
    }
    return undefined;
  }
  if (args.length !== 2
    || !/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(args[0]!)) {
    return undefined;
  }
  // Parsing the outer SSH invocation unquotes its payload. Some agents use
  // `printf "\\n..."`; bash-parser materializes those escapes as literal
  // newlines inside double quotes, which its second parse cannot consume.
  // Re-escape only such quoted newlines before applying the same grammar.
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let remote = '';
  for (const character of args[1]!) {
    if (escaped) {
      remote += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      remote += character;
      escaped = true;
      continue;
    }
    if ((character === "'" || character === '"') && (!quote || quote === character)) {
      quote = quote ? undefined : character;
      remote += character;
      continue;
    }
    if (quote === '"' && character === '\n') {
      remote += '\\n';
      continue;
    }
    if (quote === '"' && character === '\r') {
      remote += '\\r';
      continue;
    }
    remote += character;
  }
  // The parser also crashes on Docker's inert Go-template placeholders even
  // when they are inside a literal `--format` word. Replacing only closed,
  // static placeholders is safe for this refusal classifier (never a grant).
  remote = remote.replace(/\{\{[A-Za-z0-9_.-]{1,128}\}\}/g, 'FORMAT');
  // A literal trailing regex anchor in a quoted Docker filter triggers the
  // same parser bug (`name="^/service$"`). It is not a parameter expansion;
  // normalize only the dollar immediately before the closing quote.
  remote = remote.replace(/\$(?=")/g, 'END');
  return classifyReadOnlyRemoteObservationRepair(remote);
}

/**
 * Detect an actual local SSH transport invocation independently from the
 * remote payload classifier. This is a refusal boundary, never an execution
 * grant: a mutating, opaque, malformed, or merely `pwd` payload is still SSH
 * transport and must use the configured `ssh_execute` tool.
 *
 * Inspect command positions in the parsed AST rather than searching text, so
 * examples, echo/printf arguments and inert quoted strings are not confused
 * with an invocation. Literal `command ssh` and literal shell `-c` wrappers
 * are unwrapped because they execute the nested command locally.
 */
export function containsLocalSshTransportInvocation(command: string): boolean {
  if (!command || command.length > 32_000) return false;
  // bash-parser 0.5 exposes quoted heredoc bodies as top-level commands. Mask
  // only literal-delimiter bodies before parsing so inert examples remain
  // data, while commands before/after the heredoc retain their AST position.
  const lines = command.split('\n');
  const parseLines: string[] = [];
  let heredoc: { delimiter: string; stripTabs: boolean } | undefined;
  for (const line of lines) {
    if (heredoc) {
      const candidate = heredoc.stripTabs ? line.replace(/^\t+/, '') : line;
      if (candidate === heredoc.delimiter) heredoc = undefined;
      parseLines.push('');
      continue;
    }
    const marker = /<<(-)?\s*(?:(['"])([A-Za-z_][A-Za-z0-9_]*)\2|([A-Za-z_][A-Za-z0-9_]*))/.exec(line);
    if (marker) {
      heredoc = { delimiter: marker[3] ?? marker[4]!, stripTabs: marker[1] === '-' };
      parseLines.push(line.replace(marker[0], '< /dev/null'));
    } else {
      parseLines.push(line);
    }
  }
  let ast: unknown;
  try { ast = bashParser(parseLines.join('\n')); } catch { return false; }

  const literalWord = (value: unknown): string | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const word = value as { type?: string; text?: string; expansion?: unknown[] };
    return word.type === 'Word' && typeof word.text === 'string' && !word.expansion?.length
      ? word.text : undefined;
  };
  const transportExecutable = (value: string | undefined): boolean => (
    !!value && (value === 'ssh' || /^(?:\/[^\u0000-\u001f\u007f]+)+\/ssh$/.test(value))
  );
  const commandHead = (node: Record<string, unknown>): { name: string; args: string[] } | undefined => {
    if (node.type !== 'Command') return undefined;
    const name = literalWord(node.name);
    if (!name) return undefined;
    const args: string[] = [];
    for (const item of Array.isArray(node.suffix) ? node.suffix : []) {
      const value = literalWord(item);
      if (value !== undefined) args.push(value);
    }
    return { name, args };
  };
  const nestedInvocation = (args: string[]): { name: string; args: string[] } | undefined => (
    args[0] ? { name: args[0], args: args.slice(1) } : undefined
  );
  const wrappedExecutable = (
    { name, args }: { name: string; args: string[] },
    wrapperDepth = 0,
  ): boolean => {
    if (transportExecutable(name)) return true;
    if (wrapperDepth >= 4) return false;
    const executable = name.split('/').at(-1);
    if (executable === 'command') {
      const rest = [...args];
      while (rest[0]?.startsWith('-')) {
        const option = rest.shift();
        if (option === '--') break;
        // `command -v/-V` only inspects command availability; it does not
        // invoke SSH. `command -p ssh ...` executes it with the default PATH.
        if (option === '-v' || option === '-V') return false;
        if (option !== '-p') return false;
      }
      const nested = nestedInvocation(rest);
      return !!nested && wrappedExecutable(nested, wrapperDepth + 1);
    }
    if (executable === 'env') {
      const rest = [...args];
      while (rest.length > 0) {
        const option = rest[0]!;
        if (option === '--') {
          rest.shift();
          break;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(option)) {
          rest.shift();
          continue;
        }
        if (option === '-i' || option === '--ignore-environment' || option === '-0'
          || option === '--null') {
          rest.shift();
          continue;
        }
        if (option === '-u' || option === '--unset' || option === '-C' || option === '--chdir') {
          if (rest.length < 2) return false;
          rest.splice(0, 2);
          continue;
        }
        if (/^--(?:unset|chdir)=/.test(option)) {
          rest.shift();
          continue;
        }
        if (option === '-S' || option === '--split-string') {
          return typeof rest[1] === 'string'
            && containsLocalSshTransportInvocation(rest[1]);
        }
        const splitString = /^--split-string=(.*)$/.exec(option)?.[1];
        if (splitString !== undefined) return containsLocalSshTransportInvocation(splitString);
        if (option.startsWith('-')) return false;
        break;
      }
      const nested = nestedInvocation(rest);
      return !!nested && wrappedExecutable(nested, wrapperDepth + 1);
    }
    if (executable === 'sudo') {
      const rest = [...args];
      const optionsWithValue = new Set([
        '-C', '--close-from', '-D', '--chdir', '-g', '--group', '-h', '--host',
        '-p', '--prompt', '-R', '--chroot', '-r', '--role', '-T', '--command-timeout',
        '-t', '--type', '-u', '--user', '--other-user',
      ]);
      const executionFlags = new Set([
        '-A', '--askpass', '-b', '--background', '-E', '--preserve-env', '-H', '--set-home',
        '-n', '--non-interactive', '-P', '--preserve-groups', '-S', '--stdin',
      ]);
      while (rest.length > 0) {
        const option = rest[0]!;
        if (option === '--') {
          rest.shift();
          break;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(option)) {
          rest.shift();
          continue;
        }
        if (executionFlags.has(option) || /^--preserve-env=/.test(option)) {
          rest.shift();
          continue;
        }
        if (optionsWithValue.has(option)) {
          if (rest.length < 2) return false;
          rest.splice(0, 2);
          continue;
        }
        if (/^--(?:close-from|chdir|group|host|prompt|chroot|role|command-timeout|type|user|other-user)=/.test(option)
          || /^-[CDghpRrTtu].+/.test(option)) {
          rest.shift();
          continue;
        }
        // Help/version/list/validate modes do not execute the trailing word.
        if (['-V', '--version', '-h', '--help', '-l', '--list', '-v', '--validate'].includes(option)) {
          return false;
        }
        if (option.startsWith('-')) return false;
        break;
      }
      const nested = nestedInvocation(rest);
      return !!nested && wrappedExecutable(nested, wrapperDepth + 1);
    }
    return false;
  };
  const nestedLiteralShell = ({ name, args }: { name: string; args: string[] }): string | undefined => {
    const executable = name.split('/').at(-1);
    if (!['bash', 'dash', 'sh', 'zsh'].includes(executable ?? '') || args.length < 2) return undefined;
    const optionIndex = args.findIndex(arg => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
    return optionIndex >= 0 ? args[optionIndex + 1] : undefined;
  };
  const inspect = (value: unknown, depth = 0): boolean => {
    if (depth > 16 || !value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(item => inspect(item, depth));
    const node = value as Record<string, unknown>;
    if (node.type === 'Command') {
      const invocation = commandHead(node);
      if (invocation && wrappedExecutable(invocation)) return true;
      const nested = invocation && nestedLiteralShell(invocation);
      if (nested && containsLocalSshTransportInvocation(nested)) return true;
    }
    return Object.values(node).some(item => inspect(item, depth + 1));
  };
  return inspect(ast);
}

/** A remediation hint must not make a mutating or executable SQL payload look
 * one guard away from safe. This remains intentionally looser than the actual
 * admission grammar so a plain SELECT can receive the guard instructions. */
function isPlausiblyReadOnlyPostgresRepairQuery(query: string): boolean {
  if (!query || query.length > 16_384 || /[\u0000\u007f\\"$]/.test(query)
    || /--|\/\*|\*\//.test(query)) return false;
  const code = sqlCodeOutsideQuotes(query);
  if (!code || /[^\x09\x0a\x0d\x20-\x7e]/.test(code)) return false;
  const statements = code.split(';').map(statement => statement.trim()).filter(Boolean);
  if (statements.length < 1 || statements.length > 3) return false;
  const select = statements.at(-1)!;
  const guards = statements.slice(0, -1);
  if (!/^select\b/i.test(select)
    || [...select.matchAll(/\bselect\b/gi)].length !== 1
    || guards.some((guard, index) => index === 0
      ? !/^set\s+transaction\s+read\s+only$/i.test(guard)
      : !/^set\s+local\s+statement_timeout\s*=\s*[1-9]\d*$/i.test(guard))
    || /\b(?:alter|analyze|call|cluster|comment|copy|create|deallocate|delete|do|drop|except|execute|grant|insert|intersect|listen|lock|merge|notify|prepare|refresh|reindex|reset|revoke|truncate|union|unlisten|update|vacuum|with)\b/i.test(select)
    || /\binto\b|\bfor\s+(?:update|share|no\s+key\s+update|key\s+share)\b/i.test(select)
    || /::|:/.test(select)
    || /\b[A-Za-z_][A-Za-z0-9_$.]*\s*\(/.test(select)) return false;
  const operators = select.match(/[+\-*/<>=~!@#%^&|?]+/g) ?? [];
  if (operators.some(operator => !['=', '<', '>', '<=', '>=', '<>', '!='].includes(operator))) {
    return false;
  }
  return true;
}

/** This is a remediation classifier, never a permission grant. It is narrower
 * than the bundled read allow-list so a genuine mutation keeps the ordinary
 * exact-target refusal instead of receiving misleading “split the command”
 * advice. */
function isPlausiblyReadOnlyComposite(ast: { commands?: Array<Record<string, unknown>> }): boolean {
  let composite = (ast.commands?.length ?? 0) > 1;
  const staticLoopWord = (value: unknown): boolean => {
    const word = value as { type?: string; text?: string; expansion?: unknown[] };
    return word?.type === 'Word' && typeof word.text === 'string'
      && !word.expansion?.length && word.text.length <= 2_048
      && /^(?!-)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_@%+=:,./()\-]+$/.test(word.text);
  };
  const parameterOnlyDiagnostic = (
    node: Record<string, unknown>,
    loopParameters: ReadonlySet<string>,
  ): boolean => {
    const name = node.name as { type?: string; text?: string; expansion?: unknown[] } | undefined;
    if (node.async || !name || name.type !== 'Word' || name.expansion?.length
      || !['[', 'test', 'echo', 'ls', 'printf', 'sed', 'sha256sum'].includes(name.text ?? '')
      || Array.isArray(node.prefix) && node.prefix.length > 0) return false;
    const words: string[] = [];
    for (const item of Array.isArray(node.suffix) ? node.suffix : []) {
      const word = item as { type?: string; text?: string; expansion?: Array<Record<string, unknown>> };
      if (word.type !== 'Word' || typeof word.text !== 'string'
        || word.expansion?.some(expansion => expansion.type !== 'ParameterExpansion'
          || typeof expansion.parameter !== 'string'
          || !loopParameters.has(expansion.parameter))) return false;
      words.push(word.text);
    }
    if (name.text === '[') {
      return words.length === 3 && ['-d', '-e', '-f', '-r', '-s'].includes(words[0] ?? '')
        && words[2] === ']';
    }
    if (name.text === 'sed') {
      return words.length >= 3
        && ['-n', '--quiet', '--silent'].includes(words[0] ?? '')
        && /^[1-9]\d*(?:,[1-9]\d*)?p$/.test(words[1] ?? '')
        && words.slice(2).every(word => word.length <= 2_048
          && !/(?:^|\/)\.\.(?:\/|$)/.test(word));
    }
    if (name.text === 'printf') {
      return words.length >= 1 && words.length <= 16
        && words[0]!.length <= 1_024
        && !/%(?:[0-9]+\$)?[-+ #0']*(?:\*|[0-9]+)?(?:\.(?:\*|[0-9]+))?(?:hh|h|ll|l|j|z|t|L)?n/.test(words[0]!);
    }
    if (name.text === 'sha256sum') {
      return words.length === 1 && !words[0]!.startsWith('-');
    }
    return true;
  };
  const literalDiagnostic = (
    node: Record<string, unknown>,
    loopParameters: ReadonlySet<string>,
  ): boolean => {
    const invocation = literalCommand(node, true);
    if (!invocation) return parameterOnlyDiagnostic(node, loopParameters);
    const literal = serializeLiteralCommand(invocation);
    if (isProvablyReadOnlyShellCommand(literal)
      || isReadOnlyRegisteredShellObservation(literal)
      || isHardenableGitRead(invocation)
      || isRecoverablePlainGitStatus(invocation)) return true;
    if (invocation.name === 'true') return invocation.args.length === 0;
    if (invocation.name === 'set') {
      return invocation.args.length === 1 && /^-(?:e|u|eu|ue)$/.test(invocation.args[0] ?? '');
    }
    if (invocation.name === '[') {
      return invocation.args.length === 3
        && ['-d', '-e', '-f', '-r', '-s'].includes(invocation.args[0] ?? '')
        && invocation.args[2] === ']'
        && !/(?:^|\/)\.\.(?:\/|$)/.test(invocation.args[1] ?? '');
    }
    if (invocation.name === 'echo') return true;
    if (invocation.name === 'sort') return invocation.args.length === 0;
    if (invocation.name !== 'docker' || invocation.args[0] !== 'compose'
      || invocation.args[1] !== 'ps') return false;
    const rest = invocation.args.slice(2);
    while (rest.length) {
      const arg = rest.shift()!;
      if (['-a', '--all', '-q', '--quiet', '--services'].includes(arg)) continue;
      if (['--filter', '--format', '--status'].includes(arg) && rest.shift()) continue;
      if (/^--(?:filter|format|status)=.{1,2048}$/.test(arg)) continue;
      return false;
    }
    return true;
  };
  const visit = (value: unknown, loopParameters: ReadonlySet<string> = new Set()): boolean => {
    if (!value || typeof value !== 'object') return false;
    const node = value as Record<string, unknown>;
    switch (node.type) {
      case 'Script':
      case 'CompoundList':
        return Array.isArray(node.commands) && node.commands.length > 0
          && node.commands.every(command => visit(command, loopParameters));
      case 'Command':
        return literalDiagnostic(node, loopParameters);
      case 'LogicalExpression':
        composite = true;
        return ['and', 'or'].includes(String(node.op))
          && visit(node.left, loopParameters) && visit(node.right, loopParameters);
      case 'Pipeline':
        composite = true;
        return Array.isArray(node.commands) && node.commands.length > 0
          && node.commands.every(command => visit(command, loopParameters));
      case 'Subshell':
        composite = true;
        return visit(node.list, loopParameters);
      case 'If':
        composite = true;
        return visit(node.clause, loopParameters)
          && visit(node.then, loopParameters)
          && (node.else === undefined || visit(node.else, loopParameters));
      case 'For': {
        composite = true;
        const name = node.name as { type?: string; text?: string } | undefined;
        return name?.type === 'Name' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name.text ?? '')
          && Array.isArray(node.wordlist) && node.wordlist.length > 0
          && node.wordlist.length <= 64 && node.wordlist.every(staticLoopWord)
          && visit(node.do, new Set([...loopParameters, name.text!]));
      }
      default:
        return false;
    }
  };
  const readOnly = visit({ type: 'Script', commands: ast.commands });
  return composite && readOnly;
}

function isTrustedCurlExecutable(name: string): boolean {
  return name === 'curl' || name === '/usr/bin/curl';
}

/**
 * Complete closed grammar for a Bash invocation that may back an objective
 * acceptance criterion. Registration and final outcome validation must both
 * use this function: accepting a command at only one of those boundaries
 * creates an immutable criterion that can never complete.
 *
 * Inline interpreter/eval/stdin programs and output-only commands are
 * deliberately absent. A named validation script can be repaired in place
 * while retaining the immutable command/target identity.
 */
export function isObjectiveShellEvidenceCommand(command: string): boolean {
  if (!command || command.length > 32_000) return false;
  if (isObjectiveShellObservationCommand(command)
    || isRegisteredShellObservation(command)) return true;

  return hasLiteralSuccessMarker(command, invocation => {
    const literal = serializeLiteralCommand(invocation);
    return isProvablyReadOnlyShellCommand(literal)
      // Target-bound operational inspections must stay standalone. A shell
      // sequence would no longer be the exact registered invocation.
      || (isRegisteredShellObservation(literal) && !isBoundedRegisteredInspection(invocation))
      || validateBashCommand(literal, OBJECTIVE_TEST_SHELL_PATTERNS).allowed;
  });
}

/**
 * Generic shell check evidence that does not rely on a registered exact
 * target/result contract. Opaque named validators and HTTP reads intentionally
 * stay in isObjectiveShellEvidenceCommand's registered-only extension.
 */
export function isObjectiveShellObservationCommand(command: string): boolean {
  if (!command || command.length > 32_000) return false;
  if (isBoundedNodeTestCommand(command)) return true;
  let standalone: { commands?: Array<Record<string, unknown>> };
  try { standalone = bashParser(command) as typeof standalone; } catch { return false; }
  if (standalone.commands?.length === 1) {
    const outputOnly = literalCommand(standalone.commands[0], false);
    if (outputOnly?.name === 'printf') return false;
  }
  if (isProvablyReadOnlyShellCommand(command)
    || validateBashCommand(command, OBJECTIVE_TEST_SHELL_PATTERNS).allowed) return true;
  return hasLiteralSuccessMarker(command, invocation => {
    const literal = serializeLiteralCommand(invocation);
    return isProvablyReadOnlyShellCommand(literal)
      || validateBashCommand(literal, OBJECTIVE_TEST_SHELL_PATTERNS).allowed;
  });
}

/**
 * A standalone Node test file is valid test evidence, but it is intentionally
 * not classified as read-only: the JavaScript inside a test can still mutate
 * local state. Keeping this outside the generic shell patterns also prevents
 * redirects, compound commands and success-marker composition from widening
 * the admission.
 */
function isBoundedNodeTestCommand(command: string): boolean {
  let ast: { commands?: Array<Record<string, unknown>> };
  try { ast = bashParser(command) as typeof ast; } catch { return false; }
  if (ast.commands?.length !== 1) return false;
  const invocation = literalCommand(ast.commands[0], false);
  if (!invocation || !['node', '/usr/bin/node'].includes(invocation.name)
    || invocation.args.length !== 2 || invocation.args[0] !== '--test') return false;
  return isStaticNodeTestPath(invocation.args[1]);
}

function isStaticNodeTestPath(value: string | undefined): value is string {
  if (!value || value.length > 2_048 || value.startsWith('-')
    || !/^(?:\.?\/?)[A-Za-z0-9_@%+=,./-]+$/.test(value)
    || !/\.(?:cjs|mjs|js|cts|mts|ts)$/.test(value)) return false;
  const path = value.startsWith('./') ? value.slice(2) : value.startsWith('/') ? value.slice(1) : value;
  const segments = path.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return false;
  const filename = segments.at(-1)!;
  const stem = filename.slice(0, filename.lastIndexOf('.'));
  return segments.slice(0, -1).some(segment => /^(?:__tests__|tests?|specs?|verify|verification)$/i.test(segment))
    || /(?:^|[._-])(?:test|spec|verify|verification)(?:[._-]|$)/i.test(stem);
}

function hasLiteralSuccessMarker(
  command: string,
  admits: (invocation: { name: string; args: string[] }) => boolean,
): boolean {
  let ast: { commands?: Array<Record<string, unknown>> };
  try { ast = bashParser(command) as typeof ast; } catch { return false; }
  if (ast.commands?.length !== 1) return false;
  const sequence = literalAndSequence(ast.commands[0]);
  if (!sequence || sequence.length < 2) return false;
  const marker = sequence.at(-1)!;
  if (!isLiteralSuccessMarker(marker)) return false;
  return sequence.slice(0, -1).every(admits);
}

/** True only when a shell evidence command ends in a literal bounded marker
 * that can run solely after every preceding observation succeeds. */
export function hasBoundedObjectiveShellSuccessMarker(command: string): boolean {
  return hasLiteralSuccessMarker(command, invocation => {
    const literal = serializeLiteralCommand(invocation);
    return isProvablyReadOnlyShellCommand(literal)
      || (isRegisteredShellObservation(literal) && !isBoundedRegisteredInspection(invocation))
      || validateBashCommand(literal, OBJECTIVE_TEST_SHELL_PATTERNS).allowed;
  });
}

function literalAndSequence(value: unknown): Array<{ name: string; args: string[] }> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const node = value as Record<string, unknown>;
  if (node.type === 'Command') {
    const invocation = literalCommand(node, true);
    return invocation ? [invocation] : undefined;
  }
  if (node.type !== 'LogicalExpression' || node.op !== 'and' || node.async) return undefined;
  const left = literalAndSequence(node.left);
  const right = literalAndSequence(node.right);
  return left && right ? [...left, ...right] : undefined;
}

/** Exit zero is a useful synthetic success bit only when every HTTP read in
 * the command asks curl to fail on HTTP 4xx/5xx. Without -f/--fail, curl exits
 * zero after successfully transporting an error page. */
export function objectiveShellExitZeroProvesSuccess(command: string): boolean {
  let program: { commands?: unknown[] };
  try { program = bashParser(command) as typeof program; } catch { return false; }
  if (program.commands?.length !== 1) return false;
  const sequence = literalAndSequence(program.commands[0]);
  if (!sequence?.length) return false;
  return sequence.every(invocation => !isTrustedCurlExecutable(invocation.name)
    || invocation.args.some(arg => arg === '--fail' || /^-[sSfIL]*f[sSfIL]*$/.test(arg)));
}

function isLiteralSuccessMarker({ name, args }: { name: string; args: string[] }): boolean {
  return (name === 'printf' || name === 'echo')
    && args.length === 1
    && args[0]!.length > 0
    && args[0]!.length <= 1_024
    && !args[0]!.includes('%');
}

function serializeLiteralCommand({ name, args }: { name: string; args: string[] }): string {
  const quote = (value: string) => `'${value.replaceAll("'", `'\"'\"'`)}'`;
  return [quote(name), ...args.map(quote)].join(' ');
}

function literalCommand(value: unknown, allowDevNull: boolean): { name: string; args: string[] } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const node = value as Record<string, unknown>;
  if (node.type !== 'Command' || node.async || (Array.isArray(node.prefix) && node.prefix.length > 0)) return undefined;
  const literal = (value: unknown): string | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const word = value as { type?: string; text?: string; expansion?: unknown[] };
    return word.type === 'Word' && typeof word.text === 'string' && !word.expansion?.length
      ? word.text : undefined;
  };
  const name = literal(node.name);
  if (!name) return undefined;
  const args: string[] = [];
  for (const suffix of Array.isArray(node.suffix) ? node.suffix : []) {
    const arg = literal(suffix);
    if (arg !== undefined) { args.push(arg); continue; }
    const redirect = suffix as { type?: string; file?: unknown; op?: { text?: string } };
    // Discarding output does not create evidence; the caller still requires
    // the exact observed result. Real file redirects remain excluded.
    if (!allowDevNull || redirect.type !== 'Redirect' || literal(redirect.file) !== '/dev/null'
      || !/^(?:>|>>|>\|)$/.test(redirect.op?.text ?? '')) return undefined;
  }
  return { name, args };
}

/**
 * Operational reads that are safe evidence only because registration binds
 * their exact target and expected result. Keep them out of the generic
 * read-only allow-list and reject every unrecognized flag or implicit target.
 */
function isBoundedRegisteredInspection({ name, args }: { name: string; args: string[] }): boolean {
  const executable = name.split('/').at(-1) ?? name;
  if (!isTrustedOperationalExecutable(name, executable)) return false;
  if (executable === 'docker') return isBoundedDockerInspection(args);
  if (executable === 'systemctl') return isBoundedSystemctlInspection(args);
  if (executable === 'gh') return isBoundedGitHubPullRequestInspection(args);
  return false;
}

function isTrustedOperationalExecutable(name: string, executable: string): boolean {
  if (!['docker', 'systemctl', 'gh'].includes(executable)) return false;
  return name === executable || ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin']
    .some(prefix => name === `${prefix}/${executable}`);
}

function isBoundedDockerInspection(sourceArgs: string[]): boolean {
  const [operation, ...sourceRest] = sourceArgs;
  const rest = [...sourceRest];
  const literalTarget = (value: string | undefined): value is string => !!value
    && /^[A-Za-z0-9_/][A-Za-z0-9_.:@/+\-]{0,255}$/.test(value);
  const boundedValue = (value: string | undefined): value is string => !!value
    && value.length <= 2_048 && !/[\u0000-\u001f\u007f]/.test(value);

  if (operation === 'exec') return false;

  if (operation === 'inspect') {
    const targets: string[] = [];
    while (rest.length) {
      const arg = rest.shift()!;
      if (arg === '-s' || arg === '--size') continue;
      if (arg === '-f' || arg === '--format') {
        if (!boundedValue(rest.shift())) return false;
        continue;
      }
      if (arg.startsWith('--format=')) {
        if (!boundedValue(arg.slice('--format='.length))) return false;
        continue;
      }
      if (arg === '--type') {
        if (!/^(?:container|image|node|network|plugin|secret|service|task|volume)$/.test(rest.shift() ?? '')) return false;
        continue;
      }
      if (arg.startsWith('--type=')) {
        if (!/^(?:container|image|node|network|plugin|secret|service|task|volume)$/.test(arg.slice('--type='.length))) return false;
        continue;
      }
      if (!literalTarget(arg)) return false;
      targets.push(arg);
    }
    return targets.length > 0;
  }

  if (operation !== 'ps') return false;
  while (rest.length) {
    const arg = rest.shift()!;
    if (/^-[alqs]+$/.test(arg) || ['--all', '--latest', '--no-trunc', '--quiet', '--size'].includes(arg)) continue;
    if (arg === '-n' || arg === '--last') {
      if (!/^[1-9]\d{0,5}$/.test(rest.shift() ?? '')) return false;
      continue;
    }
    if (/^--last=[1-9]\d{0,5}$/.test(arg)) continue;
    if (arg === '-f' || arg === '--filter' || arg === '--format') {
      if (!boundedValue(rest.shift())) return false;
      continue;
    }
    if (/^--(?:filter|format)=/.test(arg)) {
      if (!boundedValue(arg.slice(arg.indexOf('=') + 1))) return false;
      continue;
    }
    return false;
  }
  return true;
}

// Official PostgreSQL images install the client under /usr/local/bin, while
// some distribution images use /usr/bin. Keep both exact absolute tuples and
// never fall back to PATH or a shell intermediary.
const POSTGRES_EXECUTABLES = new Set([
  '/usr/bin/psql',
  '/usr/local/bin/psql',
]);

function isBoundedPostgresInspectionArgs(
  sourceArgs: string[],
  scope: { user: string; database: string },
): boolean {
  const query = extractBoundedPostgresInspectionQuery(sourceArgs, scope);
  return query !== undefined && isBoundedReadOnlyPostgresQuery(query);
}

/** Parse the exact audited psql CLI envelope independently from the SQL
 * grammar. The repair classifier may relax only the query, never executable,
 * identity, duplicate flags, extra payloads or positional arguments. */
function extractBoundedPostgresInspectionQuery(
  sourceArgs: string[],
  scope: { user: string; database: string },
): string | undefined {
  const args = [...sourceArgs];
  const outputOptions = new Set<string>();
  let query: string | undefined;
  let noPsqlRc = false;
  let singleTransaction = false;
  let stopOnError = false;
  let user: string | undefined;
  let database: string | undefined;
  while (args.length) {
    const arg = args.shift()!;
    if (['-A', '-t', '-q', '-x'].includes(arg)) {
      if (outputOptions.has(arg)) return undefined;
      outputOptions.add(arg);
      continue;
    }
    if (arg === '-X') {
      if (noPsqlRc) return undefined;
      noPsqlRc = true;
      continue;
    }
    if (arg === '--single-transaction') {
      if (singleTransaction) return undefined;
      singleTransaction = true;
      continue;
    }
    if (arg === '-c' || arg === '--command') {
      if (query !== undefined || args.length !== 1) return undefined;
      query = args.shift();
      break;
    }
    if (arg.startsWith('--command=')) {
      if (query !== undefined || args.length !== 0) return undefined;
      query = arg.slice('--command='.length);
      break;
    }
    if (arg === '-U') {
      const value = args.shift();
      if (user !== undefined || !isLiteralPostgresIdentifier(value)) return undefined;
      user = value;
      continue;
    }
    if (arg === '-d') {
      const value = args.shift();
      if (database !== undefined || !isLiteralPostgresIdentifier(value)) return undefined;
      database = value;
      continue;
    }
    if (arg === '--set=ON_ERROR_STOP=1') {
      if (stopOnError) return undefined;
      stopOnError = true;
      continue;
    }
    return undefined;
  }
  if (!noPsqlRc || !singleTransaction || !stopOnError
    || user !== scope.user || database !== scope.database
    || query === undefined) return undefined;
  return query;
}

function isLiteralPostgresIdentifier(value: string | undefined): value is string {
  return !!value && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value);
}

function sqlCodeOutsideQuotes(sql: string): string | undefined {
  let code = '';
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!;
    if (char === '"') return undefined;
    if (char !== "'") {
      code += char;
      continue;
    }
    let previous = index - 1;
    while (previous >= 0 && /\s/.test(sql[previous]!)) previous -= 1;
    // PostgreSQL's `type 'literal'` syntax invokes the type input function
    // without parentheses. Only predicate/list literal positions are needed
    // by this inspection grammar; rejecting every other position closes that
    // hidden function-call form.
    if (previous < 0 || !/[=<>!(,]/.test(sql[previous]!)) return undefined;
    const quote = char;
    code += ' ';
    let closed = false;
    while (++index < sql.length) {
      if (sql[index] !== quote) continue;
      if (sql[index + 1] === quote) {
        index += 1;
        continue;
      }
      closed = true;
      break;
    }
    if (!closed) return undefined;
  }
  return code;
}

function isBoundedReadOnlyPostgresQuery(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed || trimmed.length > 16_384 || /[\u0000\u007f\\"$]/.test(trimmed)
    || /--|\/\*|\*\//.test(trimmed)) return false;
  const code = sqlCodeOutsideQuotes(trimmed);
  if (!code || /[^\x09\x0a\x0d\x20-\x7e]/.test(code)) return false;
  const statements = code.split(';').map(statement => statement.trim()).filter(Boolean);
  if (statements.length !== 3 || !/^set\s+transaction\s+read\s+only$/i.test(statements[0]!)) {
    return false;
  }
  const timeout = /^set\s+local\s+statement_timeout\s*=\s*([1-9]\d*)$/i.exec(statements[1]!);
  if (!timeout || Number(timeout[1]) > 60_000) return false;

  const select = statements[2]!;
  if (!/^select\b/i.test(select)
    || [...select.matchAll(/\bselect\b/gi)].length !== 1
    || /::|:|\b(?:alter|analyze|call|cluster|collate|comment|copy|create|deallocate|delete|do|drop|execute|grant|insert|intersect|listen|lock|merge|notify|offset|operator|prepare|refresh|reindex|reset|revoke|set|truncate|union|unlisten|update|vacuum|values|with)\b/i.test(select)
    || /\binto\b|\bfor\s+(?:update|share|no\s+key\s+update|key\s+share)\b/i.test(select)
    || /\b(?:from|join)\s*\(/i.test(select)) {
    return false;
  }

  // Any identifier immediately followed by an opening parenthesis is either a
  // function call or a syntax extension outside this deliberately small
  // grammar. Standalone parenthesized boolean expressions remain valid.
  if (/\b[A-Za-z_][A-Za-z0-9_$.]*\s*\(/.test(select)) return false;
  const operators = select.match(/[+\-*/<>=~!@#%^&|?]+/g) ?? [];
  if (operators.some(operator => !['=', '<', '>', '<=', '>=', '<>', '!='].includes(operator))) return false;

  const relationKeywords = [...select.matchAll(/\b(?:from|join)\b/gi)];
  const relations = [...select.matchAll(/\b(?:from|join)\s+([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\b/gi)];
  if (relations.length === 0 || relations.length !== relationKeywords.length) return false;

  // Comma joins hide additional relation targets from the FROM/JOIN checks.
  // A comma after the first FROM is therefore rejected, even inside an
  // expression; callers can express such predicates without widening this
  // security boundary.
  const firstFrom = select.search(/\bfrom\b/i);
  if (firstFrom < 0 || select.slice(firstFrom).includes(',')) return false;

  const limit = /\blimit\s+([1-9]\d*)$/i.exec(select);
  if (!limit || Number(limit[1]) > 1_000) return false;
  if ([...select.matchAll(/\blimit\b/gi)].length !== 1) return false;

  for (const relation of relations) {
    const [schema, table] = relation[1]!.split('.');
    if (!isLiteralPostgresIdentifier(schema) || !isLiteralPostgresIdentifier(table)) return false;
  }
  return isAuditedPnsPostgresSelect(select, relations.map(relation => relation[1]!.toLowerCase()));
}

function isAuditedPnsPostgresSelect(select: string, relations: string[]): boolean {
  if (relations.length !== 1) return false;
  const [relation] = relations;
  // These are PostgreSQL-owned catalog views whose definitions and scalar
  // types are part of the reviewed server contract. Arbitrary application
  // views remain rejected even when their name looks read-only.
  if (relation === 'information_schema.columns' || relation === 'information_schema.tables') {
    return true;
  }
  if (relation !== 'public.contracts') return false;

  // The only application-table read currently approved is a numeric primary
  // key existence check. Keeping its selected column, predicate and alias
  // identical prevents RLS/operator/type surprises from a model-authored
  // projection. Broaden only after auditing the concrete PNS schema.
  const normalized = select.replace(/\s+/g, ' ').trim();
  const match = /^select\s+([a-z_][a-z0-9_]*)\.(contract_id|id)\s+from\s+public\.contracts\s+(?:as\s+)?([a-z_][a-z0-9_]*)\s+where\s+([a-z_][a-z0-9_]*)\.(contract_id|id)\s*=\s*[1-9]\d{0,17}\s+limit\s+(?:[1-9]\d{0,2}|1000)$/i.exec(normalized);
  return !!match && match[1]?.toLowerCase() === match[3]?.toLowerCase()
    && match[3]?.toLowerCase() === match[4]?.toLowerCase()
    && match[2]?.toLowerCase() === match[5]?.toLowerCase();
}

function isBoundedSystemctlInspection(args: string[]): boolean {
  const [operation, ...sourceRest] = args;
  const rest = [...sourceRest];
  const literalUnit = (value: string | undefined): value is string => !!value
    && /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,255}$/.test(value);

  if (operation === 'is-active' || operation === 'is-enabled' || operation === 'is-failed') {
    if (rest[0] === '--quiet') rest.shift();
    return rest.length > 0 && rest.every(literalUnit);
  }

  if (operation !== 'show') return false;
  const units: string[] = [];
  while (rest.length) {
    const arg = rest.shift()!;
    if (arg === '--all' || arg === '--value' || arg === '--no-pager') continue;
    if (arg === '-p' || arg === '--property') {
      if (!/^[A-Za-z][A-Za-z0-9]*(?:,[A-Za-z][A-Za-z0-9]*)*$/.test(rest.shift() ?? '')) return false;
      continue;
    }
    if (arg.startsWith('--property=')) {
      if (!/^[A-Za-z][A-Za-z0-9]*(?:,[A-Za-z][A-Za-z0-9]*)*$/.test(arg.slice('--property='.length))) return false;
      continue;
    }
    if (!literalUnit(arg)) return false;
    units.push(arg);
  }
  return units.length > 0;
}

function isBoundedGitHubPullRequestInspection(args: string[]): boolean {
  if (args[0] !== 'pr' || args[1] !== 'view' || !/^[1-9]\d{0,9}$/.test(args[2] ?? '')) return false;
  const rest = args.slice(3);
  let repositorySeen = false;
  while (rest.length) {
    const arg = rest.shift()!;
    if (arg === '--web' || arg === '-w') return false;
    if (arg === '--repo') {
      if (repositorySeen || !isLiteralGitHubRepository(rest.shift())) return false;
      repositorySeen = true;
      continue;
    }
    if (arg.startsWith('--repo=')) {
      if (repositorySeen || !isLiteralGitHubRepository(arg.slice('--repo='.length))) return false;
      repositorySeen = true;
      continue;
    }
    if (arg === '--comments') continue;
    if (arg === '--json') {
      if (!/^[A-Za-z][A-Za-z0-9]*(?:,[A-Za-z][A-Za-z0-9]*)*$/.test(rest.shift() ?? '')) return false;
      continue;
    }
    if (arg.startsWith('--json=')) {
      if (!/^[A-Za-z][A-Za-z0-9]*(?:,[A-Za-z][A-Za-z0-9]*)*$/.test(arg.slice('--json='.length))) return false;
      continue;
    }
    if (arg === '--jq' || arg === '--template') {
      const value = rest.shift();
      if (!value || value.length > 4_096 || /[\u0000-\u001f\u007f]/.test(value)) return false;
      continue;
    }
    return false;
  }
  return repositorySeen;
}

function isLiteralGitHubRepository(value: string | undefined): value is string {
  return !!value && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/.test(value);
}

function isValidationScript({ name, args: sourceArgs }: { name: string; args: string[] }): boolean {
  const args = [...sourceArgs];
  const executable = name.split('/').at(-1) ?? name;
  let script: string | undefined;
  if (/^python(?:\d+(?:\.\d+)?)?$/.test(executable)) {
    while (['-u', '-B', '-I', '-E'].includes(args[0] ?? '')) args.shift();
    script = args.shift();
  } else if (executable === 'node' || executable === 'bun') {
    if (executable === 'bun' && args[0] === 'run') args.shift();
    script = args.shift();
  } else if (['sh', 'bash', '/bin/sh', '/bin/bash', '/usr/bin/sh', '/usr/bin/bash'].includes(name)) {
    // Preserve the one observed non-executable e-doc verifier contract without
    // promoting every attacker-named `/tmp/verify-*.sh` program to opaque
    // objective evidence. Shell flags, `-c`, relative lookup and arbitrary
    // validator locations remain excluded.
    script = args.shift();
    if (!script || !/^\/home\/youcom\/bin\/verify-edoc-[1-9]\d*\.sh$/u.test(script)
      || args.some(arg => arg !== '--json')
      || args.filter(arg => arg === '--json').length > 1) return false;
  } else if (name.includes('/')) {
    script = name;
  }
  if (!script || script.startsWith('-')) return false;
  const filename = script.split('/').at(-1) ?? script;
  return /(?:^|[-_.])(?:validate|validation|verify|verification|check|checks|test|tests)(?:[-_.]|$)/i.test(filename)
    && /\.(?:py|js|cjs|mjs|ts|sh)$/.test(filename)
    && !args.some(arg => /^--?(?:apply|create|delete|deploy|edit|fix|install|mutate|publish|remove|update|write)(?:[-_=]|$)/i.test(arg));
}

/**
 * The exact registered input already binds destination, identity and cwd.
 * Recognize only the observed noninteractive SSH shape, never a generic
 * remote shell, custom SSH config/commands, forwarding or extra operations.
 */
function isRemoteValidation(sourceArgs: string[]): boolean {
  const args = [...sourceArgs];
  const staticPath = (value: string | undefined): value is string => !!value
    && value.startsWith('/') && !/[\u0000-\u001f\u007f$`*?{}\[\]~]/.test(value);
  let identitySeen = false;
  let batchSeen = false;
  while (args[0]?.startsWith('-')) {
    const option = args.shift();
    if (option === '-i' && !identitySeen && staticPath(args[0])) {
      args.shift(); identitySeen = true;
    } else if (option === '-o' && !batchSeen && args[0] === 'BatchMode=yes') {
      args.shift(); batchSeen = true;
    } else return false;
  }
  if (args.length !== 2 || !/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(args[0]!)) return false;
  let remote: { commands?: Array<Record<string, unknown>> };
  try { remote = bashParser(args[1]!) as typeof remote; } catch { return false; }
  if (remote.commands?.length !== 1) return false;
  const sequence = remote.commands[0]!;
  if (sequence.type !== 'LogicalExpression' || sequence.op !== 'and' || sequence.async) return false;
  const cwd = literalCommand(sequence.left, false);
  const validator = literalCommand(sequence.right, false);
  return cwd?.name === 'cd' && cwd.args.length === 1 && staticPath(cwd.args[0])
    && !!validator && isValidationScript(validator);
}

function isSingleHttpRead(args: string[], allowFailWithBody = false): boolean {
  let url: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (/^-[sSfIL]+$/.test(arg)
      || ['--fail', '--silent', '--show-error', '--head', '--location'].includes(arg)
      || allowFailWithBody && arg === '--fail-with-body') continue;
    if (arg === '-X' || arg === '--request') {
      if (!/^(?:GET|HEAD)$/.test(args[++index] ?? '')) return false;
      continue;
    }
    if (arg === '--max-time' || arg === '--connect-timeout') {
      if (!/^\d+(?:\.\d+)?$/.test(args[++index] ?? '')) return false;
      continue;
    }
    if (arg === '-o' || arg === '--output') {
      if (args[++index] !== '/dev/null') return false;
      continue;
    }
    if (arg === '-o/dev/null' || arg === '--output=/dev/null') continue;
    const candidate = arg === '--url' ? args[++index] : arg;
    if (!candidate || candidate.startsWith('-') || url) return false;
    try {
      const parsed = new URL(candidate);
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return false;
    } catch { return false; }
    url = candidate;
  }
  return !!url;
}
