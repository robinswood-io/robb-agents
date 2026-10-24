/// <reference path="../../bash-parser.d.ts" />
import bashParser from "bash-parser";
import { basename } from './target-syntax.ts';
import type { AstNode } from './types.ts';

function collectSimpleCommands(node: AstNode | undefined, result: string[][]): void {
  if (!node) return;
  if (node.type === 'Command') {
    const words: string[] = [];
    if (node.name?.text) words.push(node.name.text);
    for (const suffix of node.suffix ?? []) {
      if (suffix.type === 'Word' && typeof suffix.text === 'string') words.push(suffix.text);
      if (suffix.type === 'Redirect' && typeof suffix.file?.text === 'string') {
        words.push(suffix.op?.text ?? '>');
        words.push(suffix.file.text);
      }
    }
    if (words.length > 0) result.push(words);
    for (const suffix of node.suffix ?? []) {
      for (const expansion of suffix.expansion ?? []) {
        if (expansion && typeof expansion === 'object') {
          collectSimpleCommands((expansion as { commandAST?: AstNode }).commandAST, result);
        }
      }
    }
    return;
  }
  if (node.left) collectSimpleCommands(node.left, result);
  if (node.right) collectSimpleCommands(node.right, result);
  if (node.list) collectSimpleCommands(node.list, result);
  for (const command of node.commands ?? []) collectSimpleCommands(command, result);
}

export function parseSimpleCommands(command: string): string[][] {
  try {
    const ast = bashParser(command) as AstNode;
    const commands: string[][] = [];
    collectSimpleCommands(ast, commands);
    return commands;
  } catch {
    return [];
  }
}

export function unwrapCommand(words: string[]): string[] {
  let current = [...words];
  for (let pass = 0; pass < 8 && current.length > 0; pass++) {
    const command = basename(current[0]!);
    if (command === 'env') {
      let index = 1;
      while (index < current.length && (current[index]!.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(current[index]!))) index += 1;
      current = current.slice(index);
      continue;
    }
    if (command === 'sudo') {
      let index = 1;
      while (index < current.length && current[index]!.startsWith('-')) {
        const option = current[index]!;
        index += 1;
        if (['-u', '--user', '-g', '--group', '-h', '--host'].includes(option) && index < current.length) index += 1;
      }
      current = current.slice(index);
      continue;
    }
    if (command === 'command' || command === 'nohup') {
      current = current.slice(1);
      continue;
    }
    if (command === 'timeout') {
      let index = 1;
      while (index < current.length && current[index]!.startsWith('-')) {
        const option = current[index]!;
        index += 1;
        if (['-k', '--kill-after', '-s', '--signal'].includes(option)) index += 1;
      }
      // The first positional is the bounded duration; the next is the real command.
      if (index < current.length) index += 1;
      current = current.slice(index);
      continue;
    }
    if (command === 'nice') {
      let index = 1;
      while (index < current.length && current[index]!.startsWith('-')) {
        const option = current[index]!;
        index += 1;
        if (option === '-n' || option === '--adjustment') index += 1;
      }
      current = current.slice(index);
      continue;
    }
    if (command === 'time') {
      let index = 1;
      while (index < current.length && current[index]!.startsWith('-')) {
        const option = current[index]!;
        index += 1;
        if (['-f', '--format', '-o', '--output'].includes(option)) index += 1;
      }
      current = current.slice(index);
      continue;
    }
    break;
  }
  return current;
}

export function optionValue(words: string[], names: string[]): string | undefined {
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    const equalsName = names.find(name => word.startsWith(`${name}=`));
    if (equalsName) return word.slice(equalsName.length + 1);
    if (names.includes(word) && typeof words[index + 1] === 'string') return words[index + 1];
  }
  return undefined;
}

export function firstCliActionIndex(
  words: string[],
  start: number,
  optionsWithValues: ReadonlySet<string> = new Set(),
): number {
  for (let index = start; index < words.length; index += 1) {
    const word = words[index]!;
    if (optionsWithValues.has(word)) {
      index += 1;
      continue;
    }
    if (word.startsWith('-')) continue;
    return index;
  }
  return -1;
}

export const BOUNDED_IMPLEMENTATION_READ_EXECUTABLES = new Set([
  ':', '[', 'basename', 'cat', 'cut', 'date', 'df', 'dirname', 'du', 'echo',
  'file', 'find', 'grep', 'head', 'jq', 'ls', 'printf', 'pwd', 'readlink', 'realpath',
  'rg', 'sort', 'stat', 'tail', 'test', 'tr', 'true', 'false', 'uniq', 'wc',
]);

export const BOUNDED_IMPLEMENTATION_GIT_ACTIONS = new Set([
  'add', 'branch', 'commit', 'diff', 'fetch', 'log', 'ls-files',
  'ls-tree', 'push', 'remote', 'rev-parse', 'show', 'status',
]);

export const BOUNDED_IMPLEMENTATION_COMPOSE_ACTIONS = new Set([
  'build', 'logs', 'ps', 'pull', 'restart', 'up',
]);
