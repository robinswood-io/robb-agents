/// <reference path="../../types/incr-regex-package.d.ts" />

/**
 * Extract the write target path from a bash command.
 * Returns the file path if the command writes to a file via redirect, null otherwise.
 *
 * Handles:
 * - Direct redirects: `echo "x" > /path/file`
 * - Codex subshell pattern: `/bin/zsh -lc "cat <<'EOF' > /path/file\n...\nEOF"`
 * - sh/bash -c variants: `bash -c "echo x > /path/file"`
 * - PowerShell Out-File: `@(...) | Out-File -FilePath 'path'`
 * - PowerShell Set-Content/Add-Content: `'...' | Set-Content -Path 'path'`
 */
export function extractBashWriteTarget(command: string): string | null {
  // Pattern 1: Quoted path after redirect (handles Codex's escaped quotes)
  // Matches: > "/path/to/file" or > \"/path/to/file\"
  const quotedPathMatch = command.match(/>\s*\\?"([^"]+)"/);
  if (quotedPathMatch?.[1] && quotedPathMatch[1] !== '/dev/null') {
    return quotedPathMatch[1];
  }

  // Pattern 2: Direct redirect - extract path after > or >>. This also
  // covers redirects nested in shell -c/-lc command strings.
  // Guard against non-shell uses like JavaScript arrow functions (=>).
  const directRedirectMatch = command.match(/(?:^|[^=<>])>{1,2}\s*([^\s;|&"'>=][^\s;|&"'>]*)/);
  if (directRedirectMatch?.[1] && directRedirectMatch[1] !== '/dev/null') {
    return directRedirectMatch[1];
  }

  // Pattern 3: PowerShell Out-File with -FilePath or -Path parameter
  // Matches: | Out-File -FilePath 'path' or | Out-File -Path "path"
  const outFileParamMatch = command.match(/Out-File\s+-(?:File)?Path\s+['"]([^'"]+)['"]/i);
  if (outFileParamMatch?.[1]) {
    return outFileParamMatch[1];
  }

  // Pattern 4: PowerShell Out-File with positional path (no -FilePath flag)
  // Matches: | Out-File 'path' or | Out-File "path"
  // Must not match -FilePath or -Encoding etc.
  const outFilePosMatch = command.match(/Out-File\s+['"]([^'"]+)['"]/i);
  if (outFilePosMatch?.[1] && !command.match(/Out-File\s+-\w/i)) {
    return outFilePosMatch[1];
  }

  // Pattern 5: PowerShell Set-Content or Add-Content with -Path parameter
  // Matches: | Set-Content -Path 'path' or | Add-Content -Path "path"
  const setContentMatch = command.match(/(?:Set|Add)-Content\s+-Path\s+['"]([^'"]+)['"]/i);
  if (setContentMatch?.[1]) {
    return setContentMatch[1];
  }

  // Pattern 6: PowerShell Set-Content/Add-Content with escaped quotes (inside powershell.exe -Command "...")
  // When Codex wraps PS commands: powershell.exe -Command "Set-Content -Path \"C:\path\file\" -Value ..."
  // The -Path value uses escaped quotes \" which don't match Pattern 6's ['"] anchors.
  // This is a REQUIRED fallback: in the Codex agent context, PowerShell AST parsing
  // may be unavailable (isPowerShellAvailable() returns false), so extractPowerShellWriteTarget()
  // returns null and this regex is the only path extraction mechanism.
  const setContentEscapedMatch = command.match(/(?:Set|Add)-Content\s+-Path\s+\\"([^"]+)\\"/i);
  if (setContentEscapedMatch?.[1]) {
    return setContentEscapedMatch[1];
  }

  // Pattern 8: PowerShell Out-File with escaped quotes (same wrapper scenario)
  const outFileEscapedMatch = command.match(/Out-File\s+-(?:File)?Path\s+\\"([^"]+)\\"/i);
  if (outFileEscapedMatch?.[1]) {
    return outFileEscapedMatch[1];
  }

  return null;
}

/**
 * Check if a command looks like it might be trying to write files.
 * Used to provide better error messages when write detection fails.
 */
export function looksLikePotentialWrite(command: string): boolean {
  // Shell redirects at token boundaries (avoid matching JS arrows like =>)
  const hasRedirectToken = /(?:^|[\s;|&()])\d*>>?(?![=>])/.test(command);
  // Common PowerShell write cmdlets
  const hasPowerShellWriteCmdlet = /(?:Out-File|Set-Content|Add-Content)\b/i.test(command);
  return hasRedirectToken || hasPowerShellWriteCmdlet;
}

/**
 * Get a helpful hint based on comparing target path to plans folder path.
 * Detects common mistakes and provides actionable guidance.
 */
export function getPathHint(targetPath: string, plansFolderPath: string, dataFolderPath?: string): string | null {
  const normalizedTarget = targetPath.replace(/\\/g, '/').toLowerCase();
  const normalizedPlans = plansFolderPath.replace(/\\/g, '/').toLowerCase();

  // Case: Writing to session folder but missing /plans/ or /data/
  if (normalizedTarget.includes('/sessions/') && !normalizedTarget.includes('/plans/') && !normalizedTarget.includes('/data/')) {
    return 'Hint: Write to the /plans/ or /data/ subfolder, not the session folder directly.';
  }

  // Case: Wrong session ID (use lowercase for comparison)
  const targetSessionMatch = normalizedTarget.match(/sessions\/([^/]+)/);
  const plansSessionMatch = normalizedPlans.match(/sessions\/([^/]+)/);
  if (targetSessionMatch && plansSessionMatch && targetSessionMatch[1] !== plansSessionMatch[1]) {
    // Get the original casing from plansFolderPath for display
    const originalSessionMatch = plansFolderPath.replace(/\\/g, '/').match(/sessions\/([^/]+)/);
    return `Hint: Wrong session ID. Current session is "${originalSessionMatch?.[1] ?? plansSessionMatch[1]}".`;
  }

  // Case: Writing to workspace root instead of session
  if (normalizedTarget.includes('/.craft-agent/workspaces/') && !normalizedTarget.includes('/sessions/')) {
    return 'Hint: Write to the session plans or data folder, not the workspace root.';
  }

  // Case: Writing outside .craft-agent entirely
  if (!normalizedTarget.includes('/.craft-agent/')) {
    return 'Hint: Files must be written to the session plans or data folder. Use plansFolderPath or dataFolderPath from <session_state>.';
  }

  return null;
}
