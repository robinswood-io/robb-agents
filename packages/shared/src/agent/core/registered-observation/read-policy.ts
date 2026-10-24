/// <reference path="../../bash-parser.d.ts" />
import bashParser from "bash-parser";
import { sqlCodeOutsideQuotes } from './database-inspection.ts';
import { isHardenableGitRead, isProvablyReadOnlyShellCommand, isReadOnlyRegisteredShellObservation, isRecoverablePlainGitStatus } from './git-observations.ts';
import { literalCommand } from './shell-vocabulary.ts';
import { serializeLiteralCommand } from './success-markers.ts';

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
export function isPlausiblyReadOnlyComposite(ast: { commands?: Array<Record<string, unknown>> }): boolean {
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
