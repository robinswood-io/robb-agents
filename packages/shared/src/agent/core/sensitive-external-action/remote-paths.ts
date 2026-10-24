import { posix } from "node:path";
import { uniqueTargets } from './action-targets.ts';
import { hasDynamicOrGlobTargetSyntax } from './host-authorization.ts';
import { unwrapCommand } from './shell-parser.ts';
import { basename } from './target-syntax.ts';

export function stringInput(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function rawRemotePathInput(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

export function normalizeStaticRemotePath(value: string, cwd?: string): string | undefined {
  // Every character is significant in a POSIX filename. Reject rather than
  // canonicalize leading/trailing whitespace or quote-like input supplied
  // outside the shell parser.
  if (value !== value.trim()) return undefined;
  if (/^['"]|['"]$/u.test(value)) return undefined;
  const trimmed = value;
  // Remote commands run under POSIX path semantics. A backslash preserved by
  // shell quoting is a literal filename character, never a `/` separator.
  if (trimmed.includes('\\')) return undefined;
  if (!trimmed || hasDynamicOrGlobTargetSyntax(trimmed)) return undefined;
  if (posix.isAbsolute(trimmed)) return posix.normalize(trimmed);
  if (!cwd || !posix.isAbsolute(cwd)) return undefined;
  return posix.resolve(cwd, trimmed);
}

export function humanizeRemoteIdentifier(identifier: string): string | undefined {
  const clean = identifier;
  if (!clean || clean === '.' || clean === '..') return undefined;
  if (!/^[A-Za-z0-9._@%+,=~-]+$/.test(clean)) return undefined;
  // Target identifiers participate in authorization. Preserve their literal
  // separators so `orion-agent`, `orion_agent`, and `orion.agent` cannot
  // collapse to the same authority token. Keep only the two historical exact
  // aliases whose objective spelling is intentionally different.
  if (/^pns-gen-worktrees?$/i.test(clean) || /^pnsgen$/i.test(clean)) return 'pns gen';
  if (/^devlogin$/i.test(clean)) return 'dev login';
  return clean;
}

export function remoteScopeFromPath(value: string, cwd?: string): string | undefined {
  const normalized = normalizeStaticRemotePath(value, cwd);
  if (!normalized) return undefined;
  const systemdUnit = /^\/etc\/systemd\/system\/([^/]+)\.service$/i.exec(normalized)?.[1];
  if (systemdUnit) return systemdUnit;
  const workspaceMatch = /^\/srv\/workspaces?\/([^/]+)(?:\/(.*))?$/i.exec(normalized);
  if (workspaceMatch?.[1] === '.worktrees') {
    const worktreeIdentifier = workspaceMatch[2]?.split('/')[0];
    return worktreeIdentifier && !worktreeIdentifier.startsWith('.')
      ? humanizeRemoteIdentifier(worktreeIdentifier)
      : undefined;
  }
  // Hidden workspace control directories are never project identities. Only
  // the conventional `.worktrees/<literal-project>` layout above may expose
  // its concrete child as an authorization target.
  if (workspaceMatch?.[1]?.startsWith('.')) return undefined;
  const managedDevProject = /^\/opt\/ia-webdev\/agent-dev\/(?:integration|worktrees)\/([a-z0-9][a-z0-9-]{0,63})(?:\/|$)/u.exec(normalized)?.[1];
  const identifier = workspaceMatch?.[1]
    ?? managedDevProject
    ?? /^\/srv\/(?:apps|services|sites|www)\/([^/]+)(?:\/|$)/i.exec(normalized)?.[1]
    ?? /^\/var\/www\/([^/]+)(?:\/|$)/i.exec(normalized)?.[1]
    ?? /^\/opt\/([^/]+)(?:\/|$)/i.exec(normalized)?.[1]
    ?? /^\/srv\/(?!workspaces?(?:\/|$)|apps(?:\/|$)|services(?:\/|$)|sites(?:\/|$)|www(?:\/|$))([^/]+)(?:\/|$)/i.exec(normalized)?.[1];
  return identifier ? humanizeRemoteIdentifier(identifier) : undefined;
}

export function pathReferences(value: string): string[] {
  const literalPath = /^(?:\/|\.{1,2}\/|[A-Za-z0-9._@%+,=~-]+\/)[A-Za-z0-9._@%+,=~-]+(?:\/[A-Za-z0-9._@%+,=~-]+)*$/;
  if (literalPath.test(value)) return [value];
  return uniqueTargets([...value.matchAll(
    /(?:^|[^A-Za-z0-9._@%+,-])((?:\.{1,2}\/|\/)[A-Za-z0-9._@%+,=~-]+(?:\/[A-Za-z0-9._@%+,=~-]+)*)/g,
  )].map(match => match[1]));
}

export function commandFromActionInput(input: Record<string, unknown>): string {
  return [input.command, input.cmd, input.script]
    .find((value): value is string => typeof value === 'string')?.trim() ?? '';
}

export function hasUnsupportedRemoteScopeNode(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasUnsupportedRemoteScopeNode);
  const node = value as Record<string, unknown>;
  if (node.async === true) return true;
  // The bounded remote grammar only reasons about top-level simple commands,
  // lists and logical expressions. Shell compound bodies can mutate the
  // caller's cwd/state while collectSimpleCommands sees only a later command
  // (for example `if ...; then cd ../sibling; fi; touch marker`). Keep every
  // compound/control-flow form fail-closed instead of partially traversing it.
  if ([
    'Case', 'CaseItem', 'CompoundList', 'For', 'Function', 'If', 'Pipeline',
    'Subshell', 'Until', 'While',
  ].includes(String(node.type ?? ''))) return true;
  return Object.values(node).some(hasUnsupportedRemoteScopeNode);
}

export function remoteCdTransitionsAreSafelyChained(ast: unknown): boolean {
  const containsCd = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(containsCd);
    const node = value as Record<string, unknown>;
    if (node.type === 'Command') {
      const name = (node.name as { text?: string } | undefined)?.text;
      const suffix = Array.isArray(node.suffix)
        ? node.suffix.map(item => (item as { text?: string }).text).filter((word): word is string => !!word)
        : [];
      if (name && basename(unwrapCommand([name, ...suffix])[0] ?? '') === 'cd') return true;
    }
    return Object.values(node).some(containsCd);
  };
  if (!containsCd(ast)) return true;
  if (!ast || typeof ast !== 'object' || Array.isArray(ast)) return false;
  const script = ast as { type?: string; commands?: unknown[] };
  if (script.type !== 'Script' || script.commands?.length !== 1) return false;

  const flattenAndChain = (value: unknown): Array<Record<string, unknown>> | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const node = value as Record<string, unknown>;
    if (node.type === 'Command') return [node];
    if (node.type !== 'LogicalExpression' || node.op !== 'and') return undefined;
    const left = flattenAndChain(node.left);
    const right = flattenAndChain(node.right);
    return left && right ? [...left, ...right] : undefined;
  };
  const chain = flattenAndChain(script.commands[0]);
  if (!chain || chain.length < 2) return false;
  return chain.every((node, index) => {
    const name = (node.name as { text?: string } | undefined)?.text;
    const suffix = Array.isArray(node.suffix)
      ? node.suffix.map(item => (item as { text?: string }).text).filter((word): word is string => !!word)
      : [];
    const command = name ? unwrapCommand([name, ...suffix]) : [];
    return basename(command[0] ?? '') !== 'cd' || index < chain.length - 1;
  });
}

export function hasDynamicShellExpansion(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasDynamicShellExpansion);
  const node = value as Record<string, unknown>;
  if (Array.isArray(node.expansion) && node.expansion.length > 0) return true;
  return Object.values(node).some(hasDynamicShellExpansion);
}

export function hasUnsafeRemoteInvocationMetadata(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasUnsafeRemoteInvocationMetadata);
  const node = value as Record<string, unknown>;
  if (node.type === 'Command') {
    // Shell assignments and `env` can transparently retarget Git, Docker,
    // interpreters and other project commands. The narrow remote recovery
    // cannot prove their scope, so never discard them while unwrapping.
    if (Array.isArray(node.prefix) && node.prefix.length > 0) return true;
    const name = node.name as { text?: string } | undefined;
    const executable = basename(name?.text ?? '');
    const suffix = Array.isArray(node.suffix)
      ? node.suffix.map(item => (item as { text?: string }).text).filter((item): item is string => !!item)
      : [];
    if (executable === 'env') return true;
    if (executable === 'time' && suffix[0]?.startsWith('-')) {
      return true;
    }
    if (executable === 'sudo' && suffix[0]?.startsWith('-')) {
      return true;
    }
  }
  return Object.values(node).some(hasUnsafeRemoteInvocationMetadata);
}

export const PROJECT_SCOPED_REMOTE_EXECUTABLES = new Set([
  // File mutations cannot safely inherit a lexical cwd scope: any component
  // may be a symlink to another project, and a realpath preflight would be
  // TOCTOU. Keep only clients with dedicated destination classifiers here.
  'service', 'systemctl',
]);

export const REMOTE_FILE_MUTATOR_EXECUTABLES = new Set([
  'chmod', 'chown', 'cp', 'install', 'ln', 'mkdir', 'mv', 'rm', 'rmdir',
  'touch', 'truncate', 'unlink',
]);

export const REMOTE_FILESYSTEM_MUTATION_EXECUTABLES = new Set([
  ...REMOTE_FILE_MUTATOR_EXECUTABLES,
  'printf', 'sed',
]);

export function hasUnsafeRemoteWrapperChain(words: string[]): boolean {
  let current = [...words];
  for (let pass = 0; pass < 8 && current.length > 0; pass += 1) {
    const rawExecutable = current[0]!;
    if (rawExecutable.includes('/') || rawExecutable.includes('\\')) return true;
    const executable = basename(rawExecutable);
    if (executable === 'env' || executable === 'nohup') return true;
    if (executable === 'command' || executable === 'sudo'
      || executable === 'nice' || executable === 'time') {
      if (!current[1] || current[1]!.startsWith('-')) return true;
      current = current.slice(1);
      continue;
    }
    if (executable === 'timeout') {
      const duration = current[1];
      if (!duration || duration.startsWith('-')
        || !/^\d+(?:\.\d+)?(?:[smhd])?$/.test(duration)
        || !current[2]) return true;
      current = current.slice(2);
      continue;
    }
    return false;
  }
  return true;
}

export const STATIC_REMOTE_FILE_OPERAND_PATTERN = /^(?:(?:\.{1,2}\/|\/)?[A-Za-z0-9._@%+,=~-]+(?:\/[A-Za-z0-9._@%+,=~-]+)*)$/;

export const PACKAGE_MANAGER_EXECUTABLES = new Set(['bun', 'npm', 'npx', 'pnpm', 'yarn']);

export const LOCAL_PACKAGE_SCRIPT = /^(?:build|check|dev|electron(?::|-)|format|generate|lint|test|typecheck|validate|verify)(?:$|[:-])/i;

export const BOUNDED_DEPLOYMENT_SCRIPT = /^deploy(?::[a-z0-9_-]+)?$/i;

export const EXTERNAL_PACKAGE_OPERATIONS = new Set([
  'access', 'deprecate', 'dist-tag', 'dlx', 'exec', 'login', 'logout', 'owner',
  'publish', 'unpublish', 'x',
]);

export const PACKAGE_MANAGER_OPTIONS_WITH_VALUES = new Set([
  '--cache', '--config', '--cwd', '--dir', '--filter', '--global-dir', '--globalconfig',
  '--loglevel', '--prefix', '--registry', '--store-dir', '--userconfig', '--workspace',
  '-C', '-F', '-w',
]);
