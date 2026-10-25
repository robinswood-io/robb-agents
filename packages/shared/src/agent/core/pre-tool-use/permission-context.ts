import { getPermissionModeDiagnostics, PERMISSION_MODE_CONFIG, type PermissionMode } from "../../mode-manager.ts";
import { type ReadOnlyRemoteObservationRepair } from "../registered-observation.ts";

/**
 * Centralized PreToolUse pipeline.
 *
 * Synchronous except for the final result — all async work (source activation,
 * user prompting) is handled by the calling agent based on the result type.
 *
 * Pipeline:
 * 1. Permission mode check (shouldAllowToolInMode)
 * 2. Source blocking (inactive MCP sources)
 * 3. Prerequisite check (guide.md before source tools)
 * 4. call_llm interception
 * 5. Input transforms (paths, config validation, skills, metadata)
 * 6. Sensitive external-action confirmation (all non-safe modes, before whitelists)
 * 7. Ask-mode prompt decision
 *
 * @returns A discriminated union that the agent translates to its SDK format
 */
export function withPermissionModeContext(reason: string, sessionId: string, effectiveMode: PermissionMode): string {
  if (reason.includes('Effective mode:')) return reason;

  const diagnostics = getPermissionModeDiagnostics(sessionId);
  const modeDisplayName = PERMISSION_MODE_CONFIG[effectiveMode]?.displayName ?? effectiveMode;
  return [
    reason,
    '',
    `Effective mode: ${modeDisplayName}`,
    `Last mode change: ${diagnostics.lastChangedBy} at ${diagnostics.lastChangedAt} (modeVersion=${diagnostics.modeVersion})`,
  ].join('\n');
}

export function readOnlyRemoteObservationRepairReason(repair: ReadOnlyRemoteObservationRepair): string {
  if (repair === 'git-hardening') {
    return [
      'Objective authority could not prove this Git inspection read-only because repository configuration can execute filesystem, hook, pager, formatting, or signature helpers; this is a recoverable invocation issue, not a request for broader user permission.',
      'Retry the same supported read-only Git operation with the exact prefix `git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c log.showSignature=false -c format.pretty=medium --no-pager`.',
      'Use only the supported metadata/search operations (rev-parse, branch --show-current, merge-base, ls-files, grep, or non-patch log). Git status, diff, show and patch/stat log output remain blocked because repository attributes and filters can execute helpers; inspect worktree state or content with target-bound Read/rg/cmp instead. Do not add other Git configuration, pager, formatting, or helper options.',
    ].join(' ');
  }
  if (repair === 'split-composite') {
    return [
      'Objective authority could not prove this composite remote command read-only because its loop or compound shell shape leaves the effective scope unresolved; this is a recoverable command-shape issue, not a request for broader user permission.',
      'Retry by splitting it into separate `ssh_execute` calls, each containing one literal read-only inspection. Expand loops into individual literal `test`/`ls` checks and avoid mixing fallback control flow with the observation.',
    ].join(' ');
  }
  return [
    'Objective authority cannot prove that this opaque remote validation script is read-only or bound to the authorized project; this is a recoverable evidence-shape issue, not missing SSH credentials or a request for broader user permission.',
    'Do not run the script through another host or fallback channel. Replace it with direct, literal `ssh_execute` observations of the same target, one supported read-only command per call, or register and run the exact target-bound checks individually.',
  ].join(' ');
}
