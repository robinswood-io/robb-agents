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
import { debug } from "../../utils/debug.ts";
import type { CompiledBashPattern } from "../mode-types.ts";
import { posix } from "node:path";
import { checkWordForExpansions } from './ast-policy-check-word-for-expansions.ts';
import type { ASTNode, BashValidationResult, CommandNode, CompoundListNode, LogicalExpressionNode, PipelineNode, RedirectNode, ScriptNode, SubcommandResult, SubshellNode, WordNode } from './ast-types.ts';
import { AWK_COMMANDS, DANGEROUS_COMMAND_ARGS, getDangerousAwkReason, getIntegrityCheckReason } from './awk-policy.ts';
import { READ_ONLY_GIT_HARDENING_ARGS, isAllowlistedReadOnlyGitArguments } from './read-only-review.ts';
import { getRedirectExplanation, isRedirectSafe } from './redirect-policy.ts';

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
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (!command.includes('<<')) {
      debug('[BashValidator] Parse error:', errorMessage);
    }
    return {
      allowed: false,
      reason: {
        type: 'parse_error',
        error: errorMessage,
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
