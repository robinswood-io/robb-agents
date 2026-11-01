/// <reference path="../bash-parser.d.ts" />
import type { RedirectNode } from './ast-types.ts';

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
export function isRedirectSafe(redirect: RedirectNode): boolean {
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
export function getRedirectExplanation(op: string): string {
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
