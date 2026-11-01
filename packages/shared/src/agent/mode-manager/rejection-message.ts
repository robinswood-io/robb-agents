/// <reference path="../../types/incr-regex-package.d.ts" />
import type { BashRejectionReason, ToolCheckConfig } from './bash-contracts.ts';
import { formatPermissionGuidance } from './bash-guidance.ts';

/**
 * Detect known upstream bash-parser tokenizer bugs.
 *
 * bash-parser has longstanding edge cases around quoted `$` / `)` handling
 * that can throw internal errors like `reducers.doubleQuoting`.
 */
function isKnownBashParserTokenizerBug(error: string): boolean {
  const lower = error.toLowerCase();
  return lower.includes('doublequoting') || lower.includes('reducers.doublequoting');
}

/**
 * Format a bash rejection reason into a user-friendly error message.
 * The message explains what was blocked and why, helping the agent understand the issue.
 * Includes actionable guidance on how to customize permissions.
 */
export function formatBashRejectionMessage(reason: BashRejectionReason, config: ToolCheckConfig): string {
  const modeSwitchHint = `Switch to Ask or Allow All mode (${config.shortcutHint}) to run it.`;
  const permissionGuidance = formatPermissionGuidance(config);

  switch (reason.type) {
    case 'control_char':
      return `Bash command blocked: contains "${reason.char}" character. ${reason.explanation}. ${modeSwitchHint}`;

    case 'no_safe_pattern': {
      // Build a helpful message showing what patterns might be relevant
      const lines: string[] = [];
      lines.push(`Bash command \`${reason.command}\` is not in the read-only allowlist.`);

      // Prefer deterministic per-command guidance over fuzzy regex diagnostics.
      if (reason.commandHint) {
        lines.push('');
        lines.push(`Why: ${reason.commandHint.reason}`);
        if (reason.commandHint.context) {
          lines.push(`Context: ${reason.commandHint.context}`);
        }
        if (reason.commandHint.tryInstead && reason.commandHint.tryInstead.length > 0) {
          lines.push('Try instead:');
          for (const item of reason.commandHint.tryInstead) {
            lines.push(`  • ${item}`);
          }
        }
        if (reason.commandHint.example) {
          lines.push(`Example: \`${reason.commandHint.example}\``);
        }
      }

      // If we have mismatch analysis, show detailed diagnostics as heuristic guidance.
      if (reason.mismatchAnalysis) {
        const analysis = reason.mismatchAnalysis;
        lines.push('');

        // Show what matched and where it failed
        if (analysis.matchedPrefix) {
          lines.push(`Matched: \`${analysis.matchedPrefix}\` (${analysis.failedAtPosition} chars)`);
        }
        if (analysis.failedToken) {
          lines.push(`Failed at: \`${analysis.failedToken}\` (position ${analysis.failedAtPosition})`);
        }

        // Show the actionable suggestion if we have one
        if (analysis.suggestion) {
          lines.push('');
          lines.push(analysis.suggestion);
        }

        // Show which pattern was closest to matching (heuristic only)
        if (analysis.bestMatchPattern?.comment) {
          lines.push('');
          lines.push(`Closest allowlist hint (heuristic): ${analysis.bestMatchPattern.comment}`);
        }
      } else if (reason.relevantPatterns.length > 0) {
        // Fall back to showing relevant patterns if no mismatch analysis
        lines.push('');
        lines.push('Heuristic relevant pattern(s):');
        for (const pattern of reason.relevantPatterns) {
          // Show the pattern regex (simplified for readability)
          const patternDisplay = pattern.source.length > 80
            ? pattern.source.substring(0, 77) + '...'
            : pattern.source;
          lines.push(`  Pattern: \`${patternDisplay}\``);
          if (pattern.comment) {
            lines.push(`  → ${pattern.comment}`);
          }
        }
        lines.push('');
        lines.push('The command must match an allowlist pattern exactly from the start.');
      }

      // Add permission guidance for pattern-based rejections
      lines.push(permissionGuidance);
      lines.push('');
      lines.push(modeSwitchHint);
      return lines.join('\n');
    }

    case 'dangerous_operator':
      return `Bash command blocked: contains "${reason.operator}" operator. This ${reason.explanation}. Run commands separately or switch to Ask mode.`;

    case 'dangerous_substitution':
      return `Bash command blocked: contains ${reason.pattern} syntax. ${reason.explanation}. ${modeSwitchHint}`;

    case 'parse_error': {
      const lines: string[] = [];
      lines.push(`Bash command blocked: could not parse command safely (${reason.error}).`);

      if (isKnownBashParserTokenizerBug(reason.error)) {
        lines.push('');
        lines.push('This looks like a known bash-parser tokenizer bug (not necessarily unsafe intent).');
        lines.push('Try using single quotes for regex/text arguments instead of double quotes.');
        lines.push('Problematic patterns often involve `$` (and sometimes `)`) inside double-quoted strings.');
        lines.push('Example: `rg -n "a|b|$|c" ...` → `rg -n \'a|b|$|c\' ...`');
      }

      lines.push('');
      lines.push(modeSwitchHint);
      return lines.join('\n');
    }

    case 'compound_partial_fail': {
      // Some commands in a compound expression failed
      const lines: string[] = [];
      lines.push('Bash command blocked: compound command contains unsafe operations.');
      lines.push('');
      if (reason.passedCommands.length > 0) {
        lines.push('✓ Allowed commands:');
        for (const cmd of reason.passedCommands) {
          lines.push(`  • \`${cmd}\``);
        }
      }
      if (reason.failedCommands.length > 0) {
        lines.push('✗ Blocked commands (not in read-only allowlist):');
        for (const cmd of reason.failedCommands) {
          lines.push(`  • \`${cmd}\``);
        }
      }
      // Add permission guidance for compound command failures
      lines.push(permissionGuidance);
      lines.push('');
      lines.push(modeSwitchHint);
      return lines.join('\n');
    }

    // New AST-based types (shouldn't reach here as they're converted above, but handle for completeness)
    case 'pipeline':
      return `Bash command blocked: contains pipeline (|). ${reason.explanation}. ${modeSwitchHint}`;

    case 'redirect':
      return `Bash command blocked: contains "${reason.op}" redirect. This ${reason.explanation}. ${modeSwitchHint}`;

    case 'command_expansion':
      return `Bash command blocked: contains command substitution. ${reason.explanation}. ${modeSwitchHint}`;

    case 'process_substitution':
      return `Bash command blocked: contains process substitution. ${reason.explanation}. ${modeSwitchHint}`;

    case 'parameter_expansion':
      return `Bash command blocked: contains variable expansion (\${} / $VAR). ${reason.explanation}. ${modeSwitchHint}`;

    case 'env_assignment':
      return `Bash command blocked: contains environment variable assignment. ${reason.explanation}. ${modeSwitchHint}`;

    case 'unsafe_command': {
      const lines: string[] = [];
      lines.push(`Bash command blocked: \`${reason.command}\` is not in the read-only allowlist.`);
      lines.push(permissionGuidance);
      lines.push('');
      lines.push(modeSwitchHint);
      return lines.join('\n');
    }
  }
}
