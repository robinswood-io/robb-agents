import { YOLO_AUTONOMY_GUIDANCE } from "../../yolo-policy.ts";
import { getPermissionModeDiagnostics } from "../../mode-manager.ts";
import { type PermissionsContext } from "../../permissions-config.ts";
import { classifySensitiveExternalAction, contextualGmailTargetScopedAuthorizationSegments, isSensitiveExternalActionExplicitlyAuthorized, type ContextualGmailReplyPreflightIntent } from "../sensitive-external-action.ts";
import { shouldPromptInAskMode, wrapCommandForMacAdminPrompt } from "./ask-prompt.ts";
import type { PreToolUseCheckResult, PreToolUseInput, ToolEffectDescriptor } from "./contracts.ts";
import { hashSensitiveExternalActionOperation } from "./external-action-hash.ts";
import { isBrowserKeyboardText } from "./gmail-channel.ts";
import { currentContextualGmailPreflightAttestation, nextContextualGmailPreflightGeneration } from "./gmail-evidence.ts";
import type { ContextualGmailToolUseClaim } from "./gmail-state.ts";
import { CONTEXTUAL_GMAIL_PREFLIGHT_ATTESTATION_TTL_MS, contextualGmailPreflightAttestations, contextualGmailPreflightGenerations, inFlightContextualGmailReplies, pendingContextualGmailPreflights, reservedContextualGmailReplyAttestations } from "./gmail-state.ts";
import { withPermissionModeContext } from "./permission-context.ts";
import { TERMINAL_RECONCILIATION_CAPABILITY_FIELD, deriveTerminalReconciliationInvocationCapability, terminalReconciliationCoordinationTool } from "./terminal-reconciliation.ts";

interface ToolAuthorizationFacts {
  readonly effectivePermissionMode: ReturnType<typeof getPermissionModeDiagnostics>['permissionMode'];
  readonly sensitiveAction: ReturnType<typeof classifySensitiveExternalAction>;
  readonly isProviderDrivenAutonomy: boolean;
  readonly objectiveRequestsExactExternalConfirmation: boolean;
  readonly sensitiveActionHasUnresolvedTarget: boolean;
  readonly sensitiveActionAuthorizedByObjective: boolean;
  readonly contextualReplyAuthorizedByObjective: boolean;
  readonly contextualGmailPreflightAttestation: ReturnType<typeof currentContextualGmailPreflightAttestation>;
  readonly contextualGmailToolUseClaim: ContextualGmailToolUseClaim | undefined;
  readonly contextualGmailObjective: string;
  readonly permissionsContext: PermissionsContext;
  readonly toolEffect: ToolEffectDescriptor;
  readonly eligibleContextualGmailPreflight: ContextualGmailReplyPreflightIntent | undefined;
  readonly targetScopedContextualGmailSegments: ReturnType<typeof contextualGmailTargetScopedAuthorizationSegments>;
}

export function authorizePreparedTool(
  snapshot: Pick<PreToolUseInput,
    | 'toolName'
    | 'input'
    | 'externalActionPolicy'
    | 'sessionId'
    | 'onDebug'
    | 'objectiveAuthorizationSegments'
    | 'currentUserRequest'
    | 'permissionApprovalReentry'
    | 'toolUseId'
    | 'runtimeId'
    | 'permissionManager'
    | 'plansFolderPath'
    | 'objectiveTerminalReconciliationPolicy'
  >,
  ctx: PreToolUseInput,
  preparation: Extract<PreToolUseCheckResult, { type: 'allow' | 'modify' }>,
  facts: ToolAuthorizationFacts,
): PreToolUseCheckResult {
  const {
    toolName,
    input,
    externalActionPolicy = 'confirm',
    sessionId,
    onDebug,
    objectiveAuthorizationSegments,
    currentUserRequest,
    permissionApprovalReentry = false,
    toolUseId,
    runtimeId,
    permissionManager,
    plansFolderPath,
    objectiveTerminalReconciliationPolicy,
  } = snapshot;
  const {
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
  } = facts;
let currentInput = preparation.type === 'modify' ? preparation.input : input;
let wasModified = preparation.type === 'modify';

  // ============================================================
  // 7. SENSITIVE EXTERNAL-ACTION CONFIRMATION
  // ============================================================
  // Safe mode remains non-interactive and blocks. Ask always retains the
  // dedicated confirmation boundary. Execute does too unless the host opts the
  // workspace into `allow-in-execute`; the default remains fail-closed. This
  // deliberately runs before ask-mode/session whitelists.
  if (isBrowserKeyboardText(toolName, input)
    && !(effectivePermissionMode === 'allow-all' && externalActionPolicy === 'allow-in-execute')) {
    if (ctx.humanInputAllowed === false) return { type: 'block',
      reason: `YOLO: this receiver requires authority unavailable to this session. No keyboard event was delivered. ${YOLO_AUTONOMY_GUIDANCE}` };
    return {
      type: 'prompt', promptType: 'mcp_mutation',
      description: 'Deliver keyboard text to the focused browser/remote receiver',
      command: 'type-keys (text omitted)',
      reason: 'Keyboard events may change a remote application and require the existing external-action authority.',
      impact: 'Text is delivered without Enter, but the receiving application can react to each key.',
      requiresExplicitConfirmation: true,
    };
  }
  if (sensitiveAction) {
    if (effectivePermissionMode === 'safe') {
      const reason = withPermissionModeContext(
        `${sensitiveAction.description}\n\nSensitive external actions are blocked in Explore mode.`,
        sessionId,
        effectivePermissionMode,
      );
      onDebug?.(`Sensitive external action: blocking ${toolName} in safe mode`);
      return { type: 'block', reason };
    }

    const policyAllowsExecute = effectivePermissionMode === 'allow-all'
      && (externalActionPolicy === 'allow-in-execute' || isProviderDrivenAutonomy)
      && (isProviderDrivenAutonomy || (
        !objectiveRequestsExactExternalConfirmation
        && !sensitiveActionHasUnresolvedTarget
      ));
    if (policyAllowsExecute) {
      onDebug?.(
        `Sensitive external action: workspace policy allows ${sensitiveAction.category} in Execute`,
      );
    } else {
      const explicitlyAuthorized = !objectiveRequestsExactExternalConfirmation && (objectiveAuthorizationSegments !== undefined
        ? sensitiveActionAuthorizedByObjective
        : isSensitiveExternalActionExplicitlyAuthorized(sensitiveAction, currentUserRequest));
      if (!explicitlyAuthorized) {
        if (ctx.humanInputAllowed === false) {
          return { type: 'block',
            reason: `YOLO cannot admit this exact external action: its target is unresolved or the accepted objective expressly withholds execution pending confirmation. No permission request was opened. ${YOLO_AUTONOMY_GUIDANCE}` };
        }
        onDebug?.(`Sensitive external action: confirmation required for ${sensitiveAction.category}`);
        const optionalModifiedInput = wasModified ? currentInput : undefined;
        return {
          type: 'prompt',
          promptType: sensitiveAction.promptType,
          description: sensitiveAction.description,
          command: sensitiveAction.commandPreview,
          ...(optionalModifiedInput !== undefined ? { modifiedInput: optionalModifiedInput } : {}),
          reason: sensitiveAction.reason,
          impact: sensitiveAction.impact,
          sensitiveActionCategory: sensitiveAction.category,
          sensitiveActionTargets: sensitiveAction.targetCandidates,
          sensitiveActionOperationHash: hashSensitiveExternalActionOperation(toolName, currentInput),
          requiresExplicitConfirmation: true,
        };
      }
      onDebug?.(`Sensitive external action: current request explicitly authorizes ${sensitiveAction.category} target`);
    }
  }

  // Commit the exact-once reservation before Ask mode can return a prompt.
  // Backends resume an approved prompt directly, without re-running this
  // pipeline, so delaying the reservation until RESULT would leave the signed
  // attestation reusable. A denial reports executed:false and restores it.
  if (!permissionApprovalReentry && contextualReplyAuthorizedByObjective
    && contextualGmailPreflightAttestation && toolUseId) {
    const generation = contextualGmailPreflightGenerations.get(sessionId);
    if (generation === undefined
      || contextualGmailPreflightAttestation.bindingExpiresAtMs <= Date.now()
      || !contextualGmailToolUseClaim
      || contextualGmailToolUseClaim.phase === 'poisoned') {
      return {
        type: 'block',
        reason: 'Validation failed: the signed Gmail preflight or host tool-use claim is no longer current and cannot be consumed safely. Run one fresh canonical preflight before retrying the reply.',
      };
    }
    contextualGmailPreflightAttestations.delete(sessionId);
    reservedContextualGmailReplyAttestations.set(`${sessionId}:${toolUseId}`, {
      expiresAt: contextualGmailPreflightAttestation.bindingExpiresAtMs,
      generation,
      value: contextualGmailPreflightAttestation,
      objectiveFingerprint: contextualGmailObjective,
    });
    inFlightContextualGmailReplies.set(sessionId, {
      generation,
      invalidated: false,
      operationHash: hashSensitiveExternalActionOperation(toolName, currentInput),
      poisoned: false,
      possiblyExecuted: false,
      ...(runtimeId !== undefined ? { runtimeId } : {}),
      toolName,
      toolUseId,
    });
    contextualGmailToolUseClaim.phase = 'admitted';
  }

  // ============================================================
  // 8. ASK MODE PROMPT DECISION
  // ============================================================
  if (effectivePermissionMode === 'ask') {
    const promptInfo = shouldPromptInAskMode(
      toolName,
      input, // Use original input for permission decisions (before stripping)
      permissionManager,
      permissionsContext,
      plansFolderPath,
      onDebug,
      toolEffect,
    );
    if (promptInfo) {
      if (ctx.humanInputAllowed === false) return { type: 'block',
        reason: `YOLO: ${toolName} requires authority unavailable to this delegated session. No tool was executed and no permission request was opened. ${YOLO_AUTONOMY_GUIDANCE}` };
      const adminWrappedInput =
        promptInfo.promptType === 'admin_approval' &&
        promptInfo.command &&
        typeof currentInput["command"] === 'string' &&
        process.platform === 'darwin'
          ? { ...currentInput, command: wrapCommandForMacAdminPrompt(promptInfo.command) }
          : undefined;

      const optionalModifiedInput2 = adminWrappedInput ?? (wasModified ? currentInput : undefined);
      return {
        type: 'prompt',
        promptType: promptInfo.promptType,
        description: promptInfo.description,
        ...(promptInfo.command !== undefined ? { command: promptInfo.command } : {}),
        ...(optionalModifiedInput2 !== undefined ? { modifiedInput: optionalModifiedInput2 } : {}),
        ...(promptInfo.appName !== undefined ? { appName: promptInfo.appName } : {}),
        ...(promptInfo.reason !== undefined ? { reason: promptInfo.reason } : {}),
        ...(promptInfo.impact !== undefined ? { impact: promptInfo.impact } : {}),
        ...(promptInfo.requiresSystemPrompt !== undefined ? { requiresSystemPrompt: promptInfo.requiresSystemPrompt } : {}),
        ...(promptInfo.rememberForMinutes !== undefined ? { rememberForMinutes: promptInfo.rememberForMinutes } : {}),
        ...(promptInfo.commandHash !== undefined ? { commandHash: promptInfo.commandHash } : {}),
        ...(promptInfo.approvalTtlSeconds !== undefined ? { approvalTtlSeconds: promptInfo.approvalTtlSeconds } : {}),
      };
    }
  }

  // ============================================================
  // RESULT
  // ============================================================
  if (eligibleContextualGmailPreflight && !permissionApprovalReentry) {
    const generation = nextContextualGmailPreflightGeneration(sessionId);
    // Only a preflight that has passed every host gate becomes an attempt.
    // This keeps source-activation/prompt re-entry with the same call id from
    // looking like a second invocation while still invalidating older receipts
    // before the actual connector call can return failure or ambiguity.
    contextualGmailPreflightAttestations.delete(sessionId);
    if (toolUseId) {
      const pendingKey = `${sessionId}:${toolUseId}`;
      pendingContextualGmailPreflights.delete(pendingKey);
      pendingContextualGmailPreflights.set(pendingKey, {
        expiresAt: Date.now() + CONTEXTUAL_GMAIL_PREFLIGHT_ATTESTATION_TTL_MS,
        generation,
        intent: eligibleContextualGmailPreflight,
        policySegments: targetScopedContextualGmailSegments,
        objectiveFingerprint: contextualGmailObjective,
      });
      if (contextualGmailToolUseClaim) contextualGmailToolUseClaim.phase = 'admitted';
    }
  }
  if (objectiveTerminalReconciliationPolicy
    && terminalReconciliationCoordinationTool(toolName)) {
    const invocationCapability = deriveTerminalReconciliationInvocationCapability(
      objectiveTerminalReconciliationPolicy.invocationCapabilityKey,
      toolName,
      currentInput,
    );
    if (!invocationCapability) {
      return {
        type: 'block',
        reason: 'Terminal reconciliation could not bind this coordination call to the current host objective revision. The tool was not executed.',
      };
    }
    currentInput = {
      ...currentInput,
      [TERMINAL_RECONCILIATION_CAPABILITY_FIELD]: invocationCapability,
    };
    wasModified = true;
  }
  if (wasModified) {
    return { type: 'modify', input: currentInput };
  }
  return { type: 'allow' };
}
