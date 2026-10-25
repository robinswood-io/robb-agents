import type { MissionCapabilityLock } from "@craft-agent/shared/sessions";
import type { PermissionMode } from "@craft-agent/shared/agent/mode-types";
import { canonicalExecutionIsolationToolInput, validateSessionExecutionIsolation, type SessionExecutionIsolation } from "@craft-agent/shared/tasks";
import { enforceTaskToolIsolation } from "@craft-agent/shared/agent";
import { resolveSubagentAutonomy } from "../../subagents/autonomy-inheritance.ts";
import { type MissionExecutionInput } from "../MissionRuntime.ts";
import type { SessionMissionExecutor } from '../SessionMissionExecutor.ts';
import { MAX_UPSTREAM_CONTEXT_CHARS, isTerminalReview, buildExecutionIsolation, canonicalSourceSlugs, requiredReviewInvocations } from './shared.ts';
import type { RequiredReviewInvocation } from './shared.ts';

export async function preflightRequiredReviewInvocations(transportOwner: SessionMissionExecutor, input: MissionExecutionInput, missionWorkingDirectory: string): Promise<{
    allowed: true;
    effectivePermissionMode: PermissionMode;
    grantsFullToolAndNetworkAccess: boolean;
    enabledSourceSlugs?: string[];
    executionIsolation: SessionExecutionIsolation;
    reviewInvocations: RequiredReviewInvocation[];
} | {
    allowed: false;
    reason: string;
}> {
    const autonomy = resolveSubagentAutonomy({
        ...(transportOwner["options"].resolveSubagentAutonomyContext?.(input.mission.originSessionId) ?? {}),
        requestedPermissionMode: input.profile.permissionMode,
    });
    const specializedWriteAllowed = input.specializedProfile?.capabilityEnvelope.some(({ kind, name }) => kind === 'workspace-write' && name === 'workspace') ?? true;
    const effectivePermissionMode: PermissionMode = isTerminalReview(input) || !specializedWriteAllowed
        ? 'safe'
        : autonomy.permissionMode;
    const specializedSources = input.specializedProfile
        ? input.specializedProfile.capabilityEnvelope
            .filter(({ kind }) => kind === 'source')
            .map(({ name }) => name)
        : undefined;
    const requestedSourceSlugs = specializedSources
        ?? (input.profile.sources.length > 0 ? canonicalSourceSlugs(input.profile.sources) : undefined);
    let enabledSourceSlugs = requestedSourceSlugs;
    // A terminal reviewer gets one explicit snapshot of the sources it would
    // effectively inherit *now*. This preserves workspace defaults while
    // preventing them from drifting between preflight and provider dispatch.
    if (isTerminalReview(input)) {
        if (!transportOwner["options"].host.resolveMissionEnabledSourceSlugs) {
            return {
                allowed: false,
                reason: 'The Mission host cannot resolve the current terminal-review source boundary',
            };
        }
        try {
            enabledSourceSlugs = canonicalSourceSlugs(await transportOwner["options"].host.resolveMissionEnabledSourceSlugs(transportOwner["options"].workspaceId, requestedSourceSlugs ? [...requestedSourceSlugs] : undefined));
        }
        catch (error) {
            return {
                allowed: false,
                reason: `The Mission host could not resolve the current terminal-review sources: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    }
    const origin = input.mission.originSessionId
        ? transportOwner["options"].host.getSessions(transportOwner["options"].workspaceId)
            .find(candidate => candidate.id === input.mission.originSessionId)
        : undefined;
    const required = requiredReviewInvocations(input, origin);
    if (required.unsupportedCriterionId) {
        return {
            allowed: false,
            reason: `Host criterion "${required.unsupportedCriterionId}" does not expose a complete top-level tool input for side-effect-free Mission preflight`,
        };
    }
    if (required.invocations.length > 0
        && !transportOwner["options"].host.preflightMissionToolInvocations
        && !transportOwner["options"].host.preflightMissionToolInvocation) {
        return {
            allowed: false,
            reason: 'The Mission host cannot preflight its registered review observations',
        };
    }
    const preflightInputs = required.invocations.map(invocation => ({
        toolName: invocation.toolName,
        toolInput: invocation.toolInput,
        permissionMode: effectivePermissionMode,
        ...(enabledSourceSlugs ? { enabledSourceSlugs: [...enabledSourceSlugs] } : {}),
    }));
    const decisions = required.invocations.length === 0
        ? []
        : transportOwner["options"].host.preflightMissionToolInvocations
            ? await transportOwner["options"].host.preflightMissionToolInvocations(transportOwner["options"].workspaceId, preflightInputs)
            : await Promise.all(preflightInputs.map(preflightInput => (transportOwner["options"].host.preflightMissionToolInvocation!(transportOwner["options"].workspaceId, preflightInput))));
    if (decisions.length !== required.invocations.length) {
        return {
            allowed: false,
            reason: 'The Mission host returned an incomplete review preflight decision set',
        };
    }
    for (const [index, invocation] of required.invocations.entries()) {
        const decision = decisions[index]!;
        if (!decision.allowed) {
            return {
                allowed: false,
                reason: `Registered Mission observation "${invocation.criterionId}" is inadmissible before provider dispatch: ${decision.reason}`,
            };
        }
    }
    const allowedReadToolInvocations = required.invocations
        .filter(({ toolName }) => toolName.startsWith('mcp__'))
        .map(({ toolName, toolInput }) => ({
        toolName,
        inputJson: canonicalExecutionIsolationToolInput(toolInput)!,
    }));
    const executionIsolation = buildExecutionIsolation(input, transportOwner["options"].workspaceRoot, missionWorkingDirectory, allowedReadToolInvocations)!;
    const isolationValidation = validateSessionExecutionIsolation(executionIsolation, transportOwner["options"].workspaceRoot);
    if (!isolationValidation.allowed) {
        return {
            allowed: false,
            reason: `Mission review isolation is invalid: ${isolationValidation.reason ?? 'blocked'}`,
        };
    }
    const missionCapabilityLock: MissionCapabilityLock | undefined = input.specializedProfile
        ? {
            schemaVersion: 1,
            capabilityEnvelopeSha256: input.specializedProfile.capabilityEnvelopeSha256,
            capabilities: [...input.specializedProfile.capabilityEnvelope],
        }
        : undefined;
    for (const invocation of required.invocations) {
        const isolationDecision = enforceTaskToolIsolation({
            toolName: invocation.toolName,
            input: invocation.toolInput,
            workspaceRootPath: transportOwner["options"].workspaceRoot,
            workingDirectory: missionWorkingDirectory,
            isolation: executionIsolation,
            missionCapabilityLock,
        });
        if (!isolationDecision.allowed) {
            return {
                allowed: false,
                reason: `Registered Mission observation "${invocation.criterionId}" is outside the review isolation envelope: ${isolationDecision.reason ?? 'blocked'}`,
            };
        }
    }
    const promptProjection = required.invocations.map(({ criterionId, toolName, toolInput }) => ({
        criterionId,
        toolName,
        input: toolInput,
    }));
    if (JSON.stringify(promptProjection).length > MAX_UPSTREAM_CONTEXT_CHARS) {
        return {
            allowed: false,
            reason: 'Registered Mission observations exceed the bounded provider prompt envelope',
        };
    }
    return {
        allowed: true,
        effectivePermissionMode,
        grantsFullToolAndNetworkAccess: autonomy.grantsFullToolAndNetworkAccess,
        ...(enabledSourceSlugs ? { enabledSourceSlugs: [...enabledSourceSlugs] } : {}),
        executionIsolation,
        reviewInvocations: required.invocations,
    };
}
