import { debug } from "../../utils/debug.ts";

// ============================================================
// Module Root (set at Electron startup)
// ============================================================

/**
 * Module-level root directory for the PowerShell parser script.
 * Set once at Electron startup via setPowerShellValidatorRoot(__dirname).
 */
export let _validatorRoot: string | undefined;

/**
 * Register the directory containing the PowerShell parser script.
 * Call this once at app startup: setPowerShellValidatorRoot(join(__dirname, 'resources'))
 *
 * After this, the validator will look for powershell-parser.ps1 in this directory.
 */
export function setPowerShellValidatorRoot(dir: string): void {
  _validatorRoot = dir;
  debug('[PowerShellValidator] Root set to:', dir);
}
