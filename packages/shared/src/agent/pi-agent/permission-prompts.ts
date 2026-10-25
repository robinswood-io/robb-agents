import { ToolAdmissionRecoveryError } from "../backend/types.ts";
// Session storage (plans folder path)
import { getSessionDataPath, getSessionPlansPath } from "../../sessions/storage.ts";
// Centralized PreToolUse pipeline
import { runPreToolUseChecks, type PreToolUseCheckResult } from "../core/pre-tool-use.ts";
import { getRtkPath } from "../core/rtk-detector.ts";
import { getRtkEnabled } from "../../config/storage.ts";
import type { RtkContext } from "../core/rtk-rewrite.ts";
// Workspace slug extraction for skill qualification
import { extractWorkspaceSlug } from "../../utils/workspace.ts";
import type { PiAgent } from '../pi-agent.ts';
import type { PiSubprocessRuntimeContext } from './shared.ts';
import type { PiPreToolUsePrompt, PiSendPreToolUseDecisionRequestPayload } from './protocol.ts';

export async function handlePreToolUsePrompt(transportOwner: PiAgent, requestId: string, toolName: string, toolInput: Record<string, unknown>, sessionId: string, checkResult: Extract<PreToolUseCheckResult, PiPreToolUsePrompt>, authorizationEpoch: number, toolUseId?: string, runtimeContext?: PiSubprocessRuntimeContext): Promise<void> {
    const respond = (message: Record<string, unknown>) => {
        transportOwner["sendPreToolUseDecision"]({
            requestId,
            toolName,
            toolCallId: toolUseId,
            originalInput: toolInput,
            runtimeContext,
            authorizationEpoch,
        }, message);
    };
    if (!transportOwner["onPermissionRequest"]) {
        const gmailDecision = transportOwner["resolveContextualGmailPromptDecision"](sessionId, toolName, toolInput, toolUseId, false);
        if (gmailDecision.applies) {
            respond({
                type: 'pre_tool_use_response',
                requestId,
                action: 'block',
                reason: 'Explicit host approval is unavailable for this reserved Gmail reply. No reply was executed; run a fresh canonical preflight before any later retry.',
            });
            return;
        }
        if (checkResult.requiresExplicitConfirmation) {
            respond({
                type: 'pre_tool_use_response',
                requestId,
                action: 'block',
                reason: 'Explicit confirmation is required for this sensitive external action, but no permission handler is available.',
            });
        }
        else if (checkResult.modifiedInput) {
            // Ordinary Ask prompts retain the established headless behavior. Only
            // explicitly sensitive actions and reserved Gmail replies require a
            // live host decision.
            respond({
                type: 'pre_tool_use_response',
                requestId,
                action: 'modify',
                input: checkResult.modifiedInput,
            });
        }
        else {
            respond({ type: 'pre_tool_use_response', requestId, action: 'allow' });
        }
        return;
    }
    const permRequestId = `pi-perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    transportOwner["debug"](`PreToolUse(sessionId=${sessionId}): Prompting user for ${toolName} - ${checkResult.description}`);
    const permissionPromise = new Promise<boolean>((resolve) => {
        transportOwner["pendingPermissions"].set(permRequestId, {
            resolve,
            toolName,
        });
    });
    transportOwner["onPermissionRequest"]({
        requestId: permRequestId,
        toolName,
        toolUseId,
        command: checkResult.command,
        description: checkResult.description,
        type: checkResult.promptType,
        appName: checkResult.appName,
        reason: checkResult.reason,
        impact: checkResult.impact,
        requiresSystemPrompt: checkResult.requiresSystemPrompt,
        rememberForMinutes: checkResult.rememberForMinutes,
        commandHash: checkResult.commandHash,
        approvalTtlSeconds: checkResult.approvalTtlSeconds,
        sensitiveActionCategory: checkResult.sensitiveActionCategory,
        sensitiveActionTargets: checkResult.sensitiveActionTargets,
        sensitiveActionOperationHash: checkResult.sensitiveActionOperationHash,
    });
    const allowed = await permissionPromise;
    transportOwner["pendingPermissions"].delete(permRequestId);
    if (!transportOwner["isRuntimeCurrent"](runtimeContext))
        return;
    let approvedInput = checkResult.modifiedInput ?? toolInput;
    if (allowed) {
        const rootPath = transportOwner["config"].workspace.rootPath ?? transportOwner["workingDirectory"];
        const workspaceSlug = extractWorkspaceSlug(rootPath, transportOwner["config"].workspace.id);
        const currentUserRequest = transportOwner["getCurrentTurnUserMessage"]() ?? undefined;
        const objectiveAuthority = transportOwner["config"].getObjectiveMutationAuthority?.(currentUserRequest);
        const rtkContext: RtkContext | undefined = getRtkEnabled()
            ? { enabled: true, path: getRtkPath(), exclude: [] }
            : undefined;
        const approvalCheck = runPreToolUseChecks({
            toolName,
            input: approvedInput,
            sessionId,
            toolUseId,
            runtimeId: runtimeContext?.runtimeId,
            permissionApprovalReentry: true,
            permissionMode: transportOwner["permissionManager"].getPermissionMode(),
            workspaceRootPath: rootPath,
            workspaceId: workspaceSlug,
            plansFolderPath: getSessionPlansPath(rootPath, sessionId),
            dataFolderPath: getSessionDataPath(rootPath, sessionId),
            workingDirectory: transportOwner["config"].session?.workingDirectory,
            executionIsolation: transportOwner["config"].session?.executionIsolation,
            missionCapabilityLock: transportOwner["config"].missionCapabilityLock,
            activeSourceSlugs: Array.from(transportOwner["sourceManager"].getActiveSlugs()),
            allSourceSlugs: transportOwner["sourceManager"].getAllSources().map(s => s.config.slug),
            hasSourceActivation: !!transportOwner["onSourceActivationRequest"],
            permissionManager: transportOwner["permissionManager"],
            prerequisiteManager: transportOwner["prerequisiteManager"],
            preloadedSourceGuidePaths: transportOwner["sourceManager"].getPreloadedSourceGuidePaths(),
            currentUserRequest,
            declaredToolCapabilities: transportOwner["mcpPool"]?.getProxyToolCapabilities(toolName),
            externalActionPolicy: transportOwner["config"].externalActionPolicy,
            humanInputAllowed: transportOwner["config"].getHumanInputAllowed?.(),
            objectiveMutationAuthorized: typeof objectiveAuthority === 'boolean'
                ? objectiveAuthority : objectiveAuthority?.authorized,
            objectiveSensitiveActionAuthorized: typeof objectiveAuthority === 'object'
                ? objectiveAuthority.sensitiveActionAuthorized : objectiveAuthority,
            objectiveAuthorizationSegments: typeof objectiveAuthority === 'object'
                ? objectiveAuthority.authorizationSegments : undefined,
            authenticatedUserAuthorizationSegments: typeof objectiveAuthority === 'object'
                ? objectiveAuthority.authenticatedUserAuthorizationSegments : undefined,
            objectiveTerminalReconciliationPolicy: typeof objectiveAuthority === 'object'
                ? objectiveAuthority.terminalReconciliationPolicy : undefined,
            rtkContext,
            onDebug: msg => transportOwner["debug"](`PostPermissionPreToolUse(sessionId=${sessionId}): ${msg}`),
        });
        if (approvalCheck.type === 'block' || approvalCheck.type === 'source_activation_needed') {
            respond({
                type: 'pre_tool_use_response',
                requestId,
                action: 'block',
                reason: approvalCheck.type === 'block'
                    ? approvalCheck.reason
                    : `Source "${approvalCheck.sourceSlug}" changed while permission was pending. The approved tool was not executed.`,
            });
            return;
        }
        if (approvalCheck.type === 'modify')
            approvedInput = approvalCheck.input;
        else if (approvalCheck.type === 'prompt' && approvalCheck.modifiedInput) {
            approvedInput = approvalCheck.modifiedInput;
        }
    }
    const gmailDecision = transportOwner["resolveContextualGmailPromptDecision"](sessionId, toolName, toolInput, toolUseId, allowed);
    if (!allowed) {
        respond({ type: 'pre_tool_use_response', requestId, action: 'block', reason: 'Permission denied by user.' });
    }
    else if (gmailDecision.applies && !gmailDecision.allowed) {
        respond({
            type: 'pre_tool_use_response',
            requestId,
            action: 'block',
            reason: gmailDecision.reason,
        });
    }
    else if (approvedInput !== toolInput) {
        respond({ type: 'pre_tool_use_response', requestId, action: 'modify', input: approvedInput });
    }
    else {
        respond({ type: 'pre_tool_use_response', requestId, action: 'allow' });
    }
}

/**
   * Keep the PreToolUse admission entirely in host memory. No bearer value is
   * serialized into the provider input, transcript, result or diagnostics.
   */
export function sendPreToolUseDecision(transportOwner: PiAgent, request: PiSendPreToolUseDecisionRequestPayload, decision: Record<string, unknown>): void {
    const action = decision.action;
    if (action === 'allow' || action === 'modify') {
        const approvedInput = action === 'modify'
            ? decision.input as Record<string, unknown> | undefined
            : request.originalInput;
        const sessionId = request.runtimeContext?.sessionId
            ?? transportOwner["config"].session?.id
            ?? transportOwner["_sessionId"];
        const runtimeId = request.runtimeContext?.runtimeId
            ?? transportOwner["subprocessRuntimeContext"]?.runtimeId
            ?? '';
        const executionStillCurrent = () => request.authorizationEpoch === transportOwner["promptPreparationRevision"]
            && transportOwner["isRuntimeCurrent"](request.runtimeContext)
            && sessionId.length > 0 && runtimeId.length > 0
            && !!approvedInput;
        const block = (reason: string) => {
            transportOwner["sendForRuntime"]({
                type: 'pre_tool_use_response',
                requestId: request.requestId,
                action: 'block',
                reason,
            }, request.runtimeContext);
        };
        const admitAndSend = () => {
            const admitted = executionStillCurrent() && transportOwner["admitToolExecution"]({
                toolUseId: request.toolCallId,
                toolName: request.toolName,
                toolInput: approvedInput!,
                sessionId,
                runtimeId,
                authorizationEpoch: request.authorizationEpoch,
            });
            if (!admitted) {
                block('The host could not bind this tool approval to one exact execution. The tool was not executed.');
                return;
            }
            transportOwner["sendForRuntime"](decision, request.runtimeContext);
        };
        if (!executionStillCurrent()) {
            block('The host could not bind this tool approval to one exact execution. The tool was not executed.');
            return;
        }
        const durabilityBarrier = transportOwner["config"].beforeToolExecution;
        if (durabilityBarrier) {
            void (async () => {
                try {
                    await durabilityBarrier({
                        toolUseId: request.toolCallId,
                        toolName: request.toolName,
                        toolInput: approvedInput!,
                    });
                }
                catch (error) {
                    block(error instanceof ToolAdmissionRecoveryError
                        ? error.safeReason
                        : 'The host could not durably record this tool admission. The tool was not executed.');
                    return;
                }
                // Stop, steering, or runtime replacement may win while durability is
                // being established. Admission remains exact and fail-closed.
                admitAndSend();
            })();
            return;
        }
        admitAndSend();
        return;
    }
    transportOwner["sendForRuntime"](decision, request.runtimeContext);
}

export function respondToPermission(transportOwner: PiAgent, requestId: string, allowed: boolean, _alwaysAllow?: boolean): void {
    const pending = transportOwner["pendingPermissions"].get(requestId);
    if (pending) {
        transportOwner["pendingPermissions"].delete(requestId);
        pending.resolve(allowed);
    }
}

/** Settle every host permission wait fail-closed before runtime teardown. */
export function denyAllPendingPermissions(transportOwner: PiAgent): void {
    if (transportOwner["pendingPermissions"].size === 0)
        return;
    const pendingPermissions = [...transportOwner["pendingPermissions"].values()];
    transportOwner["pendingPermissions"].clear();
    for (const pending of pendingPermissions) {
        pending.resolve(false);
    }
}
