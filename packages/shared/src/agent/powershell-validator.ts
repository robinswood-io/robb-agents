/** PowerShell validation: parser process, AST policy and path extraction. */
export { setPowerShellValidatorRoot } from './powershell-validator/parser-location.ts';
export type { PowerShellValidationResult, SubcommandResult, PowerShellValidationReason } from './powershell-validator/ast-types.ts';
export { isPowerShellAvailable } from './powershell-validator/parser-process.ts';
export { validatePowerShellCommand } from './powershell-validator/ast-policy.ts';
export { looksLikePowerShell, unwrapPowerShellCommand } from './powershell-validator/command-syntax.ts';
export { extractPowerShellWriteTarget, extractPowerShellReadTarget } from './powershell-validator/path-extraction.ts';
