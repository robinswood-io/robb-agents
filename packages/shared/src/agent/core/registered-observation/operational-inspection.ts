/// <reference path="../../bash-parser.d.ts" />
import bashParser from "bash-parser";
import { isBoundedSystemctlInspection } from './database-inspection.ts';
import { isTrustedCurlExecutable, literalCommand } from './shell-vocabulary.ts';

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

/**
 * Operational reads that are safe evidence only because registration binds
 * their exact target and expected result. Keep them out of the generic
 * read-only allow-list and reject every unrecognized flag or implicit target.
 */
export function isBoundedRegisteredInspection({ name, args }: { name: string; args: string[] }): boolean {
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

export function isValidationScript({ name, args: sourceArgs }: { name: string; args: string[] }): boolean {
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
export function isRemoteValidation(sourceArgs: string[]): boolean {
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

export function isSingleHttpRead(args: string[], allowFailWithBody = false): boolean {
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
