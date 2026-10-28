import { isUnknownArray } from '../../../utils/json.ts';
/// <reference path="../../bash-parser.d.ts" />
import bashParser from "bash-parser";
import { isHardenableGitRead, isReadOnlyRegisteredShellObservation, isUnsupportedGitObservationCandidate } from './git-observations.ts';
import { isValidationScript } from './operational-inspection.ts';
import { isPlausiblyReadOnlyComposite } from './read-policy.ts';
import { literalCommand } from './shell-vocabulary.ts';

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
    if (node["type"] !== 'Command') return undefined;
    const name = literalWord(node["name"]);
    if (!name) return undefined;
    const args: string[] = [];
    for (const item of isUnknownArray(node["suffix"]) ? node["suffix"] : []) {
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
    if (isUnknownArray(value)) return value.some((item: unknown) => inspect(item, depth));
    const node = value as Record<string, unknown>;
    if (node["type"] === 'Command') {
      const invocation = commandHead(node);
      if (invocation && wrappedExecutable(invocation)) return true;
      const nested = invocation && nestedLiteralShell(invocation);
      if (nested && containsLocalSshTransportInvocation(nested)) return true;
    }
    return Object.values(node).some((item: unknown) => inspect(item, depth + 1));
  };
  return inspect(ast);
}
