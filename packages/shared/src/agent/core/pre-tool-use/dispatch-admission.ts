import type { ToolEffectDescriptor } from "./contracts.ts";
import type { classifySensitiveExternalAction, contextualGmailReplyRecoveryReason } from "../sensitive-external-action.ts";
import { isBrowserToolNameOrAlias } from "../../browser-tool-names.ts";
import { shouldAllowToolInMode, getPermissionModeDiagnostics } from "../../mode-manager.ts";
import { type PermissionsContext } from "../../permissions-config.ts";
import { externalActionAuthorityPolicySegments, isSensitiveExternalActionConfirmationRequestedByObjective } from "../sensitive-external-action.ts";
import { checkObjectiveEvidenceBeforeMutation } from "../objective-evidence-gate.ts";
import { classifyReadOnlyRemoteObservationRepair } from "../registered-observation.ts";
import { classifyBrowserObjectiveAuthority } from "./browser-authority.ts";
import { isBrowserLifecycleCommand, resolveBrowserChannelDirective } from "./browser-channel.ts";
import type { PreToolUseCheckResult, PreToolUseInput } from "./contracts.ts";
import { readOnlyRemoteObservationRepairReason } from "./permission-context.ts";
import { BUILT_IN_MCP_SERVERS, REMOTE_COMMAND_TOOL_PATTERN } from "./tool-names.ts";

interface BrowserAdmissionInput {
  readonly policyCurrentUserRequest: string | undefined;
  readonly policyAuthorizationSegments: ReturnType<typeof externalActionAuthorityPolicySegments>;
}

export function checkBrowserChannelAdmission(
  snapshot: Pick<PreToolUseInput,
    | 'objectiveAuthorizationSegments'
    | 'toolName'
    | 'input'
    | 'onDebug'
  >,
  authority: BrowserAdmissionInput,
): PreToolUseCheckResult | undefined {
  const {
    objectiveAuthorizationSegments,
    toolName,
    input,
    onDebug,
  } = snapshot;
  const {
    policyCurrentUserRequest,
    policyAuthorizationSegments,
  } = authority;
  const browserChannelDirective = resolveBrowserChannelDirective(
    policyCurrentUserRequest,
    objectiveAuthorizationSegments === undefined ? undefined : policyAuthorizationSegments,
  );
  const browserToolCall = isBrowserToolNameOrAlias(toolName);
  const boundedBrowserHandoffObservation = browserChannelDirective === 'browser-handoff'
    && classifyBrowserObjectiveAuthority(toolName, input) === 'observational';
  if (browserToolCall
    && !isBrowserLifecycleCommand(input["command"])
    && (browserChannelDirective === 'non-browser'
      || browserChannelDirective === 'browser-handoff' && !boundedBrowserHandoffObservation)) {
    const reason = browserChannelDirective === 'browser-handoff'
      ? [
          'User channel constraint: the browser is authorized only for the explicit authentication handoff or final visual validation, not for operational work.',
          'Only a closed observational browser call is allowed in that bounded phase. Browser clicks, form input, uploads, evaluation and other mutations remain disabled; do not use the browser as an API or connector fallback.',
          'Continue the operation through the requested non-browser channel. Browser help/release/close/hide lifecycle commands remain available.',
        ].join(' ')
      : [
          'User channel constraint: the latest applicable human instruction explicitly excludes the browser/interface or binds this work to an API, connector, database, SSH, or server path.',
          'browser_tool is disabled for this turn. Continue without the browser through the requested non-browser channel when one is specified, and do not retry the browser fallback.',
          'A later explicit user instruction to use the browser can lift this constraint, including a bounded authentication handoff or final visual validation. Browser help/release/close/hide lifecycle commands remain available.',
        ].join(' ');
    onDebug?.(`User channel constraint: blocking ${toolName}`);
    return { type: 'block', reason };
  }
  return undefined;
}

interface ObjectiveAdmissionInput {
  readonly toolEffect: ToolEffectDescriptor;
  readonly sensitiveAction: ReturnType<typeof classifySensitiveExternalAction>;
  readonly browserObjectiveAuthority: ReturnType<typeof classifyBrowserObjectiveAuthority>;
  readonly effectivePermissionMode: ReturnType<typeof getPermissionModeDiagnostics>['permissionMode'];
  readonly sensitiveActionAuthorizedByObjective: boolean;
  readonly sensitiveActionHasUnresolvedRemoteScope: boolean;
  readonly sensitiveActionOtherwiseAuthorizedByObjective: boolean;
  readonly remoteObservationRepair: ReturnType<typeof classifyReadOnlyRemoteObservationRepair>;
  readonly contextualReplyRecovery: ReturnType<typeof contextualGmailReplyRecoveryReason>;
  readonly permissionsContext: PermissionsContext;
}

export function checkDispatchObjectiveAuthority(
  snapshot: Pick<PreToolUseInput,
    | 'toolName'
    | 'input'
    | 'objectiveMutationAuthorized'
    | 'objectiveSensitiveActionAuthorized'
    | 'objectiveAuthorizationSegments'
    | 'plansFolderPath'
    | 'dataFolderPath'
    | 'sessionId'
    | 'onDebug'
  >,
  authority: ObjectiveAdmissionInput,
): {
  readonly objectiveRequestsExactExternalConfirmation: boolean;
} | Extract<PreToolUseCheckResult, { type: 'block' }> {
  const {
    toolName,
    input,
    objectiveMutationAuthorized,
    objectiveSensitiveActionAuthorized,
    objectiveAuthorizationSegments,
    plansFolderPath,
    dataFolderPath,
    sessionId,
    onDebug,
  } = snapshot;
  const {
    toolEffect,
    sensitiveAction,
    browserObjectiveAuthority,
    effectivePermissionMode,
    sensitiveActionAuthorizedByObjective,
    sensitiveActionHasUnresolvedRemoteScope,
    sensitiveActionOtherwiseAuthorizedByObjective,
    remoteObservationRepair,
    contextualReplyRecovery,
    permissionsContext,
  } = authority;

  // ============================================================
  // 5. HIGH-STAKES EVIDENCE GATE
  // ============================================================
  const spawnSessionTool = /^(?:mcp__session__|session__)?spawn_session$/.test(toolName);
  const readOnlyReviewerSpawn = spawnSessionTool && input["role"] === 'reviewer'
    && (input["permissionMode"] === undefined || input["permissionMode"] === 'safe');
  const sendAgentMessageTool = /^(?:mcp__session__|session__)?send_agent_message$/.test(toolName);
  const objectiveCoordinationTool = /^(?:mcp__session__|session__)?(?:set_completion_criteria|update_plan|wait_sessions)$/.test(toolName)
    || readOnlyReviewerSpawn;
  const unprovenShellMutation = toolEffect.kind === 'unknown'
    && (toolName === 'Bash' || REMOTE_COMMAND_TOOL_PATTERN.test(toolName));
  const unknownExternalMutation = toolEffect.kind === 'unknown'
    && ((toolName.startsWith('mcp__') && !BUILT_IN_MCP_SERVERS.has(toolName.split('__')[1] ?? ''))
      || toolName.startsWith('api_') || toolName.includes('__api_'));
  const objectiveMutationBlocked = objectiveMutationAuthorized === false
    && (toolEffect.kind === 'local-write' || toolEffect.kind === 'external-mutation'
      || unprovenShellMutation || unknownExternalMutation || sensitiveAction !== null
      || spawnSessionTool && !readOnlyReviewerSpawn || sendAgentMessageTool
      || browserObjectiveAuthority === 'mutation-or-unknown')
    && !objectiveCoordinationTool;
  const sensitiveObjectiveAuthority = objectiveSensitiveActionAuthorized
    ?? objectiveMutationAuthorized;
  const objectiveRequestsExactExternalConfirmation = !!sensitiveAction
    && !!objectiveAuthorizationSegments
    && isSensitiveExternalActionConfirmationRequestedByObjective(
      sensitiveAction,
      objectiveAuthorizationSegments,
    );
  // An explicit "stop immediately before this exact action and ask" contract
  // may reach the host's scoped permission UI. It never authorizes execution
  // itself, and all other observational/forbidden mutations remain blocked.
  const exactExternalConfirmationCanSupplyAuthority = objectiveRequestsExactExternalConfirmation
    && effectivePermissionMode !== 'safe';
  const sensitiveActionBlocked = !!sensitiveAction && (sensitiveObjectiveAuthority === false
    || sensitiveObjectiveAuthority === true && !sensitiveActionAuthorizedByObjective);
  const objectiveAuthorityBlocksCurrentTool = objectiveMutationBlocked
    && !exactExternalConfirmationCanSupplyAuthority;
  const unresolvedExternalConfirmationCanSupplyAuthority = sensitiveActionHasUnresolvedRemoteScope
    && sensitiveActionOtherwiseAuthorizedByObjective
    && sensitiveObjectiveAuthority !== false
    && effectivePermissionMode !== 'safe'
    && !remoteObservationRepair;
  const sensitiveAuthorityBlocksCurrentTool = !!contextualReplyRecovery || sensitiveActionBlocked
    && !exactExternalConfirmationCanSupplyAuthority
    && !unresolvedExternalConfirmationCanSupplyAuthority;
  if ((objectiveAuthorityBlocksCurrentTool || sensitiveAuthorityBlocksCurrentTool) && remoteObservationRepair) {
    return {
      type: 'block',
      reason: readOnlyRemoteObservationRepairReason(remoteObservationRepair),
    };
  }
  if (objectiveAuthorityBlocksCurrentTool) {
    return {
      type: 'block',
      reason: 'Objective authority: the current accepted user objective is observational or response-only and does not authorize an external mutation. Continue with reads or answer from the evidence already gathered; do not request broader permission or treat this as a policy blocker.',
    };
  }
  if (sensitiveAuthorityBlocksCurrentTool) {
    return {
      type: 'block',
      reason: contextualReplyRecovery
        ?? 'Objective authority: the current accepted human objective does not explicitly authorize this sensitive external action and its exact target. Continue only with the authorized local work or target; do not request broader permission or treat this as a policy blocker.',
    };
  }

  // Typed reads remain available for evidence acquisition. Every known
  // mutation, plus an unknown external MCP/API effect, is fail-closed: a tool
  // name containing `search`, `check`, or another read-like token is not proof
  // that invoking it is observational.
  if (toolEffect.kind !== 'read') {
    const safeModeDecision = shouldAllowToolInMode(
      toolName,
      input,
      'safe',
      { ...(plansFolderPath !== undefined ? { plansFolderPath } : {}), ...(dataFolderPath !== undefined ? { dataFolderPath } : {}), permissionsContext },
    );
    const unknownExternalEffect = toolEffect.kind === 'unknown' && (
      (toolName.startsWith('mcp__') && !BUILT_IN_MCP_SERVERS.has(toolName.split('__')[1] ?? ''))
      || toolName.startsWith('api_')
      || toolName.includes('__api_')
    );
    if (
      toolEffect.kind === 'local-write'
      || toolEffect.kind === 'external-mutation'
      || unknownExternalEffect
      || !safeModeDecision.allowed
    ) {
      const bypassEvidenceGate = objectiveMutationAuthorized === undefined
        && objectiveAuthorizationSegments !== undefined
        && process.env["ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT"] !== '1';
      const evidenceDecision = (readOnlyReviewerSpawn || bypassEvidenceGate)
        ? { allowed: true as const }
        : checkObjectiveEvidenceBeforeMutation(sessionId, toolName, toolEffect.kind);
      if (!evidenceDecision.allowed) {
        onDebug?.(`Objective evidence gate: blocking ${toolName}`);
        return { type: 'block', reason: evidenceDecision.reason };
      }
    }
  }
  return {
    objectiveRequestsExactExternalConfirmation,
  };
}
