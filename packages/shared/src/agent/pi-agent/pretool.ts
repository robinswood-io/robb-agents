// Session-scoped tool callbacks (for SubmitPlan, source auth, etc.)
import { getSessionScopedToolCallbacks } from "../session-scoped-tools.ts";
import { getPermissionModeDiagnostics } from "../mode-manager.ts";
// Session storage (plans folder path)
import { getSessionDataPath, getSessionPlansPath } from "../../sessions/storage.ts";
// Centralized PreToolUse pipeline
import { beginContextualGmailHostExecution, confirmContextualGmailRuntimeTeardown, hasContextualGmailInFlightForRuntime, invalidateContextualGmailSessionState, resolveContextualGmailPromptReservation, runPreToolUseChecks, settleContextualGmailHostExecution } from "../core/pre-tool-use.ts";
import { getRtkPath } from "../core/rtk-detector.ts";
import { getRtkEnabled } from "../../config/storage.ts";
import type { RtkContext } from "../core/rtk-rewrite.ts";
// Workspace slug extraction for skill qualification
import { extractWorkspaceSlug } from "../../utils/workspace.ts";
import type { PiAgent } from '../pi-agent.ts';
import type { PiSubprocessRuntimeContext } from './shared.ts';
import type { PiPreToolUseRequest } from './protocol.ts';

/**
   * Handle a pre_tool_use_request from the subprocess.
   * Runs the centralized permission pipeline and sends the decision back.
   */
export async function handlePreToolUseRequest(transportOwner: PiAgent, req: PiPreToolUseRequest, runtimeContext?: PiSubprocessRuntimeContext): Promise<void> {
    const { requestId, toolName, toolCallId, input } = req;
    const authorizationEpoch = transportOwner["promptPreparationRevision"];
    const debugSessionId = runtimeContext?.sessionId
        ?? transportOwner["config"].session?.id
        ?? transportOwner["_sessionId"];
    const respond = (message: Record<string, unknown>) => {
        transportOwner.sendPreToolUseDecision({
            requestId,
            toolName,
            ...(toolCallId !== undefined ? { toolCallId } : {}),
            originalInput: input,
            ...(runtimeContext !== undefined ? { runtimeContext } : {}),
            authorizationEpoch,
        }, message);
    };
    transportOwner["debug"](`PreToolUse request from subprocess: ${toolName} (${requestId}, sessionId=${debugSessionId})`);
    // Capture metadata BEFORE centralized checks strip it out.
    // This bridge is deterministic and avoids relying solely on side-channel store lookups.
    const preIntent = typeof input["_intent"] === 'string' ? input["_intent"] : undefined;
    const preDisplayName = typeof input["_displayName"] === 'string' ? input["_displayName"] : undefined;
    if (toolCallId && (preIntent || preDisplayName)) {
        transportOwner["preToolMetadataByCallId"].set(toolCallId, {
            ...(preIntent !== undefined ? { intent: preIntent } : {}),
            ...(preDisplayName !== undefined ? { displayName: preDisplayName } : {}),
            capturedAt: Date.now(),
        });
        transportOwner["debug"](`Captured pre-tool metadata for ${toolName} (${toolCallId}, sessionId=${debugSessionId}): intent=${!!preIntent}, displayName=${!!preDisplayName}`);
    }
    // Fire PreToolUse automation event — await so automations run before tool executes
    await transportOwner["emitAutomationEvent"]('PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        tool_input: input,
    });
    if (!transportOwner.isRuntimeCurrent(runtimeContext))
        return;
    const rootPath = transportOwner["config"].workspace.rootPath ?? transportOwner["workingDirectory"];
    const workspaceSlug = extractWorkspaceSlug(rootPath, transportOwner["config"].workspace.id);
    const sessionId = runtimeContext?.sessionId
        ?? transportOwner["config"].session?.id
        ?? transportOwner["_sessionId"];
    const plansFolderPath = sessionId
        ? getSessionPlansPath(rootPath, sessionId)
        : undefined;
    const dataFolderPath = sessionId
        ? getSessionDataPath(rootPath, sessionId)
        : undefined;
    // Build RTK context fresh per call so toggling the preference takes
    // effect without restart. `getRtkPath()` is cached per process.
    const rtkContext: RtkContext | undefined = getRtkEnabled()
        ? { enabled: true, path: getRtkPath(), exclude: [] }
        : undefined;
    const currentUserRequest = transportOwner["getCurrentTurnUserMessage"]() ?? undefined;
    const objectiveAuthority = transportOwner["config"].getObjectiveMutationAuthority?.(currentUserRequest);
    try {
        await getSessionScopedToolCallbacks(sessionId)?.validateMissionCapabilitiesFn?.(toolName, input);
    }
    catch (error) {
        respond({
            type: 'pre_tool_use_response',
            requestId,
            action: 'block',
            reason: `Specialized Mission capability lease rejected this tool: ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
    }
    const checkResult = runPreToolUseChecks({
        toolName,
        input,
        sessionId,
        ...(toolCallId !== undefined ? { toolUseId: toolCallId } : {}),
        ...(runtimeContext?.runtimeId !== undefined ? { runtimeId: runtimeContext?.runtimeId } : {}),
        permissionMode: transportOwner["permissionManager"].getPermissionMode(),
        workspaceRootPath: rootPath,
        workspaceId: workspaceSlug,
        ...(plansFolderPath !== undefined ? { plansFolderPath } : {}),
        ...(dataFolderPath !== undefined ? { dataFolderPath } : {}),
        ...(transportOwner["config"].session?.workingDirectory !== undefined ? { workingDirectory: transportOwner["config"].session?.workingDirectory } : {}),
        ...(transportOwner["config"].session?.executionIsolation !== undefined ? { executionIsolation: transportOwner["config"].session?.executionIsolation } : {}),
        ...(transportOwner["config"].missionCapabilityLock !== undefined ? { missionCapabilityLock: transportOwner["config"].missionCapabilityLock } : {}),
        activeSourceSlugs: Array.from(transportOwner["sourceManager"].getActiveSlugs()),
        allSourceSlugs: transportOwner["sourceManager"].getAllSources().map(s => s.config.slug),
        hasSourceActivation: !!transportOwner["onSourceActivationRequest"],
        permissionManager: transportOwner["permissionManager"],
        prerequisiteManager: transportOwner["prerequisiteManager"],
        preloadedSourceGuidePaths: transportOwner["sourceManager"].getPreloadedSourceGuidePaths(),
        ...(currentUserRequest !== undefined ? { currentUserRequest } : {}),
        declaredToolCapabilities: transportOwner["mcpPool"]?.getProxyToolCapabilities(toolName),
        ...(transportOwner["config"].externalActionPolicy !== undefined ? { externalActionPolicy: transportOwner["config"].externalActionPolicy } : {}),
        humanInputAllowed: transportOwner["config"].getHumanInputAllowed?.(),
        objectiveMutationAuthorized: typeof objectiveAuthority === 'boolean'
            ? objectiveAuthority : objectiveAuthority?.authorized,
        objectiveSensitiveActionAuthorized: typeof objectiveAuthority === 'object'
            ? objectiveAuthority.sensitiveActionAuthorized : objectiveAuthority,
        ...(typeof objectiveAuthority === 'object' ? { objectiveAuthorizationSegments: objectiveAuthority.authorizationSegments } : {}),
        ...(typeof objectiveAuthority === 'object' ? { ...(objectiveAuthority.authenticatedUserAuthorizationSegments !== undefined ? { authenticatedUserAuthorizationSegments: objectiveAuthority.authenticatedUserAuthorizationSegments } : {}) } : {}),
        ...(typeof objectiveAuthority === 'object' ? { ...(objectiveAuthority.terminalReconciliationPolicy !== undefined ? { objectiveTerminalReconciliationPolicy: objectiveAuthority.terminalReconciliationPolicy } : {}) } : {}),
        ...(rtkContext !== undefined ? { rtkContext } : {}),
        onDebug: (msg) => transportOwner["debug"](`PreToolUse(sessionId=${sessionId}): ${msg}`),
    });
    switch (checkResult.type) {
        case 'allow':
            respond({ type: 'pre_tool_use_response', requestId, action: 'allow' });
            return;
        case 'modify':
            respond({ type: 'pre_tool_use_response', requestId, action: 'modify', input: checkResult.input });
            return;
        case 'block': {
            const diagnostics = getPermissionModeDiagnostics(sessionId);
            transportOwner["debug"](`__PERMISSION_BLOCK__${JSON.stringify({
                sessionId,
                toolName,
                effectiveMode: diagnostics.permissionMode,
                modeVersion: diagnostics.modeVersion,
                changedBy: diagnostics.lastChangedBy,
                changedAt: diagnostics.lastChangedAt,
                reason: checkResult.reason,
            })}`);
            respond({ type: 'pre_tool_use_response', requestId, action: 'block', reason: checkResult.reason });
            return;
        }
        case 'source_activation_needed': {
            const { sourceSlug, sourceExists } = checkResult;
            transportOwner["debug"](`PreToolUse(sessionId=${sessionId}): Source "${sourceSlug}" not active, attempting activation...`);
            if (!transportOwner["onSourceActivationRequest"]) {
                respond({
                    type: 'pre_tool_use_response',
                    requestId,
                    action: 'block',
                    reason: `Source "${sourceSlug}" is not active and no host activation handler is available. The tool was not executed.`,
                });
                return;
            }
            if (transportOwner["onSourceActivationRequest"]) {
                try {
                    const activated = await transportOwner["onSourceActivationRequest"](sourceSlug);
                    if (!transportOwner.isRuntimeCurrent(runtimeContext))
                        return;
                    if (!activated) {
                        const reason = sourceExists
                            ? `Source "${sourceSlug}" is not active. Activate it by @mentioning it in your message or via the source icon at the bottom of the input field.`
                            : `Source "${sourceSlug}" is not available yet. It needs to be created and configured first.`;
                        respond({ type: 'pre_tool_use_response', requestId, action: 'block', reason });
                        return;
                    }
                    transportOwner["debug"](`PreToolUse(sessionId=${sessionId}): Source "${sourceSlug}" activated successfully`);
                    transportOwner["eventQueue"].enqueue({
                        type: 'source_activated' as const,
                        sourceSlug,
                        originalMessage: transportOwner["getCurrentTurnUserMessage"]() ?? '',
                    });
                }
                catch (err) {
                    const reason = sourceExists
                        ? `Source "${sourceSlug}" could not be activated: ${err}`
                        : `Source "${sourceSlug}" is not available yet. It needs to be created and configured first.`;
                    respond({ type: 'pre_tool_use_response', requestId, action: 'block', reason });
                    return;
                }
            }
            // Re-run pipeline after activation
            const postCurrentUserRequest = transportOwner["getCurrentTurnUserMessage"]() ?? undefined;
            const postObjectiveAuthority = transportOwner["config"].getObjectiveMutationAuthority?.(postCurrentUserRequest);
            const postResult = runPreToolUseChecks({
                toolName,
                input,
                sessionId,
                ...(toolCallId !== undefined ? { toolUseId: toolCallId } : {}),
                ...(runtimeContext?.runtimeId !== undefined ? { runtimeId: runtimeContext?.runtimeId } : {}),
                sourceActivationReentry: true,
                permissionMode: transportOwner["permissionManager"].getPermissionMode(),
                workspaceRootPath: rootPath,
                workspaceId: workspaceSlug,
                ...(plansFolderPath !== undefined ? { plansFolderPath } : {}),
                ...(dataFolderPath !== undefined ? { dataFolderPath } : {}),
                ...(transportOwner["config"].session?.workingDirectory !== undefined ? { workingDirectory: transportOwner["config"].session?.workingDirectory } : {}),
                ...(transportOwner["config"].session?.executionIsolation !== undefined ? { executionIsolation: transportOwner["config"].session?.executionIsolation } : {}),
                ...(transportOwner["config"].missionCapabilityLock !== undefined ? { missionCapabilityLock: transportOwner["config"].missionCapabilityLock } : {}),
                activeSourceSlugs: Array.from(transportOwner["sourceManager"].getActiveSlugs()),
                allSourceSlugs: transportOwner["sourceManager"].getAllSources().map(s => s.config.slug),
                hasSourceActivation: !!transportOwner["onSourceActivationRequest"],
                permissionManager: transportOwner["permissionManager"],
                prerequisiteManager: transportOwner["prerequisiteManager"],
                preloadedSourceGuidePaths: transportOwner["sourceManager"].getPreloadedSourceGuidePaths(),
                ...(postCurrentUserRequest !== undefined ? { currentUserRequest: postCurrentUserRequest } : {}),
                declaredToolCapabilities: transportOwner["mcpPool"]?.getProxyToolCapabilities(toolName),
                ...(transportOwner["config"].externalActionPolicy !== undefined ? { externalActionPolicy: transportOwner["config"].externalActionPolicy } : {}),
                humanInputAllowed: transportOwner["config"].getHumanInputAllowed?.(),
                objectiveMutationAuthorized: typeof postObjectiveAuthority === 'boolean'
                    ? postObjectiveAuthority : postObjectiveAuthority?.authorized,
                objectiveSensitiveActionAuthorized: typeof postObjectiveAuthority === 'object'
                    ? postObjectiveAuthority.sensitiveActionAuthorized : postObjectiveAuthority,
                ...(typeof postObjectiveAuthority === 'object' ? { objectiveAuthorizationSegments: postObjectiveAuthority.authorizationSegments } : {}),
                ...(typeof postObjectiveAuthority === 'object' ? { ...(postObjectiveAuthority.authenticatedUserAuthorizationSegments !== undefined ? { authenticatedUserAuthorizationSegments: postObjectiveAuthority.authenticatedUserAuthorizationSegments } : {}) } : {}),
                ...(typeof postObjectiveAuthority === 'object' ? { ...(postObjectiveAuthority.terminalReconciliationPolicy !== undefined ? { objectiveTerminalReconciliationPolicy: postObjectiveAuthority.terminalReconciliationPolicy } : {}) } : {}),
                ...(rtkContext !== undefined ? { rtkContext } : {}),
                onDebug: (msg) => transportOwner["debug"](`PreToolUse(sessionId=${sessionId}): ${msg}`),
            });
            switch (postResult.type) {
                case 'allow':
                    respond({ type: 'pre_tool_use_response', requestId, action: 'allow' });
                    break;
                case 'modify':
                    respond({ type: 'pre_tool_use_response', requestId, action: 'modify', input: postResult.input });
                    break;
                case 'block':
                    respond({ type: 'pre_tool_use_response', requestId, action: 'block', reason: postResult.reason });
                    break;
                case 'prompt':
                    await transportOwner.handlePreToolUsePrompt(requestId, toolName, input, sessionId, postResult, toolCallId, runtimeContext, authorizationEpoch);
                    break;
                case 'source_activation_needed':
                    respond({
                        type: 'pre_tool_use_response',
                        requestId,
                        action: 'block',
                        reason: `Source "${postResult.sourceSlug}" is still inactive after the activation attempt. The tool was not executed; retry only after the host reports the source active.`,
                    });
                    break;
                case 'call_llm_intercept': {
                    const constrainedInput = { ...postResult.input, model: transportOwner["getModel"]() };
                    respond({
                        type: 'pre_tool_use_response',
                        requestId,
                        action: constrainedInput === postResult.input ? 'allow' : 'modify',
                        ...(constrainedInput === postResult.input ? {} : { input: constrainedInput }),
                    });
                    break;
                }
                case 'spawn_session_intercept':
                    respond({ type: 'pre_tool_use_response', requestId, action: 'modify', input: postResult.input });
                    break;
            }
            return;
        }
        case 'call_llm_intercept': {
            // Re-read the live pin after every permission/automation await. The
            // subprocess receives the authoritative active model when Manual won.
            const constrainedInput = { ...checkResult.input, model: transportOwner["getModel"]() };
            respond({
                type: 'pre_tool_use_response',
                requestId,
                action: constrainedInput === checkResult.input ? 'allow' : 'modify',
                ...(constrainedInput === checkResult.input ? {} : { input: constrainedInput }),
            });
            return;
        }
        case 'spawn_session_intercept':
            respond({ type: 'pre_tool_use_response', requestId, action: 'modify', input: checkResult.input });
            return;
        case 'prompt': {
            await transportOwner.handlePreToolUsePrompt(requestId, toolName, input, sessionId, checkResult, toolCallId, runtimeContext, authorizationEpoch);
            return;
        }
    }
}

export function resolveContextualGmailPromptDecision(transportOwner: PiAgent, sessionId: string, toolName: string, toolInput: Record<string, unknown>, toolUseId: string | undefined, approved: boolean) {
    const currentRequest = transportOwner["getCurrentTurnUserMessage"]() ?? undefined;
    const currentAuthority = transportOwner["config"].getObjectiveMutationAuthority?.(currentRequest);
    return resolveContextualGmailPromptReservation({
        sessionId,
        ...(toolUseId !== undefined ? { toolUseId } : {}),
        toolName,
        toolInput,
        approved,
        permissionMode: getPermissionModeDiagnostics(sessionId).permissionMode,
        activeSourceSlugs: Array.from(transportOwner["sourceManager"].getActiveSlugs()),
        objectiveAuthorizationSegments: typeof currentAuthority === 'object'
            ? currentAuthority.authorizationSegments
            : currentRequest ? [currentRequest] : [],
    });
}

/** Narrow seams keep the host lifecycle directly unit-testable without a subprocess. */
export function beginContextualGmailHostExecutionOperation(_transportOwner: PiAgent, input: Parameters<typeof beginContextualGmailHostExecution>[0]): ReturnType<typeof beginContextualGmailHostExecution> {
    return beginContextualGmailHostExecution(input);
}

export function settleContextualGmailHostExecutionOperation(_transportOwner: PiAgent, ticket: Parameters<typeof settleContextualGmailHostExecution>[0]): boolean {
    return settleContextualGmailHostExecution(ticket);
}

export function confirmContextualGmailRuntimeTeardownOperation(_transportOwner: PiAgent, runtimeContext: Parameters<typeof confirmContextualGmailRuntimeTeardown>[0]): boolean {
    return confirmContextualGmailRuntimeTeardown(runtimeContext);
}

// ============================================================
  // Lifecycle
  // ============================================================
export function invalidateContextualGmailStateForCurrentSession(transportOwner: PiAgent): void {
    const sessionId = transportOwner["subprocessRuntimeContext"]?.sessionId
        ?? transportOwner["config"].session?.id
        ?? transportOwner["_sessionId"];
    if (sessionId)
        invalidateContextualGmailSessionState(sessionId);
}

export function hasContextualGmailInFlightForCurrentRuntime(transportOwner: PiAgent): boolean {
    const runtimeContext = transportOwner["subprocessRuntimeContext"];
    return !!runtimeContext && hasContextualGmailInFlightForRuntime(runtimeContext);
}
