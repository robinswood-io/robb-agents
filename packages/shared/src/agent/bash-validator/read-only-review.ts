/// <reference path="../bash-parser.d.ts" />
/**
 * Bash Command Validator
 *
 * Uses bash-parser to create a proper AST and validate commands in Explore mode.
 * This enables compound commands like `git status && git log` to be allowed
 * when all parts are safe, while still blocking dangerous constructs.
 *
 * AST Node Types:
 * - Command: Simple command with name and args
 * - LogicalExpression: && (and) or || (or) chains
 * - Pipeline: Piped commands (|)
 * - Subshell: Commands in parentheses (...)
 * - Redirect: File redirections (>, >>, <)
 * - CommandExpansion: $(...) substitution
 */
import bashParser from "bash-parser";
import { posix } from "node:path";
import type { ASTNode, CommandNode, LogicalExpressionNode, ScriptNode, WordNode } from './ast-types.ts';
import { STATIC_INTEGRITY_PATH_PATTERN } from './awk-policy.ts';

/** Canonical prefix that disables the repository-configured helpers reachable
 * by the small operation grammar below. Content/worktree operations that can
 * still invoke attributes or filters are excluded even with this prefix. */
export const READ_ONLY_GIT_HARDENING_ARGS = [
  '--no-optional-locks', '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'log.showSignature=false',
  '-c', 'format.pretty=medium',
  '--no-pager',
] as const;

/** Closed Git observation grammar shared by objective chronology and delegated
 * review validation. `rawArgs` excludes the executable name. Global options
 * must be the exact hardening prefix; an optional static `-C` follows it. */
export function isAllowlistedReadOnlyGitArguments(rawArgs: readonly string[]): boolean {
  const args = [...rawArgs];
  if (!READ_ONLY_GIT_HARDENING_ARGS.every((value, index) => args[index] === value)) return false;
  args.splice(0, READ_ONLY_GIT_HARDENING_ARGS.length);
  if (args[0] === '-C') {
    const path = args[1];
    if (!path || path.startsWith('-') || /(?:^|\/)\.\.(?:\/|$)/.test(path)
      || /[$`*?\[\]{}]/.test(path)) return false;
    args.splice(0, 2);
  }
  const operation = args.shift();
  if (!operation) return false;
  if (operation === 'branch') return args.length === 1 && args[0] === '--show-current';
  if (operation === 'rev-parse') {
    const form = JSON.stringify(args);
    return form === '["HEAD"]' || form === '["--verify","HEAD"]'
      || form === '["--abbrev-ref","HEAD"]' || form === '["--show-toplevel"]'
      || form === '["--is-inside-work-tree"]';
  }

  const noValue = new Set<string>();
  const valueOptions = new Set<string>();
  const safeAttached: RegExp[] = [];
  if (operation === 'grep') {
    for (const option of [
      '--line-number', '--extended-regexp', '--fixed-strings', '--basic-regexp',
      '--perl-regexp', '--ignore-case', '--invert-match', '--word-regexp',
      '--count', '--files-with-matches', '--files-without-match', '--full-name',
      '--heading', '--break', '--no-color', '--no-textconv',
    ]) noValue.add(option);
    for (const option of ['-e', '--regexp', '-A', '-B', '-C', '-m', '--max-count']) {
      valueOptions.add(option);
    }
    safeAttached.push(/^-[chilnsvwEFGIPW]+$/, /^--regexp=.+$/, /^--max-count=[0-9]+$/, /^--color=(?:always|auto|never)$/);
  } else if (operation === 'log') {
    for (const option of [
      '--oneline', '--decorate', '--no-decorate', '--no-patch', '--reverse',
      '--first-parent',
    ]) noValue.add(option);
    for (const option of ['-n', '--max-count']) valueOptions.add(option);
    // Custom pretty/format strings can request signature placeholders (`%G*`),
    // which may execute a configured GPG helper. `--oneline` is the only
    // formatting shorthand admitted by this closed grammar.
    safeAttached.push(/^-(?:n)?[0-9]+$/, /^--(?:max-count|since|until|author|grep)=.+$/);
  } else if (operation === 'ls-files') {
    for (const option of [
      '--cached', '--deleted', '--modified', '--others', '--ignored', '--stage',
      '--unmerged', '--killed', '--directory', '--empty-directory', '--error-unmatch',
      '--full-name', '-c', '-d', '-m', '-o', '-i', '-s', '-u', '-k', '-t', '-v',
    ]) noValue.add(option);
  } else if (operation === 'merge-base') {
    for (const option of ['--all', '--octopus', '--independent', '--is-ancestor', '--fork-point']) {
      noValue.add(option);
    }
  } else {
    return false;
  }

  const optionBoundary = args.indexOf('--');
  let positional = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--') {
      positional = true;
      continue;
    }
    if (positional || !argument.startsWith('-')) continue;
    if (noValue.has(argument) || safeAttached.some(pattern => pattern.test(argument))) continue;
    if (valueOptions.has(argument) && index + 1 < args.length) {
      index += 1;
      continue;
    }
    return false;
  }
  return true;
}

/** Closed observation grammar for review evidence, not a tool permission grant. */
export function inspectReadOnlyReviewCommand(command: string, target: string, initialCwd?: string): {
  safe: boolean; observesTarget: boolean; revisionProbe: boolean;
} {
  const no = { safe: false, observesTarget: false, revisionProbe: false };
  if (command.length > 32_000 || !target.startsWith('/')) return no;
  const targetPath = posix.normalize(target);
  let cwd = initialCwd?.startsWith('/') ? posix.normalize(initialCwd) : undefined;
  let observed = false; let hasHead = false; let onlyHeadProbes = true;
  const underTarget = (path: string) => targetPath === '/'
    ? path.startsWith('/') && path !== '/'
    : path === targetPath || path.startsWith(`${targetPath}/`);
  const absolute = (path: string) => path.startsWith('/') ? posix.normalize(path) : cwd ? posix.resolve(cwd, path) : undefined;
  let ast: ScriptNode;
  try { ast = bashParser(command) as ScriptNode; } catch { return no; }
  const visit = (node: ASTNode): boolean => {
    if (node.type === 'Script') return (node as ScriptNode).commands.every(visit);
    if (node.type === 'LogicalExpression') {
      const logical = node as LogicalExpressionNode;
      return logical.op === 'and' && visit(logical.left) && visit(logical.right);
    }
    // Pipelines, subshells, expansions, loops and redirects can change either
    // the target or the provenance of stdout. Refuse rather than infer intent.
    if (node.type !== 'Command') return false;
    const call = node as CommandNode;
    if (call.async || call.prefix?.length || !call.name || call.name.expansion?.length
      || call.suffix?.some(item => item.type !== 'Word' || (item as WordNode).expansion?.length)) return false;
    const name = call.name.text;
    const args = (call.suffix ?? []).map(item => (item as WordNode).text);
    if (name === 'cd') {
      if (args.length !== 1 || args[0]!.startsWith('-')) return false;
      cwd = absolute(args[0]!);
      return !!cwd;
    }
    if (name === 'git') {
      let gitCwd = cwd;
      if (!isAllowlistedReadOnlyGitArguments(args)) return false;
      const scopedArgs = args.slice(READ_ONLY_GIT_HARDENING_ARGS.length);
      if (scopedArgs[0] === '-C') {
        gitCwd = absolute(scopedArgs[1]!);
        scopedArgs.splice(0, 2);
      }
      const operation = scopedArgs.shift();
      const head = operation === 'rev-parse' && (JSON.stringify(scopedArgs) === '["HEAD"]' || JSON.stringify(scopedArgs) === '["--verify","HEAD"]');
      const branch = (operation === 'rev-parse' && JSON.stringify(scopedArgs) === '["--abbrev-ref","HEAD"]')
        || (operation === 'branch' && JSON.stringify(scopedArgs) === '["--show-current"]');
      const bound = targetPath === '/'
        ? !!gitCwd && gitCwd.startsWith('/') && gitCwd !== '/'
        : gitCwd === targetPath;
      if (!bound) return false;
      const pathBoundary = scopedArgs.indexOf('--');
      if (pathBoundary >= 0) {
        const pathspecs = scopedArgs.slice(pathBoundary + 1);
        if (pathspecs.length === 0 || pathspecs.some(pathspec => (
          !STATIC_INTEGRITY_PATH_PATTERN.test(pathspec)
          || !underTarget(pathspec.startsWith('/')
            ? posix.normalize(pathspec)
            : posix.resolve(gitCwd!, pathspec))
        ))) return false;
      }
      if (operation === 'ls-files' && pathBoundary < 0) {
        const pathspecs = scopedArgs.filter(argument => !argument.startsWith('-'));
        if (pathspecs.some(pathspec => !underTarget(posix.resolve(gitCwd!, pathspec)))) return false;
      }
      observed = true;
      hasHead ||= head;
      onlyHeadProbes &&= head || branch;
      return true;
    }
    const staticPath = (value: string): boolean => value.length <= 2_048
      && STATIC_INTEGRITY_PATH_PATTERN.test(value);
    if (name === 'cmp') {
      // Keep comparison evidence non-interactive and target-bound. Other cmp
      // modes are read-only too, but are unnecessary for the reviewer recipe.
      if (args.length !== 3 || args[0] !== '-s' || !args.slice(1).every(staticPath)) return false;
      const paths = args.slice(1).map(absolute).filter((path): path is string => !!path);
      if (paths.length !== 2 || !paths.every(underTarget)) return false;
      observed = true;
      onlyHeadProbes = false;
      return true;
    }
    if (name === 'shasum') {
      // Only SHA-256 calculation mode over one literal target path. Shell
      // expansions, redirects and compound mutations are rejected above/by AST.
      const pathArg = args.length === 3 && args[0] === '-a' && args[1] === '256'
        ? args[2]
        : undefined;
      const path = pathArg && staticPath(pathArg) ? absolute(pathArg) : undefined;
      if (!path || !underTarget(path)) return false;
      observed = true;
      onlyHeadProbes = false;
      return true;
    }
    if (name === 'sed') {
      if (args.length < 3 || !['-n', '--quiet', '--silent'].includes(args[0]!)
        || !/^[1-9]\d*(?:,[1-9]\d*)?p$/.test(args[1]!)
        || !args.slice(2).every(staticPath)) return false;
      const paths = args.slice(2).map(absolute).filter((path): path is string => !!path);
      if (paths.length !== args.length - 2 || !paths.every(underTarget)) return false;
      observed = true;
      onlyHeadProbes = false;
      return true;
    }
    if (['cat', 'head', 'tail', 'ls', 'stat', 'wc', 'diff'].includes(name)) {
      // Closed per-tool option grammar. Unknown/abbreviated options are not
      // ignored: several GNU readers accept option-embedded file paths or
      // follow modes that would escape a target-bound review.
      const noValueOptions: Record<string, Set<string>> = {
        cat: new Set(['--show-all', '--number-nonblank', '--show-ends', '--number', '--squeeze-blank', '--show-tabs', '--show-nonprinting']),
        head: new Set(['-q', '--quiet', '--silent', '-v', '--verbose', '-z', '--zero-terminated']),
        tail: new Set(['-q', '--quiet', '--silent', '-v', '--verbose', '-z', '--zero-terminated']),
        ls: new Set(['--all', '--almost-all', '--directory', '--human-readable', '--inode', '--numeric-uid-gid', '--reverse', '--size']),
        stat: new Set(),
        wc: new Set(['-c', '--bytes', '-m', '--chars', '-l', '--lines', '-L', '--max-line-length', '-w', '--words']),
        diff: new Set(['-q', '--brief', '-s', '--report-identical-files', '-u', '-c', '--minimal', '-a', '--text', '-w', '--ignore-all-space', '-b', '--ignore-space-change', '-B', '--ignore-blank-lines', '-i', '--ignore-case', '--strip-trailing-cr', '--speed-large-files']),
      };
      const shortClusters: Partial<Record<string, RegExp>> = {
        cat: /^-[AbEeEnstTuv]+$/,
        ls: /^-[1AadhilnpqrstuU]+$/,
        wc: /^-[cmlLw]+$/,
      };
      const numericValueOptions: Partial<Record<string, Set<string>>> = {
        head: new Set(['-c', '--bytes', '-n', '--lines']),
        tail: new Set(['-c', '--bytes', '-n', '--lines']),
        diff: new Set(['-U', '-C']),
      };
      const numericAttached: Partial<Record<string, RegExp>> = {
        head: /^(?:-[0-9]+|-[cn][+-]?[0-9]+|--(?:bytes|lines)=[+-]?[0-9]+)$/,
        tail: /^(?:-[cn][+-]?[0-9]+|--(?:bytes|lines)=[+-]?[0-9]+)$/,
        diff: /^(?:-[UC][0-9]+|--(?:unified|context)=[0-9]+)$/,
      };
      const operands: string[] = [];
      let positional = false;
      for (let index = 0; index < args.length; index += 1) {
        const argument = args[index]!;
        if (!positional && argument === '--') {
          positional = true;
          continue;
        }
        if (!positional && argument.startsWith('-')) {
          if (noValueOptions[name]!.has(argument)
            || shortClusters[name]?.test(argument)
            || numericAttached[name]?.test(argument)) continue;
          if (numericValueOptions[name]?.has(argument)) {
            const value = args[index + 1];
            if (!value || !/^[+-]?[0-9]+$/.test(value)) return false;
            index += 1;
            continue;
          }
          if (name === 'ls' && /^--color=(?:always|auto|never)$/.test(argument)) continue;
          return false;
        }
        operands.push(argument);
      }
      if (name === 'diff' ? operands.length !== 2 : operands.length < 1) return false;
      if (operands.some(operand => !STATIC_INTEGRITY_PATH_PATTERN.test(operand))) return false;
      const paths = operands.map(absolute).filter((path): path is string => !!path);
      if (paths.length !== operands.length) return false;
      if (!paths.every(underTarget)) return false;
      observed = true;
      onlyHeadProbes = false;
      return true;
    }
    return false;
  };
  if (!visit(ast)) return no;
  return { safe: true, observesTarget: observed, revisionProbe: hasHead && onlyHeadProbes };
}

/** Evidence classifier: a comparison in quoted Python/JS is not a shell redirect. */
export function hasShellOutputRedirection(command: string): boolean {
  // bash-parser 0.5 misparses heredoc bodies as shell commands. Such a parse
  // cannot establish execution evidence; inspect only the shell header, never
  // Python comparisons in the body. A real redirect on the header still counts.
  // This is evidence classification, not a permission/security authorization.
  if (command.includes('<<')) command = command.split('\n')[0] ?? '';
  let ast: unknown;
  try { ast = bashParser(command); } catch { return false; }
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    const node = value as Record<string, unknown>;
    if (node.type === 'Redirect') {
      const op = node.op as { text?: string } | undefined;
      const file = node.file as { type?: string; text?: string; expansion?: unknown[] } | undefined;
      const discardsOutput = file?.type === 'Word' && file.text === '/dev/null'
        && !file.expansion?.length;
      return !discardsOutput && typeof op?.text === 'string' && /^(?:>|>>|>\||&>|&>>)$/.test(op.text);
    }
    return Object.values(node).some(visit);
  };
  return visit(ast);
}
