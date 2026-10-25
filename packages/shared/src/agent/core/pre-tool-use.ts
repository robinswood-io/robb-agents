/**
 * Shared PreToolUse utilities and centralized PreToolUse pipeline.
 *
 * Individual utility functions (path expansion, skill qualification, etc.)
 * are used by the centralized `runPreToolUseChecks()` pipeline, which both
 * agent backends (Claude and Pi) call with normalized input and then translate
 * the result to their SDK-specific format. Pi hosts non-Anthropic model
 * providers (OpenAI, GitHub Copilot, Bedrock, etc.) under a single backend,
 * so they inherit this pipeline transparently.
 *
 * Pipeline steps:
 * 1. Permission mode check: Block tools disallowed by current mode
 * 2. Source blocking: Block tools from inactive MCP sources
 * 3. Prerequisite check: Block source tools until guide.md is read
 * 4. call_llm detection: Intercept mcp__session__call_llm
 * 5. Input transforms: Path expansion, config validation, skill qualification, metadata stripping
 * 6. Ask-mode prompt decision: Determine if user approval is needed
 */
import { setContextualGmailBrowserMutationGuard } from "../browser-tool-runtime.ts";
import { isBrowserToolNameOrAlias } from "../browser-tool-names.ts";
import { yoloHumanHandoffBlock } from "../yolo-policy.ts";
import { isProtectedApplicationPath, APPLICATION_PROTECTION_REASON } from "@craft-agent/session-tools-core";
import { resolve } from "node:path";
import { expandPath } from "../../utils/paths.ts";
import { shouldAllowToolInMode, getPermissionModeDiagnostics } from "../mode-manager.ts";
import { type PermissionsContext } from "../permissions-config.ts";
import { contextualGmailTargetScopedAuthorizationSegments, externalActionAuthorityPolicySegments, hasContextualGmailReplyMention, hasUnresolvedRemoteScopeTarget, hasUnresolvedSensitiveExternalActionTarget, isSensitiveExternalActionAuthorizedByObjective, isSensitiveExternalActionConfirmationRequestedByObjective, isSensitiveExternalActionOtherwiseAuthorizedByObjective } from "./sensitive-external-action.ts";
import { checkObjectiveEvidenceBeforeMutation } from "./objective-evidence-gate.ts";
import { classifyReadOnlyRemoteObservationRepair, classifyNestedSshReadOnlyRemoteObservationRepair, containsLocalSshTransportInvocation } from "./registered-observation.ts";
import { classifyBrowserObjectiveAuthority } from "./pre-tool-use/browser-authority.ts";
import { isBrowserLifecycleCommand, resolveBrowserChannelDirective } from "./pre-tool-use/browser-channel.ts";
import type { PreToolUseCheckResult, PreToolUseInput } from "./pre-tool-use/contracts.ts";
import { hashSensitiveExternalActionOperation } from "./pre-tool-use/external-action-hash.ts";
import { explicitlyNamesGmailBrowserMutation, explicitlyNamesNonCanonicalContextualGmailMutation, isBrowserKeyboardText } from "./pre-tool-use/gmail-channel.ts";
import { contextualGmailObjectiveFingerprint } from "./pre-tool-use/gmail-evidence.ts";
import type { ContextualGmailToolUseClaim } from "./pre-tool-use/gmail-state.ts";
import { CONTEXTUAL_GMAIL_BOUND_REPLY_TOOLS, CONTEXTUAL_GMAIL_PREFLIGHT_TOOLS, contextualGmailPreflightAttestations, contextualGmailSessionsPendingFinalCleanup, contextualGmailToolUseClaims, inFlightContextualGmailReplies, pendingContextualGmailPreflights } from "./pre-tool-use/gmail-state.ts";
import { stripToolMetadata } from "./pre-tool-use/input-transforms.ts";
import { readOnlyRemoteObservationRepairReason, withPermissionModeContext } from "./pre-tool-use/permission-context.ts";
import { TERMINAL_RECONCILIATION_CAPABILITY_FIELD, deriveTerminalReconciliationInvocationCapability } from "./pre-tool-use/terminal-reconciliation.ts";
import { BUILT_IN_MCP_SERVERS, FILE_WRITE_TOOLS, REMOTE_COMMAND_TOOL_PATTERN } from "./pre-tool-use/tool-names.ts";
import { checkExecutionPrerequisites } from "./pre-tool-use/execution-prerequisites.ts";
import { prepareToolInput } from "./pre-tool-use/tool-input-preparation.ts";
import { authorizePreparedTool } from "./pre-tool-use/tool-authorization.ts";
import { classifyToolAuthority } from "./pre-tool-use/tool-authority.ts";
import { evaluateGmailAuthority } from './pre-tool-use/gmail-authority.ts';

export function runPreToolUseChecks(ctx: PreToolUseInput): PreToolUseCheckResult {
  const {
    toolName,
    input,
    sessionId,
    toolUseId,
    runtimeId,
    sourceActivationReentry = false,
    permissionApprovalReentry = false,
    permissionMode,
    workspaceRootPath,
    workspaceId,
    plansFolderPath,
    dataFolderPath,
    workingDirectory,
    executionIsolation,
    missionCapabilityLock,
    activeSourceSlugs,
    allSourceSlugs,
    hasSourceActivation,
    externalActionPolicy = 'confirm',
    objectiveMutationAuthorized,
    objectiveSensitiveActionAuthorized,
    objectiveAuthorizationSegments,
    authenticatedUserAuthorizationSegments,
    objectiveTerminalReconciliationPolicy,
    permissionManager,
    prerequisiteManager,
    preloadedSourceGuidePaths,
    backendMetadata,
    currentUserRequest,
    onDebug,
  } = ctx;

  const handoffBlock = yoloHumanHandoffBlock(
    toolName, getPermissionModeDiagnostics(sessionId).permissionMode, externalActionPolicy, ctx.humanInputAllowed,
  );
  if (handoffBlock) return { type: 'block', reason: handoffBlock };

  // Build permissions context for custom permissions.json rules
  const permissionsContext: PermissionsContext = {
    workspaceRootPath,
    activeSourceSlugs,
  };
  const acceptedAuthorizationSegments = objectiveAuthorizationSegments !== undefined
    ? objectiveAuthorizationSegments
    : currentUserRequest ? [currentUserRequest] : [];
  const isProviderDrivenAutonomy = objectiveMutationAuthorized === undefined
    && objectiveAuthorizationSegments !== undefined
    && process.env.ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT !== '1';
  // Closed structured Gmail bodies are payload data. Preserve the raw view
  // only for exact Gmail payload/fingerprint checks; every other authority,
  // channel and remote-scope classifier consumes this policy-safe view.
  const policyAuthorizationSegments = externalActionAuthorityPolicySegments(
    acceptedAuthorizationSegments,
  );
  const targetScopedContextualGmailSegments = contextualGmailTargetScopedAuthorizationSegments(
    policyAuthorizationSegments,
    authenticatedUserAuthorizationSegments ?? [],
    toolName,
    input,
  );
  const policyCurrentUserRequest = currentUserRequest === undefined
    ? undefined
    : externalActionAuthorityPolicySegments([currentUserRequest])[0];
  const contextualGmailPreflightTool = CONTEXTUAL_GMAIL_PREFLIGHT_TOOLS.has(toolName);
  const contextualGmailBoundTool = CONTEXTUAL_GMAIL_BOUND_REPLY_TOOLS.has(toolName);
  const contextualGmailLifecycleTool = contextualGmailPreflightTool || contextualGmailBoundTool;
  if (contextualGmailLifecycleTool
    && contextualGmailSessionsPendingFinalCleanup.has(sessionId)) {
    return {
      type: 'block',
      reason: 'Validation failed: this session is being permanently destroyed. No new Gmail preflight or bound reply may start while its exact runtime cleanup is pending.',
    };
  }
  if (contextualGmailPreflightTool && !toolUseId) {
    return {
      type: 'block',
      reason: 'Validation failed: a Gmail reply preflight requires one host-issued toolUseId so its result can be correlated without invalidating or replacing existing exact-once authority. Retry through the canonical connector call; do not use another send path or browser fallback.',
    };
  }
  if (contextualGmailBoundTool && !toolUseId) {
    return {
      type: 'block',
      reason: 'Validation failed: a bound Gmail reply requires one host-issued toolUseId so its signed preflight attestation can be reserved and consumed exactly once. Retry through the canonical connector call; do not use another send path or browser fallback.',
    };
  }
  let contextualGmailToolUseClaim: ContextualGmailToolUseClaim | undefined;
  if (contextualGmailLifecycleTool && toolUseId) {
    const claimKey = `${sessionId}:${toolUseId}`;
    const objectiveFingerprint = contextualGmailObjectiveFingerprint(acceptedAuthorizationSegments);
    const operationHash = hashSensitiveExternalActionOperation(toolName, input);
    const existingClaim = contextualGmailToolUseClaims.get(claimKey);
    const validSourceActivationReentry = sourceActivationReentry
      && existingClaim?.phase === 'awaiting-source-reentry'
      && !existingClaim.sourceActivationReentryConsumed
      && existingClaim.toolName === toolName
      && existingClaim.operationHash === operationHash
      && existingClaim.objectiveFingerprint === objectiveFingerprint;
    const validPermissionApprovalReentry = permissionApprovalReentry
      && !!existingClaim
      && (existingClaim.phase === 'claimed' || existingClaim.phase === 'admitted')
      && existingClaim.toolName === toolName
      && existingClaim.operationHash === operationHash
      && existingClaim.objectiveFingerprint === objectiveFingerprint;
    if (!existingClaim) {
      contextualGmailToolUseClaim = {
        objectiveFingerprint,
        operationHash,
        phase: 'claimed',
        sourceActivationReentryConsumed: false,
        toolName,
      };
      contextualGmailToolUseClaims.set(claimKey, contextualGmailToolUseClaim);
    } else if (validSourceActivationReentry) {
      existingClaim.phase = 'claimed';
      existingClaim.sourceActivationReentryConsumed = true;
      contextualGmailToolUseClaim = existingClaim;
    } else if (validPermissionApprovalReentry) {
      contextualGmailToolUseClaim = existingClaim;
    } else {
      existingClaim.phase = 'poisoned';
      pendingContextualGmailPreflights.delete(claimKey);
      contextualGmailPreflightAttestations.delete(sessionId);
      const collidingInFlight = inFlightContextualGmailReplies.get(sessionId);
      if (collidingInFlight?.toolUseId === toolUseId) collidingInFlight.poisoned = true;
      return {
        type: 'block',
        reason: 'Validation failed: this host-issued Gmail lifecycle toolUseId was already claimed. The id is now poisoned because delayed terminal results cannot be attributed to one occurrence; use a new canonical tool call id after any in-flight reply reaches a terminal result or the runtime is safely restarted.',
      };
    }
  }
  const inFlightContextualGmailReply = contextualGmailLifecycleTool
    ? inFlightContextualGmailReplies.get(sessionId)
    : undefined;
  if (inFlightContextualGmailReply
    && !(permissionApprovalReentry && inFlightContextualGmailReply.toolUseId === toolUseId
      && inFlightContextualGmailReply.toolName === toolName
      && inFlightContextualGmailReply.operationHash
        === hashSensitiveExternalActionOperation(toolName, input))) {
    return {
      type: 'block',
      reason: contextualGmailPreflightTool
        ? 'Validation failed: another bound Gmail reply is still in flight for this session. Wait for its terminal host result, then run one fresh canonical preflight; an absence check made while the prior mutation is unresolved cannot authorize a later reply.'
        : 'Validation failed: another bound Gmail reply is still in flight for this session. Wait for its terminal host result before attempting any later reply; do not start a second mutation or use another send path.',
    };
  }

  const toolAuthority = classifyToolAuthority({
    input,
    toolName,
    dataFolderPath,
    authenticatedUserAuthorizationSegments,
    objectiveTerminalReconciliationPolicy,
    sessionId,
  }, ctx, permissionsContext, policyAuthorizationSegments);
  if ('type' in toolAuthority) return toolAuthority;
  const {
    shellCommand,
    boundedStructuredRemoteTechnicalUploadLocalPath,
    boundedStructuredRemoteTechnicalUpload,
    boundedResumedSharePointCreation,
    rejectedTargetBoundStructuredRemoteTechnicalRead,
    toolEffect,
    sensitiveAction,
    boundedOrionWorktreeCommand,
  } = toolAuthority;
  const browserChannelDirective = resolveBrowserChannelDirective(
    policyCurrentUserRequest,
    objectiveAuthorizationSegments === undefined ? undefined : policyAuthorizationSegments,
  );
  const browserToolCall = isBrowserToolNameOrAlias(toolName);
  const boundedBrowserHandoffObservation = browserChannelDirective === 'browser-handoff'
    && classifyBrowserObjectiveAuthority(toolName, input) === 'observational';
  if (browserToolCall
    && !isBrowserLifecycleCommand(input.command)
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

  const gmailAuthority = evaluateGmailAuthority({
    sessionId,
    toolName,
    input,
    dataFolderPath,
  }, {
    acceptedAuthorizationSegments,
    targetScopedContextualGmailSegments,
    contextualGmailPreflightTool,
    policyAuthorizationSegments,
    sensitiveAction,
  });
  if ('type' in gmailAuthority) return gmailAuthority;
  const {
    contextualGmailObjective,
    eligibleContextualGmailPreflight,
    contextualGmailPreflightAttestation,
    structuredGmailSendDecision,
    contextualGmailPolicySegments,
    contextualReplyRecovery,
    contextualReplyAuthorizedByObjective,
  } = gmailAuthority;
  const uploadRequiresBoundedObjectiveAuthority = toolName === 'mcp__rbw-servers__ssh_upload'
    && !!dataFolderPath;
  const sensitiveActionAuthorizedByObjective = sensitiveAction
    ? !contextualReplyRecovery && (
      boundedStructuredRemoteTechnicalUpload && sensitiveAction.category !== 'secret_transfer'
      || boundedOrionWorktreeCommand
      || boundedResumedSharePointCreation
      || !uploadRequiresBoundedObjectiveAuthority && (structuredGmailSendDecision === 'authorized'
        || structuredGmailSendDecision === 'not-applicable' && (
        isSensitiveExternalActionAuthorizedByObjective(
          sensitiveAction,
          policyAuthorizationSegments,
          authenticatedUserAuthorizationSegments,
        ) || contextualReplyAuthorizedByObjective
      )))
    : false;
  const sensitiveActionHasUnresolvedRemoteScope = !!sensitiveAction
    && hasUnresolvedRemoteScopeTarget(sensitiveAction);
  const sensitiveActionHasUnresolvedTarget = !!sensitiveAction
    && hasUnresolvedSensitiveExternalActionTarget(sensitiveAction);
  const sensitiveActionOtherwiseAuthorizedByObjective = !!sensitiveAction
    && isSensitiveExternalActionOtherwiseAuthorizedByObjective(
      sensitiveAction,
      policyAuthorizationSegments,
    );
  const browserObjectiveAuthority = classifyBrowserObjectiveAuthority(toolName, input);
  const contextualGmailReplyMentioned = hasContextualGmailReplyMention(
    contextualGmailPolicySegments,
  );
  setContextualGmailBrowserMutationGuard(sessionId, contextualGmailReplyMentioned);

  // Catch only an explicitly Gmail-targeted browser fallback before execution.
  // Generic words such as "send" also occur in ticket/CMS UIs. Opaque and
  // generic refs are checked by browser-tool-runtime against the actual
  // session-bound URL, so unrelated form/CMS mutations remain available.
  if (browserObjectiveAuthority === 'mutation-or-unknown'
    && contextualGmailReplyMentioned
    && explicitlyNamesGmailBrowserMutation(input.command)) {
    return {
      type: 'block',
      reason: 'Validation failed: this accepted objective contains a contextual Gmail reply, so an explicit Gmail/send/reply browser mutation cannot be used as a fallback. Continue with read-only browser inspection if needed, then use only gmail_reply_preflight + gmail_reply_bound or gmail_reply_all_preflight + gmail_reply_all with their signed closed payload.',
    };
  }

  if (contextualGmailReplyMentioned
    && explicitlyNamesNonCanonicalContextualGmailMutation(toolName, input, toolEffect)) {
    return {
      type: 'block',
      reason: 'Validation failed: this accepted objective contains a contextual Gmail reply, so Gmail/email send or reply mutations through Bash, scripts, APIs, or non-canonical MCP tools are disabled. Use the successful Gmail read plus only gmail_reply_preflight + gmail_reply_bound or gmail_reply_all_preflight + gmail_reply_all with the signed closed payload.',
    };
  }

  // Host invariant, before modes, whitelists, trusted-source hints or objective gates.
  // The kernel sandbox is the boundary for scripts/obfuscated commands; this gives
  // direct file tools a useful explanation and also covers host-side MCP handlers.
  if (toolEffect.kind !== 'read' || FILE_WRITE_TOOLS.has(toolName)) {
    const targets = [
      input.file_path,
      input.path,
      input.notebook_path,
      input.destination,
      input.outputFile,
      input.localPath,
    ];
    for (const target of targets) {
      if (typeof target === 'string' && isProtectedApplicationPath(resolve(workingDirectory ?? workspaceRootPath, expandPath(target)))) {
        return { type: 'block', reason: APPLICATION_PROTECTION_REASON };
      }
    }
  }

  // Once this exact server has inherited the objective's technical read
  // authority, the payload must satisfy the complete host-owned grammar. Do
  // not let broader mutation authority, Execute mode, or trusted/readOnly MCP
  // annotations turn a malformed path, destination, session shape, or hidden
  // field into an allowed call. An unrelated objective remains on the normal
  // effect/permission path rather than being captured by this exception.
  if (!isProviderDrivenAutonomy && rejectedTargetBoundStructuredRemoteTechnicalRead) {
    return {
      type: 'block',
      reason: 'Structured SSH read validation failed: this session, download, source read, loopback route/port, image, manifest, or compose target is not positively and exactly bound to the current human objective. Use only the documented fields and the explicitly named server/project; redirects, sibling projects, secret-like paths, local SSH, browser fallback, and broader destinations remain blocked.',
    };
  }

  // A fully redacted multi-category operation provides neither an inspectable
  // command nor a concrete target for informed consent. Never turn it into an
  // opaque prompt (or an Execute-policy auto-allow); require the agent to split
  // it into separately classifiable operations first.
  if (!isProviderDrivenAutonomy && sensitiveAction?.requiresInspectableSplit) {
    return {
      type: 'block',
      reason: 'Sensitive compound operation is not inspectable as one action. Split it into separate operations with a concrete target for each, then request authorization for each operation independently.',
    };
  }

  // Diagnose repairable read-only remote command shapes before permission
  // modes and objective gates return. This changes only the refusal reason;
  // the unsupported invocation remains blocked at every boundary.
  const observationRepairCandidate = shellCommand
    ? classifyReadOnlyRemoteObservationRepair(shellCommand)
    : undefined;
  const nestedSshObservationRepair = shellCommand
    ? classifyNestedSshReadOnlyRemoteObservationRepair(shellCommand)
    : undefined;
  const localSshTransport = !!shellCommand
    && /(?:^|[_:.])(?:bash|shell|exec_command)(?:$|[_:.])/i.test(toolName)
    && containsLocalSshTransportInvocation(shellCommand);
  const remoteObservationRepair = REMOTE_COMMAND_TOOL_PATTERN.test(toolName)
    ? observationRepairCandidate
    : /(?:^|[_:.])(?:bash|shell|exec_command)(?:$|[_:.])/i.test(toolName)
        && (nestedSshObservationRepair || observationRepairCandidate === 'git-hardening')
      ? nestedSshObservationRepair ?? observationRepairCandidate
      : undefined;
  if (!isProviderDrivenAutonomy && localSshTransport) {
    const repairGuidance = nestedSshObservationRepair
      ? `${readOnlyRemoteObservationRepairReason(nestedSshObservationRepair)} `
      : '';
    return {
      type: 'block',
      reason: `${repairGuidance}Local SSH transport through Bash/shell is disabled. Use the configured ssh_execute tool for the exact server and remote command. Do not bypass a structured SSH refusal through local Bash/ssh; keep the server, working directory, command, and audit trail in the registered ssh_execute transport.`,
    };
  }
  // A recoverable remote observation is, by definition, outside the closed
  // host read grammar. Block it before Execute mode or a broad workspace
  // allowlist can turn the diagnostic into an implicit grant. Commands that
  // already satisfy the read grammar never produce a repair classification.
  if (!isProviderDrivenAutonomy
    && REMOTE_COMMAND_TOOL_PATTERN.test(toolName)
    && remoteObservationRepair
    && toolEffect.kind !== 'read'
    && !(sensitiveAction?.boundedRemoteImplementationLifecycle === true
      && sensitiveActionAuthorizedByObjective)) {
    return {
      type: 'block',
      reason: readOnlyRemoteObservationRepairReason(remoteObservationRepair),
    };
  }

  // Canonical mode source of truth for this session.
  // Keep incoming permissionMode only for mismatch diagnostics.
  const diagnostics = getPermissionModeDiagnostics(sessionId);
  const effectivePermissionMode = diagnostics.permissionMode;

  if (permissionMode !== effectivePermissionMode) {
    onDebug?.(
      `[ModeSync] sessionId=${sessionId} incomingMode=${permissionMode} effectiveMode=${effectivePermissionMode} ` +
      `modeVersion=${diagnostics.modeVersion} changedBy=${diagnostics.lastChangedBy} changedAt=${diagnostics.lastChangedAt}`
    );
  }

  // ============================================================
  // 1. PERMISSION MODE CHECK
  // ============================================================
  if (isBrowserKeyboardText(toolName, input) && effectivePermissionMode === 'safe') {
    return { type: 'block', reason: withPermissionModeContext('Keyboard text delivery to a browser/remote receiver is blocked in Explore mode.', sessionId, effectivePermissionMode) };
  }

  const modeResult = toolEffect.kind === 'read'
    ? { allowed: true as const }
    : shouldAllowToolInMode(
      toolName,
      input,
      effectivePermissionMode,
      { plansFolderPath, dataFolderPath, permissionsContext }
    );

  if (!modeResult.allowed) {
    const reason = remoteObservationRepair
      ? readOnlyRemoteObservationRepairReason(remoteObservationRepair)
      : modeResult.reason;
    const reasonWithContext = withPermissionModeContext(reason, sessionId, effectivePermissionMode);
    onDebug?.(`Permission mode ${effectivePermissionMode}: blocking ${toolName} — ${reasonWithContext}`);
    return { type: 'block', reason: reasonWithContext };
  }

  const prerequisiteDecision = checkExecutionPrerequisites({
    executionIsolation,
    toolName,
    input,
    onDebug,
    workspaceRootPath,
    workingDirectory,
    missionCapabilityLock,
    activeSourceSlugs,
    allSourceSlugs,
    objectiveTerminalReconciliationPolicy,
    hasSourceActivation,
    prerequisiteManager,
    preloadedSourceGuidePaths,
  }, contextualGmailToolUseClaim);
  if (prerequisiteDecision) return prerequisiteDecision;

  // ============================================================
  // 5. HIGH-STAKES EVIDENCE GATE
  // ============================================================
  const spawnSessionTool = /^(?:mcp__session__|session__)?spawn_session$/.test(toolName);
  const readOnlyReviewerSpawn = spawnSessionTool && input.role === 'reviewer'
    && (input.permissionMode === undefined || input.permissionMode === 'safe');
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
      { plansFolderPath, dataFolderPath, permissionsContext },
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
        && process.env.ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT !== '1';
      const evidenceDecision = (readOnlyReviewerSpawn || bypassEvidenceGate)
        ? { allowed: true as const }
        : checkObjectiveEvidenceBeforeMutation(sessionId, toolName, toolEffect.kind);
      if (!evidenceDecision.allowed) {
        onDebug?.(`Objective evidence gate: blocking ${toolName}`);
        return { type: 'block', reason: evidenceDecision.reason };
      }
    }
  }

  // ============================================================
  // 6. CALL_LLM / SPAWN_SESSION INTERCEPTION
  // ============================================================
  if (toolName === 'mcp__session__call_llm') {
    return { type: 'call_llm_intercept', input };
  }
  if (toolName === 'mcp__session__spawn_session') {
    if (objectiveTerminalReconciliationPolicy) {
      const normalizedSpawnInput = stripToolMetadata(toolName, input, onDebug).input;
      const invocationCapability = deriveTerminalReconciliationInvocationCapability(
        objectiveTerminalReconciliationPolicy.invocationCapabilityKey,
        toolName,
        normalizedSpawnInput,
      );
      if (!invocationCapability) {
        return {
          type: 'block',
          reason: 'Terminal reconciliation could not bind this reviewer dispatch to the current host objective revision. No child was created.',
        };
      }
      return {
        type: 'spawn_session_intercept',
        input: {
          ...normalizedSpawnInput,
          [TERMINAL_RECONCILIATION_CAPABILITY_FIELD]: invocationCapability,
        },
      };
    }
    return { type: 'spawn_session_intercept', input };
  }

  const preparation = prepareToolInput({
    input,
    toolName,
    onDebug,
    workspaceRootPath,
    workingDirectory,
    workspaceId,
    objectiveTerminalReconciliationPolicy,
  }, ctx, toolEffect, boundedStructuredRemoteTechnicalUploadLocalPath);
  if (preparation.type === 'block') return preparation;

  return authorizePreparedTool({
    toolName,
    input,
    externalActionPolicy,
    sessionId,
    onDebug,
    objectiveAuthorizationSegments,
    currentUserRequest,
    permissionApprovalReentry,
    toolUseId,
    runtimeId,
    permissionManager,
    plansFolderPath,
    objectiveTerminalReconciliationPolicy,
  }, ctx, preparation, {
    effectivePermissionMode,
    sensitiveAction,
    isProviderDrivenAutonomy,
    objectiveRequestsExactExternalConfirmation,
    sensitiveActionHasUnresolvedTarget,
    sensitiveActionAuthorizedByObjective,
    contextualReplyAuthorizedByObjective,
    contextualGmailPreflightAttestation,
    contextualGmailToolUseClaim,
    contextualGmailObjective,
    permissionsContext,
    toolEffect,
    eligibleContextualGmailPreflight,
    targetScopedContextualGmailSegments,
  });
}

/** Existing contextual Gmail and dependency authority evaluated directly with preserved observations and native block decisions. */
export type { PreToolUseContext, PathExpansionResult, SkillQualificationResult, MetadataStrippingResult, ConfigValidationResult, DeclaredToolCapabilities, ToolEffectDescriptor, PreToolUseCheckResult, PreToolUseInput, PermissionManagerLike, PrerequisiteManagerLike } from './pre-tool-use/contracts.ts';
export { BUILT_IN_TOOLS, FILE_PATH_TOOLS, CONFIG_WRITE_TOOLS, LABELS_BLOCKED_FILE_TOOLS } from './pre-tool-use/tool-names.ts';
export { expandToolPaths, qualifySkillName, stripToolMetadata, stripMcpMetadata } from './pre-tool-use/input-transforms.ts';
export { validateConfigWrite } from './pre-tool-use/config-validation.ts';
export { getConfigCliRedirect, getConfigDomainBashRedirect } from './pre-tool-use/cli-redirect.ts';
export { oversizedRbwOssCatalogReadGuidance } from './pre-tool-use/autonomy-request-guards.ts';
export { clearContextualGmailMutationLifecycleState, clearContextualGmailPreflightAttestation, destroyContextualGmailSessionState, invalidateContextualGmailSessionState } from './pre-tool-use/gmail-cleanup.ts';
export type { ContextualGmailHostExecutionTicket, ContextualGmailHostExecutionDecision } from './pre-tool-use/gmail-execution.ts';
export { hasContextualGmailInFlightForRuntime, beginContextualGmailHostExecution, settleContextualGmailHostExecution, confirmContextualGmailRuntimeTeardown } from './pre-tool-use/gmail-execution.ts';
export type { ContextualGmailPromptReservationDecision } from './pre-tool-use/gmail-reservations.ts';
export { resolveContextualGmailPromptReservation } from './pre-tool-use/gmail-reservations.ts';
export { recordContextualGmailToolResult } from './pre-tool-use/gmail-receipts.ts';
export { hashSensitiveExternalActionOperation } from './pre-tool-use/external-action-hash.ts';
export type { BrowserChannelDirective } from './pre-tool-use/browser-channel.ts';
export { resolveBrowserChannelDirective } from './pre-tool-use/browser-channel.ts';
export { classifyToolEffect } from './pre-tool-use/tool-effects.ts';
export { canonicalTerminalReconciliationToolInput, TERMINAL_RECONCILIATION_CAPABILITY_FIELD, deriveTerminalReconciliationInvocationCapability } from './pre-tool-use/terminal-reconciliation.ts';
export { shouldPromptInAskMode } from './pre-tool-use/ask-prompt.ts';
