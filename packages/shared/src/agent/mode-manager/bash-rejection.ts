/// <reference path="../../types/incr-regex-package.d.ts" />
import { debug } from "../../utils/debug.ts";
import { validateBashCommand, hasControlCharacters } from "../bash-validator.ts";
import { looksLikePowerShell, isPowerShellAvailable } from "../powershell-validator.ts";
import type { BashRejectionReason, ToolCheckConfig } from './bash-contracts.ts';
import { analyzePatternMismatch, findBlockedCommandHint, findRelevantPatterns } from './bash-guidance.ts';
import { looksLikeCmdBuiltin, normalizeWindowsPathsForBashParser } from './bash-parser-compat.ts';
import { getPowerShellRejectionReason } from './powershell-rejection.ts';

/**
 * Get detailed reason why a bash command would be rejected.
 * Returns null if the command is safe, otherwise returns the specific reason.
 *
 * Uses AST-based validation for compound commands (&&, ||, ;) to allow
 * safe compound commands like `git status && git log` while still blocking
 * dangerous constructs.
 *
 * For PowerShell commands (detected by syntax or on Windows), uses the
 * PowerShell validator with native System.Management.Automation parsing.
 *
 * This is used to provide helpful error messages that explain exactly what
 * was blocked and why, helping the agent understand and avoid the issue.
 */
export function getBashRejectionReason(command: string, config: ToolCheckConfig): BashRejectionReason | null {
  const trimmedCommand = command.trim();

  // Step 1: Check for dangerous control characters (before parsing)
  // These could affect parsing itself, so check first
  const controlChar = hasControlCharacters(trimmedCommand);
  if (controlChar) {
    return {
      type: 'control_char',
      char: controlChar.char,
      charCode: 0, // Not used in new flow, but kept for compatibility
      explanation: controlChar.explanation,
    };
  }

  // Step 2: Determine if this is a PowerShell command
  // Use PS validator only for commands that look like PowerShell syntax.
  // On Windows, non-PowerShell commands (e.g. `git status && git log`) are
  // validated via bash-parser with Windows path normalization instead, because
  // the PS parser has different semantics for redirects, subshells, $(), etc.
  const isWindows = process.platform === 'win32';
  const isPsCommand = looksLikePowerShell(trimmedCommand);

  if (isPsCommand && isPowerShellAvailable()) {
    debug('[Mode] Using PowerShell validator for command:', trimmedCommand);
    return getPowerShellRejectionReason(trimmedCommand, config);
  }

  // Step 2b: On Windows, reject CMD-only syntax early.
  // Commands like `if not exist`, `for /f`, `set VAR=` are Windows CMD builtins
  // that neither bash-parser nor path normalization can handle.
  if (isWindows && looksLikeCmdBuiltin(trimmedCommand)) {
    return {
      type: 'parse_error',
      error: 'Windows CMD syntax (if/for/set/copy/move) is not supported in Explore mode. Use PowerShell equivalents or bash commands instead.',
    };
  }

  // Step 2c: On Windows, normalize backslash paths for bash-parser.
  // bash-parser is POSIX and treats \ as escape chars, mangling Windows paths like
  // C:\Users\... into C:Users... or failing on trailing backslash-quote (\").
  const commandForParser = isWindows
    ? normalizeWindowsPathsForBashParser(trimmedCommand)
    : trimmedCommand;

  // Step 3: Use bash AST-based validation
  // This handles compound commands, pipelines, redirects, and substitutions properly
  const astResult = validateBashCommand(commandForParser, config.readOnlyBashPatterns);

  if (astResult.allowed) {
    debug('[Mode] Command allowed via AST validation:', trimmedCommand);
    return null;
  }

  // Step 3: Convert AST rejection reason to BashRejectionReason
  if (astResult.reason) {
    const reason = astResult.reason;

    switch (reason.type) {
      case 'parse_error':
        return { type: 'parse_error', error: reason.error };

      case 'pipeline':
        // Convert to the legacy format for consistent error messages
        return {
          type: 'dangerous_operator',
          operator: '|',
          operatorType: 'chain',
          explanation: reason.explanation,
        };

      case 'redirect':
        return {
          type: 'dangerous_operator',
          operator: reason.op,
          operatorType: 'redirect',
          explanation: reason.explanation,
        };

      case 'command_expansion':
        return {
          type: 'dangerous_substitution',
          pattern: '$()',
          explanation: reason.explanation,
        };

      case 'process_substitution':
        return {
          type: 'dangerous_substitution',
          pattern: '<() or >()',
          explanation: reason.explanation,
        };

      case 'parameter_expansion':
        return {
          type: 'dangerous_substitution',
          pattern: '${} / $VAR',
          explanation: reason.explanation,
        };

      case 'env_assignment':
        return {
          type: 'dangerous_substitution',
          pattern: 'VAR=value',
          explanation: reason.explanation,
        };

      case 'unsafe_command': {
        // Find relevant patterns to help the agent understand what format is expected
        const relevantPatterns = findRelevantPatterns(reason.command, config.readOnlyBashPatterns);
        const mismatchAnalysis = analyzePatternMismatch(reason.command, config.readOnlyBashPatterns);
        const commandHint = findBlockedCommandHint(reason.command, config);

        return {
          type: 'no_safe_pattern',
          command: reason.command,
          relevantPatterns,
          mismatchAnalysis: mismatchAnalysis ?? undefined,
          commandHint,
        };
      }

      case 'compound_partial_fail':
        // Return info about which commands failed in a compound expression
        return {
          type: 'compound_partial_fail',
          failedCommands: reason.failedCommands,
          passedCommands: reason.passedCommands,
        };

      case 'background_execution':
        // Background execution with & operator - convert to dangerous_operator format
        return {
          type: 'dangerous_operator',
          operator: '&',
          operatorType: 'chain',
          explanation: reason.explanation,
        };
    }
  }

  // Fallback: shouldn't reach here, but return generic rejection if we do
  debug('[Mode] Unexpected: AST rejected but no reason provided');
  return {
    type: 'no_safe_pattern',
    command: trimmedCommand,
    relevantPatterns: [],
    mismatchAnalysis: undefined,
    commandHint: findBlockedCommandHint(trimmedCommand, config),
  };
}
