
// ============================================================
// Dangerous Cmdlets and Patterns
// ============================================================

/**
 * Cmdlets that are dangerous because they write to the filesystem or execute code.
 */
const DANGEROUS_CMDLETS = new Set([
  // File writing
  'out-file',
  'set-content',
  'add-content',
  'new-item',
  'copy-item',
  'move-item',
  'remove-item',
  'rename-item',
  'clear-content',

  // Code execution
  'invoke-expression',
  'iex',
  'invoke-command',
  'icm',
  'start-process',
  'start',
  'saps',

  // Script execution
  'invoke-item',
  'ii',

  // Downloading with output
  'invoke-webrequest',
  'iwr',
  'invoke-restmethod',
  'irm',

  // Registry modification
  'set-itemproperty',
  'new-itemproperty',
  'remove-itemproperty',

  // Service/process modification
  'stop-process',
  'kill',
  'stop-service',
  'start-service',
  'restart-service',
  'set-service',

  // Dangerous aliases
  'del',
  'rd',
  'rm',
  'rmdir',
  'erase',
  'ri',
  'mi',
  'ni',
  'sp',
]);

/**
 * Check if a cmdlet name is inherently dangerous.
 */
export function isDangerousCmdlet(cmdlet: string): boolean {
  return DANGEROUS_CMDLETS.has(cmdlet.toLowerCase());
}
