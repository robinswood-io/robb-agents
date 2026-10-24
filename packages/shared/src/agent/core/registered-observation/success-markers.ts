/// <reference path="../../bash-parser.d.ts" />
import bashParser from "bash-parser";
import { isTrustedCurlExecutable, literalCommand } from './shell-vocabulary.ts';

/**
 * A standalone Node test file is valid test evidence, but it is intentionally
 * not classified as read-only: the JavaScript inside a test can still mutate
 * local state. Keeping this outside the generic shell patterns also prevents
 * redirects, compound commands and success-marker composition from widening
 * the admission.
 */
export function isBoundedNodeTestCommand(command: string): boolean {
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

export function hasLiteralSuccessMarker(
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

export function serializeLiteralCommand({ name, args }: { name: string; args: string[] }): string {
  const quote = (value: string) => `'${value.replaceAll("'", `'\"'\"'`)}'`;
  return [quote(name), ...args.map(quote)].join(' ');
}
