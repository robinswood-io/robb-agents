/// <reference path="../../types/incr-regex-package.d.ts" />

// ============================================================
// Windows Path Helpers (for bash-parser fallback)
// ============================================================

/**
 * Check if a command looks like a Windows CMD builtin that can't be parsed
 * by bash-parser or normalized via path rewriting.
 */
export function looksLikeCmdBuiltin(command: string): boolean {
  // Match CMD builtins at the start of the command (case-insensitive).
  // Note: `type` is excluded because it's also a valid bash builtin (check command type).
  // Note: `mkdir` is excluded because it's also a valid Unix/bash command.
  return /^(?:if\s+(?:not\s+)?exist|for\s+\/[a-z]|set\s+\w+=|copy\s|move\s|ren(?:ame)?\s|del\s|erase\s|rd\s|rmdir\s|md\s|assoc\s|ftype\s)\b/i.test(command);
}

/**
 * Normalize Windows backslash paths in a command string so that bash-parser
 * (a POSIX parser) can handle them without treating \ as escape characters.
 *
 * Converts backslashes to forward slashes inside:
 * - Double-quoted strings: "C:\Users\..." → "C:/Users/..."
 * - Single-quoted strings: passed through (bash-parser treats them as literal anyway)
 * - Unquoted tokens that look like Windows paths: C:\Users\... → C:/Users/...
 *
 * Preserves actual bash escape sequences (\n, \t, \\, \", etc.) inside
 * double-quoted strings by only converting backslashes that precede
 * characters that are NOT standard bash escape targets.
 */
export function normalizeWindowsPathsForBashParser(command: string): string {
  let result = '';
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    if (ch === "'") {
      // Single-quoted string: copy verbatim (bash treats contents literally)
      const end = command.indexOf("'", i + 1);
      if (end === -1) {
        // Unclosed single quote - copy rest as-is
        result += command.slice(i);
        break;
      }
      result += command.slice(i, end + 1);
      i = end + 1;
    } else if (ch === '"') {
      // Double-quoted string: fix the critical \" issue for Windows paths.
      //
      // In bash, \X inside double quotes is only special for 5 chars: \ " $ ` !
      // For all other chars, bash-parser keeps the literal \X (no stripping).
      // So the ONLY problem case is \" which bash-parser treats as an escaped
      // quote instead of "backslash + closing-quote". This happens when a
      // Windows path ends with \ right before the closing ":
      //   ls "C:\path\"  →  bash-parser sees \" as escaped quote, string never closes
      //
      // Fix: convert \\ to // (prevents double-backslash from eating a path sep)
      // and convert \" to /" (prevents the unclosed-quote parse failure).
      // Leave all other \X alone since bash-parser handles them correctly.
      result += '"';
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < command.length) {
          const next = command[i + 1];
          if (next === '"') {
            // \\" → /" — this is the critical fix for the "Unclosed quote" bug.
            // Convert the backslash to / so bash-parser sees the closing quote.
            result += '/';
            // Don't consume the quote - let the outer loop see it as closing
            i++;
          } else if (next === '\\') {
            // \\\\ → // — convert double-backslash to double-forward-slash
            result += '//';
            i += 2;
          } else {
            // All other \X — pass through literally (bash-parser keeps them as-is)
            result += command[i]! + next!;
            i += 2;
          }
        } else {
          result += command[i]!;
          i++;
        }
      }
      if (i < command.length) {
        result += '"'; // closing quote
        i++;
      }
    } else {
      // Unquoted context: detect Windows-style path tokens and convert
      // A Windows path looks like X:\ at the start of a "word"
      if (
        /[A-Za-z]/.test(ch!) &&
        i + 2 < command.length &&
        command[i + 1]! === ':' &&
        command[i + 2]! === '\\'
      ) {
        // Consume the path token (up to whitespace or special shell chars)
        let pathEnd = i;
        while (pathEnd < command.length && !/[\s|&;()<>]/.test(command[pathEnd]!)) {
          pathEnd++;
        }
        const pathToken = command.slice(i, pathEnd).replace(/\\/g, '/');
        result += pathToken;
        i = pathEnd;
      } else {
        result += ch;
        i++;
      }
    }
  }

  return result;
}
