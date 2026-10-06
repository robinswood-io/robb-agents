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

/// <reference path="./bash-parser.d.ts" />
import bashParser from 'bash-parser';
import { debug } from '../utils/debug.ts';
import type { CompiledBashPattern } from './mode-types.ts';
import { posix } from 'node:path';

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
  const underTarget = (path: string) => path === targetPath || path.startsWith(`${targetPath}/`);
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
      const bound = gitCwd === targetPath;
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

// ============================================================
// Types
// ============================================================

/**
 * Result of validating a bash command AST.
 * Tracks which subcommands passed/failed for detailed error messages.
 */
export interface BashValidationResult {
  allowed: boolean;
  /** Primary reason for rejection (if not allowed) */
  reason?: BashValidationReason;
  /** Individual results for compound commands */
  subcommandResults?: SubcommandResult[];
}

export interface SubcommandResult {
  /** The command text that was validated */
  command: string;
  allowed: boolean;
  reason?: string;
}

/**
 * Detailed reason why validation failed.
 * Used to generate helpful error messages.
 */
export type BashValidationReason =
  | { type: 'pipeline'; explanation: string }
  | { type: 'redirect'; op: string; explanation: string }
  | { type: 'command_expansion'; explanation: string }
  | { type: 'process_substitution'; explanation: string }
  | { type: 'parameter_expansion'; explanation: string }
  | { type: 'env_assignment'; explanation: string }
  | { type: 'unsafe_command'; command: string; explanation: string }
  | { type: 'parse_error'; error: string }
  | { type: 'compound_partial_fail'; failedCommands: string[]; passedCommands: string[] }
  | { type: 'background_execution'; explanation: string };

// ============================================================
// AST Node Types (from bash-parser)
// ============================================================

interface ASTNode {
  type: string;
}

interface WordNode extends ASTNode {
  type: 'Word';
  text: string;
  expansion?: ExpansionNode[];
}

interface CommandNode extends ASTNode {
  type: 'Command';
  name?: WordNode;
  prefix?: ASTNode[];
  suffix?: ASTNode[];
  /** True if command runs in background with & operator */
  async?: boolean;
}

interface LogicalExpressionNode extends ASTNode {
  type: 'LogicalExpression';
  op: 'and' | 'or';
  left: ASTNode;
  right: ASTNode;
}

interface PipelineNode extends ASTNode {
  type: 'Pipeline';
  commands: ASTNode[];
}

interface SubshellNode extends ASTNode {
  type: 'Subshell';
  list: CompoundListNode;
}

interface CompoundListNode extends ASTNode {
  type: 'CompoundList';
  commands: ASTNode[];
}

interface RedirectNode extends ASTNode {
  type: 'Redirect';
  op: { text: string; type: string };
  file: WordNode;
}

interface ExpansionNode {
  type: string;
  command?: string;
  commandAST?: ScriptNode;
}

interface ScriptNode extends ASTNode {
  type: 'Script';
  commands: ASTNode[];
}

// ============================================================
// Dangerous Argument Patterns
// ============================================================

/**
 * Command arguments that execute subcommands or perform writes.
 * These are program-level features (not shell constructs) that the AST parser
 * cannot detect — e.g., `find -exec` runs arbitrary commands despite `find`
 * being a read-only search tool.
 *
 * Checked BEFORE the regex allowlist pattern match in validateCommand().
 */
const DANGEROUS_COMMAND_ARGS: Record<string, Set<string>> = {
  find: new Set([
    '-exec', '-execdir', '-ok', '-okdir', '-delete',
    // GNU find output actions write directly to a named file without a shell
    // redirect, so the AST alone cannot identify their side effect.
    '-fprint', '-fprint0', '-fprintf', '-fls',
  ]),
};

const AWK_COMMANDS = new Set(['awk', 'gawk', 'mawk', 'nawk']);
const STATIC_INTEGRITY_PATH_PATTERN = /^(?!-)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_@%+=:,./-]+$/;

function getIntegrityCheckReason(commandParts: string[]): string | null {
  const [command, ...args] = commandParts;
  if (command === 'cmp') {
    return args.length === 3 && args[0] === '-s'
      && args.slice(1).every(path => path.length <= 2_048 && STATIC_INTEGRITY_PATH_PATTERN.test(path))
      ? null
      : 'cmp review checks require -s and exactly two static paths without parent traversal';
  }
  if (command === 'shasum') {
    return args.length === 3 && args[0] === '-a' && args[1] === '256'
      && args[2]!.length <= 2_048 && STATIC_INTEGRITY_PATH_PATTERN.test(args[2]!)
      ? null
      : 'shasum review checks require -a 256 and exactly one static path without parent traversal';
  }
  return null;
}

function getDangerousAwkReason(commandParts: string[]): string | null {
  // commandParts[0] is awk/gawk/mawk/nawk - inspect script/args only
  const scriptText = commandParts.slice(1).join(' ');

  if (/\bsystem\s*\(/i.test(scriptText)) {
    return 'awk system() executes arbitrary shell commands';
  }

  // command | getline executes an external command and reads from it
  if (/\|\s*getline\b/i.test(scriptText)) {
    return 'awk command pipes to getline execute external commands';
  }

  // print ... | "cmd" (or with quoted command forms) executes external commands
  if (/\bprint\b[^\n]*\|\s*["'`]/i.test(scriptText)) {
    return 'awk print-to-command pipes execute external commands';
  }

  return null;
}

// ============================================================
// Validation Logic
// ============================================================

/**
 * Validate a bash command using AST analysis.
 *
 * @param command - The bash command string to validate
 * @param patterns - Compiled regex patterns for allowed commands
 * @returns Validation result with detailed reason if rejected
 */
export function validateBashCommand(
  command: string,
  patterns: CompiledBashPattern[]
): BashValidationResult {
  // Parse the command into an AST
  let ast: ScriptNode;
  try {
    ast = bashParser(command) as ScriptNode;
  } catch (error) {
    debug('[BashValidator] Parse error:', error);
    return {
      allowed: false,
      reason: {
        type: 'parse_error',
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }

  // Validate the AST recursively
  const subcommandResults: SubcommandResult[] = [];
  const result = validateNode(ast, patterns, subcommandResults);

  return {
    ...result,
    subcommandResults: subcommandResults.length > 0 ? subcommandResults : undefined,
  };
}

/**
 * Recursively validate an AST node.
 */
function validateNode(
  node: ASTNode,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): BashValidationResult {
  switch (node.type) {
    case 'Script':
      return validateScript(node as ScriptNode, patterns, results);

    case 'Command':
      return validateCommand(node as CommandNode, patterns, results);

    case 'LogicalExpression':
      return validateLogicalExpression(node as LogicalExpressionNode, patterns, results);

    case 'Pipeline':
      // Validate each command in the pipeline individually.
      // If all commands are in the allowlist, the pipeline is safe.
      // e.g., `git log | head` is allowed because both commands are read-only.
      return validatePipeline(node as PipelineNode, patterns, results);

    case 'Subshell':
      return validateSubshell(node as SubshellNode, patterns, results);

    case 'CompoundList':
      return validateCompoundList(node as CompoundListNode, patterns, results);

    default:
      // Unknown node type — fail closed. bash-parser may produce node types
      // we don't explicitly handle (If, While, For, Case, Function, etc.).
      // Block them rather than silently allowing arbitrary constructs.
      debug('[BashValidator] Unknown node type (blocked):', node.type);
      return {
        allowed: false,
        reason: {
          type: 'parse_error',
          error: `Unsupported shell construct: "${node.type}". Only simple commands, pipelines, logical expressions (&&/||), and subshells are supported in Explore mode`,
        },
      };
  }
}

/**
 * Validate a Script node (top-level).
 */
function validateScript(
  node: ScriptNode,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): BashValidationResult {
  for (const cmd of node.commands) {
    const result = validateNode(cmd, patterns, results);
    if (!result.allowed) {
      return result;
    }
  }
  return { allowed: true };
}

/**
 * Validate a simple Command node.
 * Checks for:
 * 1. Command name matches safe patterns
 * 2. No redirects in suffix
 * 3. No command expansions in any word
 */
function validateCommand(
  node: CommandNode,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): BashValidationResult {
  // Check for background execution (&) - always blocked as it allows
  // running commands asynchronously which could hide malicious activity
  if (node.async) {
    return {
      allowed: false,
      reason: {
        type: 'background_execution',
        explanation: 'Background execution (&) runs commands asynchronously which could hide malicious activity',
      },
    };
  }

  // Build the full command string for pattern matching
  const commandParts: string[] = [];

  // Add command name
  if (node.name) {
    // Check for expansions in command name
    const expansionCheck = checkWordForExpansions(node.name);
    if (expansionCheck) {
      return { allowed: false, reason: expansionCheck };
    }
    commandParts.push(node.name.text);
  }

  // Add prefix (assignments, redirects before command)
  if (node.prefix) {
    for (const item of node.prefix) {
      if (item.type === 'Redirect') {
        const redirect = item as RedirectNode;
        // Allow safe redirects (input redirects and output to /dev/null)
        if (!isRedirectSafe(redirect)) {
          return {
            allowed: false,
            reason: {
              type: 'redirect',
              op: redirect.op.text,
              explanation: getRedirectExplanation(redirect.op.text),
            },
          };
        }
      }

      // Block environment variable assignments in command prefix.
      // e.g., PATH=/evil ls, LD_PRELOAD=/evil/lib.so ls, FOO=bar cmd
      // These modify the command's environment, potentially enabling
      // PATH hijacking or library injection (LD_PRELOAD).
      if (item.type === 'AssignmentWord') {
        return {
          allowed: false,
          reason: {
            type: 'env_assignment',
            explanation: `Environment variable assignment "${(item as WordNode).text}" modifies command behavior (e.g., PATH hijacking, LD_PRELOAD injection)`,
          },
        };
      }
    }
  }

  // Add suffix (arguments, redirects after command)
  if (node.suffix) {
    for (const item of node.suffix) {
      if (item.type === 'Redirect') {
        const redirect = item as RedirectNode;
        // Allow safe redirects (input redirects and output to /dev/null)
        if (!isRedirectSafe(redirect)) {
          return {
            allowed: false,
            reason: {
              type: 'redirect',
              op: redirect.op.text,
              explanation: getRedirectExplanation(redirect.op.text),
            },
          };
        }
      } else if (item.type === 'Word') {
        const word = item as WordNode;

        // Check for command expansions in arguments
        const expansionCheck = checkWordForExpansions(word);
        if (expansionCheck) {
          return { allowed: false, reason: expansionCheck };
        }

        commandParts.push(word.text);
      }
    }
  }

  // Check for command arguments that enable sub-command execution or writes.
  // e.g., `find -exec touch file \;` — the `-exec` flag runs arbitrary commands.
  // These are program-level features invisible to the shell AST.
  const cmdName = node.name?.text;
  if (cmdName) {
    const normalizedCmd = cmdName.toLowerCase();

    if (normalizedCmd === 'cmp' || normalizedCmd === 'shasum') {
      const integrityReason = getIntegrityCheckReason(commandParts);
      if (integrityReason) {
        const command = commandParts.join(' ');
        results.push({ command, allowed: false, reason: integrityReason });
        return {
          allowed: false,
          reason: { type: 'unsafe_command', command, explanation: integrityReason },
        };
      }
    }

    if (AWK_COMMANDS.has(normalizedCmd)) {
      const awkReason = getDangerousAwkReason(commandParts);
      if (awkReason) {
        const subResult: SubcommandResult = {
          command: commandParts.join(' '),
          allowed: false,
          reason: awkReason,
        };
        results.push(subResult);
        return {
          allowed: false,
          reason: {
            type: 'unsafe_command',
            command: commandParts.join(' '),
            explanation: awkReason,
          },
        };
      }
    }

    if (DANGEROUS_COMMAND_ARGS[normalizedCmd]) {
      const dangerousArgs = DANGEROUS_COMMAND_ARGS[normalizedCmd];
      for (const part of commandParts) {
        if (dangerousArgs.has(part)) {
          const subResult: SubcommandResult = {
            command: commandParts.join(' '),
            allowed: false,
            reason: `Argument "${part}" executes subcommands or performs writes`,
          };
          results.push(subResult);
          return {
            allowed: false,
            reason: {
              type: 'unsafe_command',
              command: commandParts.join(' '),
              explanation: `"${part}" allows arbitrary command execution or file modification within "${normalizedCmd}"`,
            },
          };
        }
      }
    }
  }

  // Build the command string and check against patterns
  const commandStr = commandParts.join(' ');

  // Git reads are not safe merely because a mutable permissions regex names
  // `git status`/`git diff`: repository config can invoke fsmonitor, hooks,
  // pagers, textconv, diff or signature helpers. The host-owned closed grammar
  // is therefore necessary in every permission path. It is not itself a
  // permission grant: the caller must still have a pattern which authorizes
  // the same Git operation after the hardening prefix is removed.
  const executable = posix.basename(cmdName?.toLowerCase() ?? '');
  const gitLikeExecutable = executable === 'git';
  const configuredGitCommand = gitLikeExecutable
    ? ['git', ...commandParts.slice(1 + READ_ONLY_GIT_HARDENING_ARGS.length)].join(' ')
    : commandStr;
  const configuredGitAllowance = gitLikeExecutable && patterns.some(pattern => {
    pattern.regex.lastIndex = 0;
    const matchesConfiguredOperation = pattern.regex.test(configuredGitCommand);
    pattern.regex.lastIndex = 0;
    return matchesConfiguredOperation || pattern.regex.test(commandStr);
  });
  const matchesPattern = gitLikeExecutable
    ? cmdName === 'git'
      && isAllowlistedReadOnlyGitArguments(commandParts.slice(1))
      && configuredGitAllowance
    : patterns.some(pattern => pattern.regex.test(commandStr));

  const subResult: SubcommandResult = {
    command: commandStr,
    allowed: matchesPattern,
    reason: matchesPattern ? undefined : gitLikeExecutable
      ? 'Git observation is missing the exact read-only hardening prefix, uses an unsafe option, or is not granted by the configured allowlist'
      : 'Not in read-only allowlist',
  };
  results.push(subResult);

  if (!matchesPattern) {
    return {
      allowed: false,
      reason: {
        type: 'unsafe_command',
        command: commandStr,
        explanation: gitLikeExecutable
          ? 'Git observations require the exact host-owned read-only grammar and a configured Git permission'
          : 'Command is not in the read-only allowlist',
      },
    };
  }

  return { allowed: true };
}

/**
 * Validate a LogicalExpression (&&, ||).
 * Both sides must be valid for the expression to be allowed.
 */
function validateLogicalExpression(
  node: LogicalExpressionNode,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): BashValidationResult {
  // Validate left side
  const leftResult = validateNode(node.left, patterns, results);
  if (!leftResult.allowed) {
    return leftResult;
  }

  // Validate right side
  const rightResult = validateNode(node.right, patterns, results);
  if (!rightResult.allowed) {
    return rightResult;
  }

  return { allowed: true };
}

/**
 * Validate a Pipeline node (cmd1 | cmd2 | ...).
 * Each command in the pipeline must be valid for the whole pipeline to be allowed.
 */
function validatePipeline(
  node: PipelineNode,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): BashValidationResult {
  for (const cmd of node.commands) {
    const result = validateNode(cmd, patterns, results);
    if (!result.allowed) {
      return result;
    }
  }
  return { allowed: true };
}

/**
 * Validate a Subshell node (...).
 * The inner commands must all be valid.
 */
function validateSubshell(
  node: SubshellNode,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): BashValidationResult {
  return validateNode(node.list, patterns, results);
}

/**
 * Validate a CompoundList (list of commands in subshell or similar).
 */
function validateCompoundList(
  node: CompoundListNode,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): BashValidationResult {
  for (const cmd of node.commands) {
    const result = validateNode(cmd, patterns, results);
    if (!result.allowed) {
      return result;
    }
  }
  return { allowed: true };
}

/**
 * Check a Word node for dangerous expansions.
 * Returns a rejection reason if found, null if safe.
 */
function checkWordForExpansions(word: WordNode): BashValidationReason | null {
  if (!word.expansion) {
    return null;
  }

  for (const exp of word.expansion) {
    if (exp.type === 'CommandExpansion') {
      return {
        type: 'command_expansion',
        explanation: `Command substitution $(...) executes embedded commands (found in: ${word.text})`,
      };
    }

    // Process substitution <(...) or >(...)
    // bash-parser may represent these differently, check for common patterns
    if (exp.type === 'ProcessSubstitution') {
      return {
        type: 'process_substitution',
        explanation: `Process substitution executes commands (found in: ${word.text})`,
      };
    }

    // Parameter expansion ($VAR, ${VAR}, ${VAR:-default}) can make commands
    // behave unpredictably based on environment state.
    // e.g., `cat $HOME/.ssh/id_rsa` reads sensitive files via expansion.
    if (exp.type === 'ParameterExpansion') {
      return {
        type: 'parameter_expansion',
        explanation: `Variable expansion \${...} makes command behavior dependent on environment state (found in: ${word.text})`,
      };
    }
  }

  return null;
}

/**
 * Safe input redirect operators that don't write to files.
 */
const SAFE_INPUT_REDIRECTS = new Set([
  '<',    // Input redirect - read-only
  '<&',   // Duplicate input file descriptor
]);

/**
 * Check if a redirect is safe (read-only or to /dev/null).
 *
 * Safe redirects:
 * - Input redirects: <, <&
 * - Output redirects to /dev/null (e.g., >/dev/null, 2>/dev/null)
 * - File descriptor duplication (e.g., 2>&1) - just duplicates, doesn't write to file
 */
function isRedirectSafe(redirect: RedirectNode): boolean {
  const op = redirect.op.text;

  // Input redirects are always safe (read-only)
  if (SAFE_INPUT_REDIRECTS.has(op)) {
    return true;
  }

  const target = redirect.file?.text;

  // Output redirects to /dev/null are safe
  if (target === '/dev/null') {
    return true;
  }

  // File descriptor duplication (e.g., 2>&1) is safe - it just redirects to another fd
  // These have targets like "1", "2" (file descriptor numbers)
  if (op === '>&' && target && /^\d+$/.test(target)) {
    return true;
  }

  return false;
}

/**
 * Get explanation for a redirect operator.
 */
function getRedirectExplanation(op: string): string {
  const explanations: Record<string, string> = {
    '>': 'overwrites file contents',
    '>>': 'appends to file',
    '>&': 'redirects file descriptors',
    '>|': 'forces overwrite (clobber)',
    '<<': 'here-document could inject arbitrary content',
  };

  return explanations[op] || `redirect operator "${op}" modifies file I/O`;
}

/**
 * Check if the command string contains dangerous control characters.
 *
 * Note: Newlines and carriage returns are NOT blocked here because bash-parser
 * correctly parses them as command separators, and the AST validation will
 * check each command individually. Only null bytes are blocked as they could
 * cause issues at lower levels (C bindings, string handling).
 */
export function hasControlCharacters(command: string): { char: string; explanation: string } | null {
  const dangerous: Record<string, string> = {
    '\x00': 'Null byte can truncate strings unexpectedly',
  };

  for (const char of command) {
    if (dangerous[char]) {
      return { char: '\\0', explanation: dangerous[char] };
    }
  }

  return null;
}
