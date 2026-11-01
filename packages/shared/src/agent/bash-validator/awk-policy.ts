/// <reference path="../bash-parser.d.ts" />

// ============================================================
// Dangerous Argument Patterns
// ============================================================

/**
 * Command arguments that execute subcommands or perform writes.
 * These are program-level features (not shell constructs) that the AST parser
 * cannot detect — e.g., `find -exec` runs arbitrary commands despite `find`
 * being a read-only search tool.
 *
 * Checked BEFORE the regex allowlist pattern match in validateCommand().
 */
export const DANGEROUS_COMMAND_ARGS: Record<string, Set<string>> = {
  find: new Set([
    '-exec', '-execdir', '-ok', '-okdir', '-delete',
    // GNU find output actions write directly to a named file without a shell
    // redirect, so the AST alone cannot identify their side effect.
    '-fprint', '-fprint0', '-fprintf', '-fls',
  ]),
};

export const AWK_COMMANDS = new Set(['awk', 'gawk', 'mawk', 'nawk']);

export const STATIC_INTEGRITY_PATH_PATTERN = /^(?!-)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_@%+=:,./-]+(?: [A-Za-z0-9_@%+=:,./-]+)*$/;

export function getIntegrityCheckReason(commandParts: string[]): string | null {
  const [command, ...args] = commandParts;
  if (command === 'cmp') {
    return args.length === 3 && args[0] === '-s'
      && args.slice(1).every(path => path.length <= 2_048 && STATIC_INTEGRITY_PATH_PATTERN.test(path))
      ? null
      : 'cmp review checks require -s and exactly two static paths without parent traversal';
  }
  if (command === 'shasum') {
    return args.length === 3 && args[0] === '-a' && args[1] === '256'
      && args[2]!.length <= 2_048 && STATIC_INTEGRITY_PATH_PATTERN.test(args[2]!)
      ? null
      : 'shasum review checks require -a 256 and exactly one static path without parent traversal';
  }
  return null;
}

export function getDangerousAwkReason(commandParts: string[]): string | null {
  // commandParts[0] is awk/gawk/mawk/nawk - inspect script/args only
  const scriptText = commandParts.slice(1).join(' ');

  if (/\bsystem\s*\(/i.test(scriptText)) {
    return 'awk system() executes arbitrary shell commands';
  }

  // command | getline executes an external command and reads from it
  if (/\|\s*getline\b/i.test(scriptText)) {
    return 'awk command pipes to getline execute external commands';
  }

  // print ... | "cmd" (or with quoted command forms) executes external commands
  if (/\bprint\b[^\n]*\|\s*["'`]/i.test(scriptText)) {
    return 'awk print-to-command pipes execute external commands';
  }

  return null;
}
