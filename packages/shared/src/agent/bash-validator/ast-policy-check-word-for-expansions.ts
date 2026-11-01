/// <reference path="../bash-parser.d.ts" />
import type { BashValidationReason, WordNode } from './ast-types.ts';

/**
 * Check a Word node for dangerous expansions.
 * Returns a rejection reason if found, null if safe.
 */
export function checkWordForExpansions(word: WordNode): BashValidationReason | null {
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
