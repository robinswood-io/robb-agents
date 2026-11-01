/// <reference path="../../types/incr-regex-package.d.ts" />
import { debug } from "../../utils/debug.ts";
import { validatePowerShellCommand } from "../powershell-validator.ts";
import type { BashRejectionReason, ToolCheckConfig } from './bash-contracts.ts';
import { analyzePatternMismatch, findBlockedCommandHint, findRelevantPatterns } from './bash-guidance.ts';

/**
 * Get detailed reason why a PowerShell command would be rejected.
 * Converts PowerShell validation results to BashRejectionReason format
 * for consistent error message handling.
 */
export function getPowerShellRejectionReason(command: string, config: ToolCheckConfig): BashRejectionReason | null {
  const psResult = validatePowerShellCommand(command, config.readOnlyBashPatterns);

  if (psResult.allowed) {
    debug('[Mode] PowerShell command allowed via AST validation:', command);
    return null;
  }

  // Convert PowerShell rejection reason to BashRejectionReason format
  if (psResult.reason) {
    const reason = psResult.reason;

    switch (reason.type) {
      case 'parse_error':
        return { type: 'parse_error', error: reason.error };

      case 'powershell_unavailable':
        // Fall back to bash validation if PowerShell is not available
        debug('[Mode] PowerShell unavailable, falling back to bash validation');
        return null;

      case 'pipeline':
        return {
          type: 'dangerous_operator',
          operator: '|',
          operatorType: 'chain',
          explanation: reason.explanation,
        };

      case 'redirect':
        return {
          type: 'dangerous_operator',
          operator: '>',
          operatorType: 'redirect',
          explanation: reason.explanation,
        };

      case 'subexpression':
        return {
          type: 'dangerous_substitution',
          pattern: '$()',
          explanation: reason.explanation,
        };

      case 'script_block':
        return {
          type: 'dangerous_substitution',
          pattern: '{ }',
          explanation: reason.explanation,
        };

      case 'invoke_expression':
        return {
          type: 'dangerous_substitution',
          pattern: 'Invoke-Expression',
          explanation: reason.explanation,
        };

      case 'dot_sourcing':
        return {
          type: 'dangerous_substitution',
          pattern: '. (dot-sourcing)',
          explanation: reason.explanation,
        };

      case 'assignment':
        return {
          type: 'dangerous_operator',
          operator: '=',
          operatorType: 'chain',
          explanation: reason.explanation,
        };

      case 'background_execution':
        return {
          type: 'dangerous_operator',
          operator: '&',
          operatorType: 'chain',
          explanation: reason.explanation,
        };

      case 'unsafe_command': {
        const relevantPatterns = findRelevantPatterns(reason.command, config.readOnlyBashPatterns);
        const mismatchAnalysis = analyzePatternMismatch(reason.command, config.readOnlyBashPatterns);
        const commandHint = findBlockedCommandHint(reason.command, config);

        const optionalMismatchAnalysis = mismatchAnalysis ?? undefined;
        return {
          type: 'no_safe_pattern',
          command: reason.command,
          relevantPatterns,
          ...(optionalMismatchAnalysis !== undefined ? { mismatchAnalysis: optionalMismatchAnalysis } : {}),
          ...(commandHint !== undefined ? { commandHint } : {}),
        };
      }
    }
  }

  // Fallback
  debug('[Mode] Unexpected: PowerShell AST rejected but no reason provided');
  const commandHint = findBlockedCommandHint(command, config);
  return {
    type: 'no_safe_pattern',
    command: command,
    relevantPatterns: [],
    
    ...(commandHint !== undefined ? { commandHint } : {}),
  };
}
