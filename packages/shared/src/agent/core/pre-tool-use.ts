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
import { yoloHumanHandoffBlock } from "../yolo-policy.ts";
import { shouldAllowToolInMode, getPermissionModeDiagnostics } from "../mode-manager.ts";
import { type PermissionsContext } from "../permissions-config.ts";
import { contextualGmailTargetScopedAuthorizationSegments, externalActionAuthorityPolicySegments, hasContextualGmailReplyMention, hasUnresolvedRemoteScopeTarget, hasUnresolvedSensitiveExternalActionTarget, isSensitiveExternalActionAuthorizedByObjective, isSensitiveExternalActionOtherwiseAuthorizedByObjective } from "./sensitive-external-action.ts";
import { classifyBrowserObjectiveAuthority } from "./pre-tool-use/browser-authority.ts";
import type { PreToolUseCheckResult, PreToolUseInput } from "./pre-tool-use/contracts.ts";
import { explicitlyNamesGmailBrowserMutation, explicitlyNamesNonCanonicalContextualGmailMutation, isBrowserKeyboardText } from "./pre-tool-use/gmail-channel.ts";
import { stripToolMetadata } from "./pre-tool-use/input-transforms.ts";
import { readOnlyRemoteObservationRepairReason, withPermissionModeContext } from "./pre-tool-use/permission-context.ts";
import { TERMINAL_RECONCILIATION_CAPABILITY_FIELD, deriveTerminalReconciliationInvocationCapability } from "./pre-tool-use/terminal-reconciliation.ts";
import { checkExecutionPrerequisites } from "./pre-tool-use/execution-prerequisites.ts";
import { prepareToolInput } from "./pre-tool-use/tool-input-preparation.ts";
import { authorizePreparedTool } from "./pre-tool-use/tool-authorization.ts";
import { classifyToolAuthority } from "./pre-tool-use/tool-authority.ts";
import { evaluateGmailAuthority } from "./pre-tool-use/gmail-authority.ts";
import { checkBrowserChannelAdmission, checkDispatchObjectiveAuthority } from './pre-tool-use/dispatch-admission.ts';
import { claimGmailToolUse } from './pre-tool-use/gmail-claims.ts';
import { checkRemoteTransportAdmission } from './pre-tool-use/remote-transport.ts';
import { getRobbOperationsExtension } from '../../operations/index.ts';

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
    && process.env["ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT"] !== '1';
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

  const gmailClaims = claimGmailToolUse({
    toolName,
    sessionId,
    ...(toolUseId !== undefined ? { toolUseId } : {}),
    input,
    sourceActivationReentry,
    permissionApprovalReentry,
  }, {
    acceptedAuthorizationSegments,
  });
  if ('type' in gmailClaims) return gmailClaims;
  const {
    contextualGmailPreflightTool,
    contextualGmailToolUseClaim,
  } = gmailClaims;

  const toolAuthority = classifyToolAuthority({
    input,
    toolName,
    ...(dataFolderPath !== undefined ? { dataFolderPath } : {}),
    ...(authenticatedUserAuthorizationSegments !== undefined ? { authenticatedUserAuthorizationSegments } : {}),
    ...(objectiveTerminalReconciliationPolicy !== undefined ? { objectiveTerminalReconciliationPolicy } : {}),
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

  const browserAdmission = checkBrowserChannelAdmission({
    ...(objectiveAuthorizationSegments !== undefined ? { objectiveAuthorizationSegments } : {}),
    toolName,
    input,
    ...(onDebug !== undefined ? { onDebug } : {}),
  }, {
    policyCurrentUserRequest,
    policyAuthorizationSegments,
  });
  if (browserAdmission) return browserAdmission;

  const gmailAuthority = evaluateGmailAuthority({
    sessionId,
    toolName,
    input,
    ...(dataFolderPath !== undefined ? { dataFolderPath } : {}),
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
    && explicitlyNamesGmailBrowserMutation(input["command"])) {
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

  const remoteTransport = checkRemoteTransportAdmission({
    toolName,
    input,
    ...(workingDirectory !== undefined ? { workingDirectory } : {}),
    workspaceRootPath,
  }, {
    toolEffect,
    isProviderDrivenAutonomy,
    rejectedTargetBoundStructuredRemoteTechnicalRead,
    sensitiveAction,
    shellCommand,
    sensitiveActionAuthorizedByObjective,
  });
  if ('type' in remoteTransport) return remoteTransport;
  const {
    remoteObservationRepair,
  } = remoteTransport;

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
      { ...(plansFolderPath !== undefined ? { plansFolderPath } : {}), ...(dataFolderPath !== undefined ? { dataFolderPath } : {}), permissionsContext }
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
    ...(executionIsolation !== undefined ? { executionIsolation } : {}),
    toolName,
    input,
    ...(onDebug !== undefined ? { onDebug } : {}),
    workspaceRootPath,
    ...(workingDirectory !== undefined ? { workingDirectory } : {}),
    ...(missionCapabilityLock !== undefined ? { missionCapabilityLock } : {}),
    activeSourceSlugs,
    allSourceSlugs,
    ...(objectiveTerminalReconciliationPolicy !== undefined ? { objectiveTerminalReconciliationPolicy } : {}),
    hasSourceActivation,
    ...(prerequisiteManager !== undefined ? { prerequisiteManager } : {}),
    ...(preloadedSourceGuidePaths !== undefined ? { preloadedSourceGuidePaths } : {}),
  }, contextualGmailToolUseClaim);
  if (prerequisiteDecision) return prerequisiteDecision;

  const objectiveAdmission = checkDispatchObjectiveAuthority({
    toolName,
    input,
    ...(objectiveMutationAuthorized !== undefined ? { objectiveMutationAuthorized } : {}),
    ...(objectiveSensitiveActionAuthorized !== undefined ? { objectiveSensitiveActionAuthorized } : {}),
    ...(objectiveAuthorizationSegments !== undefined ? { objectiveAuthorizationSegments } : {}),
    ...(plansFolderPath !== undefined ? { plansFolderPath } : {}),
    ...(dataFolderPath !== undefined ? { dataFolderPath } : {}),
    sessionId,
    ...(onDebug !== undefined ? { onDebug } : {}),
  }, {
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
  });
  if ('type' in objectiveAdmission) return objectiveAdmission;
  const {
    objectiveRequestsExactExternalConfirmation,
  } = objectiveAdmission;

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
    ...(onDebug !== undefined ? { onDebug } : {}),
    workspaceRootPath,
    ...(workingDirectory !== undefined ? { workingDirectory } : {}),
    workspaceId,
    ...(objectiveTerminalReconciliationPolicy !== undefined ? { objectiveTerminalReconciliationPolicy } : {}),
  }, ctx, toolEffect, boundedStructuredRemoteTechnicalUploadLocalPath);
  if (preparation.type === 'block') return preparation;

  const extension = getRobbOperationsExtension();
  if (extension) {
    const preparedInput = preparation.type === 'modify' ? preparation.input : input;
    let decision: ReturnType<typeof extension.beforeTool>;
    try {
      decision = extension.beforeTool({
        now: new Date().toISOString(), workspaceId, workspaceRootPath, sessionId,
        toolName, input: preparedInput, permissionMode: effectivePermissionMode,
        ...(workingDirectory !== undefined ? { workingDirectory } : {}),
      });
    } catch (error) {
      return { type: 'block', reason: `Robb Operations: ${error instanceof Error ? error.message : String(error)}` };
    }
    if ('input' in decision && decision.input) {
      return { type: 'block', reason: 'Robb Operations cannot rewrite tool input at this admission point.' };
    }
    if (decision.decision === 'block') return { type: 'block', reason: decision.reason };
    if (decision.decision === 'require-approval' && !permissionApprovalReentry) {
      if (effectivePermissionMode === 'safe' || ctx.humanInputAllowed === false) {
        return { type: 'block', reason: decision.reason };
      }
      const optionalModifiedInput = preparation.type === 'modify' ? preparation.input : undefined;
      return {
        type: 'prompt',
        promptType: toolName === 'Bash' ? 'bash' : toolName.startsWith('mcp__') ? 'mcp_mutation' : 'api_mutation',
        description: decision.reason,
        ...(toolName === 'Bash' && typeof preparedInput["command"] === 'string' ? { command: preparedInput["command"] } : {}),
        ...(optionalModifiedInput !== undefined ? { modifiedInput: optionalModifiedInput } : {}),
        ...(decision.classification !== undefined ? { reason: decision.classification } : {}),
        requiresExplicitConfirmation: true,
      };
    }
  }

  return authorizePreparedTool({
    toolName,
    input,
    externalActionPolicy,
    sessionId,
    ...(onDebug !== undefined ? { onDebug } : {}),
    ...(objectiveAuthorizationSegments !== undefined ? { objectiveAuthorizationSegments } : {}),
    ...(currentUserRequest !== undefined ? { currentUserRequest } : {}),
    permissionApprovalReentry,
    ...(toolUseId !== undefined ? { toolUseId } : {}),
    ...(runtimeId !== undefined ? { runtimeId } : {}),
    permissionManager,
    ...(plansFolderPath !== undefined ? { plansFolderPath } : {}),
    ...(objectiveTerminalReconciliationPolicy !== undefined ? { objectiveTerminalReconciliationPolicy } : {}),
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

/** Direct admission checks with original claims, browser constraints, remote transport and objective authority. */
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
