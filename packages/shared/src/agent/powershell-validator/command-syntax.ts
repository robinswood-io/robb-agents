import type { ASTNode, StringConstantExpressionAst, VariableExpressionAst } from './ast-types.ts';

/**
 * Get the text value from a command element.
 */
export function getElementText(node: ASTNode): string | null {
  if (!node) {
    return null;
  }

  switch (node.Type) {
    case 'StringConstantExpressionAst':
      return (node as StringConstantExpressionAst).Value;

    case 'VariableExpressionAst':
      return `$${(node as VariableExpressionAst).VariablePath}`;

    case 'CommandParameterAst':
      return node.Text;

    default:
      return node.Text;
  }
}

/**
 * Synchronous check if command looks like PowerShell syntax.
 * Used to determine whether to use PowerShell or bash validation.
 */
export function looksLikePowerShell(command: string): boolean {
  const psPatterns = [
    // Cmdlet pattern: Verb-Noun
    /\b(Get|Set|New|Remove|Add|Clear|Write|Read|Out|ConvertTo|ConvertFrom|Test|Select|Where|ForEach|Sort|Group|Measure|Compare|Format|Export|Import|Start|Stop|Invoke|Enable|Disable|Register|Unregister|Update|Find|Install|Uninstall|Save|Publish|Push|Pop)-\w+/i,

    // PowerShell variables in pipeline
    /\$\w+\s*\|/,

    // PowerShell operators
    /\s-(?:eq|ne|gt|lt|ge|le|like|notlike|match|notmatch|contains|notcontains|in|notin|replace|split|join)\s/i,

    // Array/hashtable literals
    /@\([^)]*\)/,
    /@\{[^}]*\}/,

    // PowerShell specific cmdlets
    /\b(Where-Object|Select-Object|ForEach-Object|Sort-Object|Group-Object|Measure-Object)\b/i,

    // Common PowerShell aliases that differ from Unix
    /\b(gci|gcm|gps|gsv|gjb)\b/i,
  ];

  return psPatterns.some(p => p.test(command));
}

// ============================================================
// Write Target Extraction (for plans folder exception)
// ============================================================

/**
 * Detect and unwrap `powershell.exe -Command "..."` wrapper, returning the inner command.
 *
 * Codex on Windows often wraps PowerShell commands in:
 *   "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command "Set-Content -Path \"...\" ..."
 *   powershell.exe -NoProfile -Command "..."
 *   pwsh -Command "..."
 *
 * The PS AST parser sees `powershell.exe` as the top-level command (not the inner cmdlet),
 * so extractPowerShellWriteTarget() fails. This function strips the wrapper and returns
 * the inner command with escaped quotes unescaped, so it can be re-parsed.
 */
export function unwrapPowerShellCommand(command: string): string | null {
  // Match: "C:\...\powershell.exe" -Command "inner"  OR  powershell.exe -Command "inner"  OR  pwsh -Command "inner"
  // Optional flags like -NoProfile -NonInteractive before -Command
  const match = command.match(
    /^(?:"[^"]*[/\\]?(?:powershell|pwsh)(?:\.exe)?"\s+|(?:powershell|pwsh)(?:\.exe)?\s+)(?:-(?!Command)\w+\s+)*-Command\s+"((?:[^"\\]|\\.)*)"\s*$/i
  );
  if (!match?.[1]) return null;
  // Unescape inner escaped quotes: \" → "
  return match[1].replace(/\\"/g, '"');
}
