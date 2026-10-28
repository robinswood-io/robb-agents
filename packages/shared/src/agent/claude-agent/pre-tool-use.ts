import { ToolAdmissionRecoveryError } from "../backend/types.ts";
import { debug } from "../../utils/debug.ts";
import { getSessionScopedToolCallbacks } from "../session-scoped-tools.ts";
import { type SdkAutomationCallbackMatcher } from "../../automations/index.ts";
import { getPermissionMode, getPermissionModeDiagnostics, blockWithReason } from "../mode-manager.ts";
import { getSessionDataPath, getSessionPlansPath } from "../../sessions/storage.ts";
import { extractWorkspaceSlug } from "../../utils/workspace.ts";
// Centralized PreToolUse pipeline
// Centralized PreToolUse pipeline
import { runPreToolUseChecks } from "../core/pre-tool-use.ts";
import { getRtkPath } from "../core/rtk-detector.ts";
import { getRtkEnabled } from "../../config/storage.ts";
import type { RtkContext } from "../core/rtk-rewrite.ts";
import { stat } from "node:fs/promises";
import { IMAGE_LIMITS } from "../../utils/files.ts";
import type { ClaudeAgent } from '../claude-agent.ts';
import { IMAGE_READ_EXTENSIONS, resolveClaudeCallLlmInterceptInput } from './shared.ts';

export function createPreToolUseHook(transportOwner: ClaudeAgent, sessionId: string, gmailRuntimeId: string): SdkAutomationCallbackMatcher['hooks'][number] {
    return async (_hookInput) => {
        // Only handle PreToolUse events
        if (_hookInput.hook_event_name !== 'PreToolUse') {
            return { continue: true };
        }
        // Validate the fields we depend on are actually present
        if (!_hookInput.tool_name || !_hookInput.tool_use_id) {
            return blockWithReason('The host could not correlate this tool to one exact SDK invocation. The tool was not executed.');
        }
        const input = _hookInput as Required<Pick<typeof _hookInput, 'tool_name' | 'tool_use_id'>> & typeof _hookInput;
        const toolInput = input.tool_input as Record<string, unknown>;
        const authorizationEpoch = transportOwner.promptPreparationRevision;
        const admit = async (approvedInput: Record<string, unknown>) => {
            if (authorizationEpoch !== transportOwner.promptPreparationRevision) {
                return blockWithReason('The host could not bind this tool approval to one exact current execution. The tool was not executed.');
            }
            try {
                await transportOwner["config"].beforeToolExecution?.({
                    toolUseId: input.tool_use_id,
                    toolName: input.tool_name,
                    toolInput: approvedInput,
                });
            }
            catch (error) {
                return blockWithReason(error instanceof ToolAdmissionRecoveryError
                    ? error.safeReason
                    : 'The host could not durably record this tool admission. The tool was not executed.');
            }
            if (authorizationEpoch !== transportOwner.promptPreparationRevision || !transportOwner["admitToolExecution"]({
                toolUseId: input.tool_use_id,
                toolName: input.tool_name,
                toolInput: approvedInput,
                sessionId,
                runtimeId: gmailRuntimeId,
                authorizationEpoch,
            })) {
                return blockWithReason('The host could not bind this tool approval to one exact current execution. The tool was not executed.');
            }
            if (approvedInput !== toolInput) {
                return {
                    continue: true,
                    hookSpecificOutput: {
                        hookEventName: 'PreToolUse' as const,
                        updatedInput: approvedInput,
                    },
                };
            }
            return { continue: true };
        };
        transportOwner["prerequisiteManager"].trackToolStart(input.tool_use_id, input.tool_name, input.tool_input ?? {});
        // --- Image size guard for Read tool ---
        // Must run before runPreToolUseChecks. Once an oversized image enters
        // the conversation history, the session becomes permanently stuck
        // (API rejects with 400, SDK reports success, no recovery).
        if (input.tool_name === 'Read') {
            const filePath = (input.tool_input as {
                file_path?: string;
            }).file_path;
            if (filePath) {
                const ext = filePath.toLowerCase().split('.').pop() || '';
                if (IMAGE_READ_EXTENSIONS.has(ext)) {
                    try {
                        const stats = await stat(filePath);
                        if (stats.size > IMAGE_LIMITS.MAX_RAW_SIZE) {
                            const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
                            transportOwner["onDebug"]?.(`Image ${filePath} is ${sizeMB}MB, attempting resize...`);
                            if (transportOwner["config"].onImageResize) {
                                const resizedPath = await transportOwner["config"].onImageResize(filePath, IMAGE_LIMITS.MAX_RAW_SIZE);
                                if (resizedPath) {
                                    transportOwner["onDebug"]?.(`Image resized, redirecting Read to: ${resizedPath}`);
                                    return admit({ ...toolInput, file_path: resizedPath });
                                }
                            }
                            return blockWithReason(`Image too large (${sizeMB}MB). The API limit is 5MB base64 (~3.5MB raw). Use a smaller or compressed version.`);
                        }
                    }
                    catch (err) {
                        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                            transportOwner["onDebug"]?.(`Image size check failed for ${filePath}: ${err}`);
                        }
                    }
                }
            }
        }
        // Get current permission mode (single source of truth)
        const permissionMode = getPermissionMode(sessionId);
        transportOwner["onDebug"]?.(`PreToolUse hook: ${input.tool_name} (sessionId=${sessionId}, permissionMode=${permissionMode})`);
        // Build RTK context fresh per call so toggling the preference
        // takes effect without restart. `getRtkPath()` is cached per
        // process; only the storage read happens each time.
        const rtkContext: RtkContext | undefined = getRtkEnabled()
            ? { enabled: true, path: getRtkPath(), exclude: [] }
            : undefined;
        const currentUserRequest = transportOwner["getCurrentTurnUserMessage"]() ?? undefined;
        const objectiveAuthority = transportOwner["config"].getObjectiveMutationAuthority?.(currentUserRequest);
        try {
            await getSessionScopedToolCallbacks(sessionId)?.validateMissionCapabilitiesFn?.(input.tool_name, toolInput);
        }
        catch (error) {
            return blockWithReason(`Specialized Mission capability lease rejected this tool: ${error instanceof Error ? error.message : String(error)}`);
        }
        // Run centralized PreToolUse checks
        const checkResult = runPreToolUseChecks({
            toolName: input.tool_name,
            input: toolInput,
            sessionId,
            toolUseId: input.tool_use_id,
            runtimeId: gmailRuntimeId,
            permissionMode,
            workspaceRootPath: transportOwner["workspaceRootPath"],
            workspaceId: extractWorkspaceSlug(transportOwner["workspaceRootPath"], transportOwner["config"].workspace.id),
            plansFolderPath: sessionId ? getSessionPlansPath(transportOwner["workspaceRootPath"], sessionId) : undefined,
            ...(sessionId ? { dataFolderPath: getSessionDataPath(transportOwner["workspaceRootPath"], sessionId) } : {}),
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
            declaredToolCapabilities: transportOwner["config"].mcpPool?.getProxyToolCapabilities(input.tool_name),
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
            onDebug: (msg) => transportOwner["onDebug"]?.(msg),
        });
        // Translate result to SDK format
        switch (checkResult.type) {
            case 'allow':
                return admit(toolInput);
            case 'modify':
                return admit(checkResult.input);
            case 'block': {
                const diagnostics = getPermissionModeDiagnostics(sessionId);
                transportOwner["onDebug"]?.(`__PERMISSION_BLOCK__${JSON.stringify({
                    sessionId,
                    toolName: input.tool_name,
                    effectiveMode: diagnostics.permissionMode,
                    modeVersion: diagnostics.modeVersion,
                    changedBy: diagnostics.lastChangedBy,
                    changedAt: diagnostics.lastChangedAt,
                    reason: checkResult.reason,
                })}`);
                return blockWithReason(checkResult.reason);
            }
            case 'source_activation_needed': {
                const { sourceSlug, sourceExists } = checkResult;
                if (sourceExists && transportOwner["onSourceActivationRequest"]) {
                    transportOwner["onDebug"]?.(`Source "${sourceSlug}" not active, attempting auto-enable...`);
                    try {
                        const activated = await transportOwner["onSourceActivationRequest"](sourceSlug);
                        if (activated) {
                            const currentUserMessage = transportOwner["getCurrentTurnUserMessage"]() ?? '';
                            if (currentUserMessage) {
                                // The current Claude query has a fixed tool catalogue. Queue
                                // the existing host restart seam so the blocked tool result
                                // triggers an automatic fresh turn with the source live.
                                transportOwner["setPendingSourceActivationRestart"]({
                                    sourceSlug,
                                    userMessage: currentUserMessage,
                                });
                            }
                            transportOwner["onDebug"]?.(`Source "${sourceSlug}" auto-enabled successfully; scheduling automatic fresh-turn retry`);
                            return {
                                continue: false,
                                decision: 'block' as const,
                                reason: `Source "${sourceSlug}" has been activated. This tool attempt is stopping so the host can retry the original request automatically in a fresh turn with the source available. Do not ask the user to resend it.`,
                            };
                        }
                        else {
                            return {
                                continue: false,
                                decision: 'block' as const,
                                reason: `Source "${sourceSlug}" could not be activated. It may require authentication. Please check the source status and authenticate if needed.`,
                            };
                        }
                    }
                    catch (error) {
                        return {
                            continue: false,
                            decision: 'block' as const,
                            reason: `Failed to activate source "${sourceSlug}": ${error instanceof Error ? error.message : 'Unknown error'}`,
                        };
                    }
                }
                else if (sourceExists) {
                    return {
                        continue: false,
                        decision: 'block' as const,
                        reason: `Source "${sourceSlug}" is available but not enabled for this session. Please enable it in the sources panel.`,
                    };
                }
                else {
                    return {
                        continue: false,
                        decision: 'block' as const,
                        reason: `Source "${sourceSlug}" could not be connected. It may need re-authentication, or the server may be unreachable. Check the source in the sidebar for details.`,
                    };
                }
            }
            case 'call_llm_intercept': {
                // Claude's session tool validates `model` after this hook. A
                // disabled router must remove the override before validation.
                return admit(resolveClaudeCallLlmInterceptInput(checkResult.input));
            }
            case 'spawn_session_intercept':
                return admit(checkResult.input);
            case 'prompt': {
                const requestId = `perm-${input.tool_use_id}`;
                const command = checkResult.command || '';
                const baseCommand = transportOwner["permissionManager"].getBaseCommand(command);
                debug(`[PreToolUse] Requesting permission for ${input.tool_name}: ${command}`);
                const permissionPromise = new Promise<boolean>((resolve) => {
                    transportOwner.pendingPermissions.set(requestId, {
                        resolve,
                        toolName: input.tool_name,
                        command,
                        baseCommand,
                    });
                });
                if (transportOwner["onPermissionRequest"]) {
                    transportOwner["onPermissionRequest"]({
                        requestId,
                        toolName: input.tool_name,
                        toolUseId: input.tool_use_id,
                        command,
                        description: checkResult.description,
                        type: checkResult.promptType,
                        ...(checkResult.appName !== undefined ? { appName: checkResult.appName } : {}),
                        ...(checkResult.reason !== undefined ? { reason: checkResult.reason } : {}),
                        ...(checkResult.impact !== undefined ? { impact: checkResult.impact } : {}),
                        ...(checkResult.requiresSystemPrompt !== undefined ? { requiresSystemPrompt: checkResult.requiresSystemPrompt } : {}),
                        ...(checkResult.rememberForMinutes !== undefined ? { rememberForMinutes: checkResult.rememberForMinutes } : {}),
                        ...(checkResult.commandHash !== undefined ? { commandHash: checkResult.commandHash } : {}),
                        ...(checkResult.approvalTtlSeconds !== undefined ? { approvalTtlSeconds: checkResult.approvalTtlSeconds } : {}),
                        ...(checkResult.sensitiveActionCategory !== undefined ? { sensitiveActionCategory: checkResult.sensitiveActionCategory } : {}),
                        ...(checkResult.sensitiveActionTargets !== undefined ? { sensitiveActionTargets: checkResult.sensitiveActionTargets } : {}),
                        ...(checkResult.sensitiveActionOperationHash !== undefined ? { sensitiveActionOperationHash: checkResult.sensitiveActionOperationHash } : {}),
                    });
                }
                else {
                    transportOwner.pendingPermissions.delete(requestId);
                    transportOwner.resolveContextualGmailPromptDecision(sessionId, input.tool_name, toolInput, input.tool_use_id, false);
                    return {
                        continue: false,
                        decision: 'block' as const,
                        reason: 'No permission handler available',
                    };
                }
                const allowed = await permissionPromise;
                let approvedInput = checkResult.modifiedInput ?? toolInput;
                if (allowed) {
                    const approvalUserRequest = transportOwner["getCurrentTurnUserMessage"]() ?? undefined;
                    const approvalAuthority = transportOwner["config"].getObjectiveMutationAuthority?.(approvalUserRequest);
                    const approvalCheck = runPreToolUseChecks({
                        toolName: input.tool_name,
                        input: approvedInput,
                        sessionId,
                        toolUseId: input.tool_use_id,
                        runtimeId: gmailRuntimeId,
                        permissionApprovalReentry: true,
                        permissionMode: getPermissionMode(sessionId),
                        workspaceRootPath: transportOwner["workspaceRootPath"],
                        workspaceId: extractWorkspaceSlug(transportOwner["workspaceRootPath"], transportOwner["config"].workspace.id),
                        plansFolderPath: sessionId ? getSessionPlansPath(transportOwner["workspaceRootPath"], sessionId) : undefined,
                        ...(sessionId ? { dataFolderPath: getSessionDataPath(transportOwner["workspaceRootPath"], sessionId) } : {}),
                        ...(transportOwner["config"].session?.workingDirectory !== undefined ? { workingDirectory: transportOwner["config"].session?.workingDirectory } : {}),
                        ...(transportOwner["config"].session?.executionIsolation !== undefined ? { executionIsolation: transportOwner["config"].session?.executionIsolation } : {}),
                        ...(transportOwner["config"].missionCapabilityLock !== undefined ? { missionCapabilityLock: transportOwner["config"].missionCapabilityLock } : {}),
                        activeSourceSlugs: Array.from(transportOwner["sourceManager"].getActiveSlugs()),
                        allSourceSlugs: transportOwner["sourceManager"].getAllSources().map(s => s.config.slug),
                        hasSourceActivation: !!transportOwner["onSourceActivationRequest"],
                        permissionManager: transportOwner["permissionManager"],
                        prerequisiteManager: transportOwner["prerequisiteManager"],
                        preloadedSourceGuidePaths: transportOwner["sourceManager"].getPreloadedSourceGuidePaths(),
                        ...(approvalUserRequest !== undefined ? { currentUserRequest: approvalUserRequest } : {}),
                        declaredToolCapabilities: transportOwner["config"].mcpPool?.getProxyToolCapabilities(input.tool_name),
                        ...(transportOwner["config"].externalActionPolicy !== undefined ? { externalActionPolicy: transportOwner["config"].externalActionPolicy } : {}),
                        humanInputAllowed: transportOwner["config"].getHumanInputAllowed?.(),
                        objectiveMutationAuthorized: typeof approvalAuthority === 'boolean'
                            ? approvalAuthority : approvalAuthority?.authorized,
                        objectiveSensitiveActionAuthorized: typeof approvalAuthority === 'object'
                            ? approvalAuthority.sensitiveActionAuthorized : approvalAuthority,
                        ...(typeof approvalAuthority === 'object' ? { objectiveAuthorizationSegments: approvalAuthority.authorizationSegments } : {}),
                        ...(typeof approvalAuthority === 'object' ? { ...(approvalAuthority.authenticatedUserAuthorizationSegments !== undefined ? { authenticatedUserAuthorizationSegments: approvalAuthority.authenticatedUserAuthorizationSegments } : {}) } : {}),
                        ...(typeof approvalAuthority === 'object' ? { ...(approvalAuthority.terminalReconciliationPolicy !== undefined ? { objectiveTerminalReconciliationPolicy: approvalAuthority.terminalReconciliationPolicy } : {}) } : {}),
                        ...(rtkContext !== undefined ? { rtkContext } : {}),
                        onDebug: msg => transportOwner["onDebug"]?.(`PostPermissionPreToolUse: ${msg}`),
                    });
                    if (approvalCheck.type === 'block' || approvalCheck.type === 'source_activation_needed') {
                        return blockWithReason(approvalCheck.type === 'block'
                            ? approvalCheck.reason
                            : `Source "${approvalCheck.sourceSlug}" changed while permission was pending. The approved tool was not executed.`);
                    }
                    if (approvalCheck.type === 'modify')
                        approvedInput = approvalCheck.input;
                    else if (approvalCheck.type === 'prompt' && approvalCheck.modifiedInput) {
                        approvedInput = approvalCheck.modifiedInput;
                    }
                }
                const gmailDecision = transportOwner.resolveContextualGmailPromptDecision(sessionId, input.tool_name, toolInput, input.tool_use_id, allowed);
                if (!allowed) {
                    return {
                        continue: false,
                        decision: 'block' as const,
                        reason: 'User denied permission',
                    };
                }
                if (gmailDecision.applies && !gmailDecision.allowed) {
                    return {
                        continue: false,
                        decision: 'block' as const,
                        ...(gmailDecision.reason !== undefined ? { reason: gmailDecision.reason } : {}),
                    };
                }
                // User approved — return with modified input if transforms were applied
                return admit(approvedInput);
            }
        }
    };
}
