/// <reference path="../../types/incr-regex-package.d.ts" />
import { type PermissionMode, PERMISSION_MODE_CONFIG, toCanonicalPermissionMode } from "../mode-types.ts";
import { consumeUserModeSignal, getPermissionMode, getPermissionModeDiagnostics } from './state-api.ts';

// ============================================================
// Session State Context (for user messages)
// ============================================================

/**
 * Get the current session state for prompt injection
 */
export function getSessionState(sessionId: string): { permissionMode: PermissionMode } {
  return {
    permissionMode: getPermissionMode(sessionId),
  };
}

/**
 * Format session state as a lightweight XML block for injection into user messages.
 * Always includes the plans folder path so agent knows where plans are stored.
 */
export function formatSessionState(
  sessionId: string,
  options?: { plansFolderPath?: string; dataFolderPath?: string; consumeModeChangeUserSignal?: boolean }
): string {
  const diagnostics = getPermissionModeDiagnostics(sessionId);

  // Use canonical user-facing mode tokens to avoid terminology drift.
  const modeName = toCanonicalPermissionMode(diagnostics.permissionMode);
  let result = `<session_state>\nsessionId: ${sessionId}\npermissionMode: ${modeName}`;

  if (diagnostics.transitionDisplay) {
    result += `\nmodeTransition: ${diagnostics.transitionDisplay}`;
  }
  result += `\nmodeChangedBy: ${diagnostics.lastChangedBy}`;
  result += `\nmodeChangedAt: ${diagnostics.lastChangedAt}`;
  result += `\nmodeVersion: ${diagnostics.modeVersion}`;

  const transitionLabel = diagnostics.transitionDisplay ?? `Unknown -> ${PERMISSION_MODE_CONFIG[diagnostics.permissionMode].displayName}`;
  result += `\nmodeChangeSummary: Last mode change by ${diagnostics.lastChangedBy} at ${diagnostics.lastChangedAt} (${transitionLabel}, modeVersion=${diagnostics.modeVersion})`;

  if (diagnostics.userModeSignalPending) {
    result += '\nmodeChangeUserSignal: The user changed mode manually. Apply this mode immediately for this turn.';

    if (options?.consumeModeChangeUserSignal) {
      consumeUserModeSignal(sessionId);
    }
  }

  // Always include plans folder path so agent knows where plans are stored
  if (options?.plansFolderPath) {
    result += `\nplansFolderPath: ${options.plansFolderPath}`;
  }

  // Include data folder path so agent knows where transform_data output goes
  if (options?.dataFolderPath) {
    result += `\ndataFolderPath: ${options.dataFolderPath}`;
  }

  result += '\n</session_state>';
  return result;
}
