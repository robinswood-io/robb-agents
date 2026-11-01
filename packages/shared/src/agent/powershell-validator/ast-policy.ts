import type { CompiledBashPattern } from "../mode-types.ts";
import { checkForDangerousConstructs } from './ast-policy-check-for-dangerous-constructs.ts';
import type { ASTNode, CommandAst, CommandExpressionAst, FileRedirectionAst, NamedBlockAst, PipelineAst, PowerShellValidationResult, ScriptBlockAst, SubcommandResult } from './ast-types.ts';
import { getElementText } from './command-syntax.ts';
import { isDangerousCmdlet } from './dangerous-commands.ts';
import { isPowerShellAvailable, parseCommand } from './parser-process.ts';

// ============================================================
// Validation Logic
// ============================================================

/**
 * Validate a PowerShell command using AST analysis.
 *
 * @param command - The PowerShell command string to validate
 * @param patterns - Compiled regex patterns for allowed commands
 * @returns Validation result with detailed reason if rejected
 */
export function validatePowerShellCommand(
  command: string,
  patterns: CompiledBashPattern[]
): PowerShellValidationResult {
  // Check if PowerShell is available
  if (!isPowerShellAvailable()) {
    return {
      allowed: false,
      reason: {
        type: 'powershell_unavailable',
        explanation: 'PowerShell is not available on this system',
      },
    };
  }

  // Parse the command
  const parseResult = parseCommand(command);

  if (!parseResult.success || !parseResult.ast) {
    return {
      allowed: false,
      reason: {
        type: 'parse_error',
        error: parseResult.error || 'Unknown parse error',
      },
    };
  }

  // Check for parse errors
  if (parseResult.parseErrors && parseResult.parseErrors.length > 0) {
    return {
      allowed: false,
      reason: {
        type: 'parse_error',
        error: parseResult.parseErrors.map(e => e.Message).join('; '),
      },
    };
  }

  // Validate the AST
  const subcommandResults: SubcommandResult[] = [];
  const result = validateNode(parseResult.ast, patterns, subcommandResults);

  return {
    ...result,
    ...(subcommandResults.length > 0 ? { subcommandResults: subcommandResults } : {}),
  };
}

/**
 * Recursively validate an AST node.
 */
function validateNode(
  node: ASTNode,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): PowerShellValidationResult {
  if (!node) {
    return { allowed: true };
  }

  switch (node.Type) {
    case 'ScriptBlockAst':
      return validateScriptBlock(node as ScriptBlockAst, patterns, results);

    case 'NamedBlockAst':
      return validateNamedBlock(node as NamedBlockAst, patterns, results);

    case 'PipelineAst':
      return validatePipeline(node as PipelineAst, patterns, results);

    case 'CommandAst':
      return validateCommand(node as CommandAst, patterns, results);

    case 'CommandExpressionAst':
      return validateCommandExpression(node as CommandExpressionAst, patterns, results);

    case 'AssignmentStatementAst':
      return {
        allowed: false,
        reason: {
          type: 'assignment',
          explanation: 'Variable assignment could modify state',
        },
      };

    case 'SubExpressionAst':
      return {
        allowed: false,
        reason: {
          type: 'subexpression',
          explanation: '$(...) subexpressions execute embedded commands',
        },
      };

    case 'ScriptBlockExpressionAst':
      return {
        allowed: false,
        reason: {
          type: 'script_block',
          explanation: 'Script blocks { } can execute arbitrary code',
        },
      };

    default:
      // Check for dangerous patterns in any node
      return validateGenericNode(node, patterns, results);
  }
}

/**
 * Validate a ScriptBlockAst (root node).
 */
function validateScriptBlock(
  node: ScriptBlockAst,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): PowerShellValidationResult {
  // Validate each block
  for (const block of [node.BeginBlock, node.ProcessBlock, node.EndBlock]) {
    if (block) {
      const result = validateNode(block, patterns, results);
      if (!result.allowed) {
        return result;
      }
    }
  }
  return { allowed: true };
}

/**
 * Validate a NamedBlockAst.
 */
function validateNamedBlock(
  node: NamedBlockAst,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): PowerShellValidationResult {
  for (const stmt of node.Statements || []) {
    const result = validateNode(stmt, patterns, results);
    if (!result.allowed) {
      return result;
    }
  }
  return { allowed: true };
}

/**
 * Validate a PipelineAst.
 */
function validatePipeline(
  node: PipelineAst,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): PowerShellValidationResult {
  // Check for background execution
  if (node.Background) {
    return {
      allowed: false,
      reason: {
        type: 'background_execution',
        explanation: 'Background execution (&) could hide malicious activity',
      },
    };
  }

  // Validate each pipeline element
  for (const element of node.PipelineElements || []) {
    const result = validateNode(element, patterns, results);
    if (!result.allowed) {
      return result;
    }
  }

  return { allowed: true };
}

/**
 * Validate a CommandAst.
 */
function validateCommand(
  node: CommandAst,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): PowerShellValidationResult {
  // Check invocation operator
  if (node.InvocationOperator === 'Dot') {
    return {
      allowed: false,
      reason: {
        type: 'dot_sourcing',
        explanation: 'Dot-sourcing (.) executes scripts in current scope',
      },
    };
  }

  if (node.InvocationOperator === 'Ampersand') {
    return {
      allowed: false,
      reason: {
        type: 'script_block',
        explanation: 'Call operator (&) executes commands/scripts',
      },
    };
  }

  // Check for file redirections
  for (const redirect of node.Redirections || []) {
    if (redirect.Type === 'FileRedirectionAst') {
      const fileRedirect = redirect as FileRedirectionAst;
      const target = fileRedirect.Location?.Text || 'unknown';

      // Allow redirection to $null (PowerShell's /dev/null)
      if (target.toLowerCase() === '$null') {
        continue;
      }

      return {
        allowed: false,
        reason: {
          type: 'redirect',
          target,
          explanation: `File redirection to "${target}" writes to filesystem`,
        },
      };
    }
  }

  // Build command string for pattern matching
  const commandParts: string[] = [];

  for (const element of node.CommandElements || []) {
    // Check each element for dangerous constructs
    const dangerCheck = checkForDangerousConstructs(element);
    if (dangerCheck) {
      return { allowed: false, reason: dangerCheck };
    }

    // Extract text for pattern matching
    const text = getElementText(element);
    if (text) {
      commandParts.push(text);
    }
  }

  const commandStr = commandParts.join(' ');
  const cmdletName = commandParts[0] || '';

  // Check if cmdlet is inherently dangerous
  if (isDangerousCmdlet(cmdletName)) {
    const subResult: SubcommandResult = {
      command: commandStr,
      allowed: false,
      reason: `Cmdlet "${cmdletName}" can modify system state`,
    };
    results.push(subResult);

    return {
      allowed: false,
      reason: {
        type: 'unsafe_command',
        command: commandStr,
        explanation: `Cmdlet "${cmdletName}" can modify system state`,
      },
    };
  }

  // Check against safe patterns (case-insensitive for PowerShell)
  // PowerShell cmdlets are case-insensitive, so Get-Process == get-process == GET-PROCESS
  const matchesPattern = patterns.some(pattern => {
    // Try original pattern first
    if (pattern.regex.test(commandStr)) {
      return true;
    }
    // If pattern doesn't have 'i' flag, try case-insensitive match
    if (!pattern.regex.flags.includes('i')) {
      try {
        const caseInsensitiveRegex = new RegExp(pattern.source, pattern.regex.flags + 'i');
        return caseInsensitiveRegex.test(commandStr);
      } catch {
        // If regex creation fails, fall back to original result
        return false;
      }
    }
    return false;
  });

  const optionalReason = matchesPattern ? undefined : 'Not in read-only allowlist';
  const subResult: SubcommandResult = {
    command: commandStr,
    allowed: matchesPattern,
    ...(optionalReason !== undefined ? { reason: optionalReason } : {}),
  };
  results.push(subResult);

  if (!matchesPattern) {
    return {
      allowed: false,
      reason: {
        type: 'unsafe_command',
        command: commandStr,
        explanation: 'Command is not in the read-only allowlist',
      },
    };
  }

  return { allowed: true };
}

/**
 * Validate a CommandExpressionAst.
 */
function validateCommandExpression(
  node: CommandExpressionAst,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): PowerShellValidationResult {
  return validateNode(node.Expression, patterns, results);
}

/**
 * Validate any node for dangerous patterns.
 */
function validateGenericNode(
  node: ASTNode,
  _patterns: CompiledBashPattern[],
  _results: SubcommandResult[]
): PowerShellValidationResult {
  const dangerCheck = checkForDangerousConstructs(node);
  if (dangerCheck) {
    return { allowed: false, reason: dangerCheck };
  }

  return { allowed: true };
}
