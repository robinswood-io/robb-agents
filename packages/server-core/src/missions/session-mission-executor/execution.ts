import { type MissionExecutionBinding } from "@craft-agent/shared/missions";
import { isDeepStrictEqual } from "node:util";
import { getRobbOperationsExtension } from '@craft-agent/shared/operations';
import { inheritMissionModelSettings } from "../mission-model-settings.ts";
import { type MissionExecutionInput, type MissionExecutionLifecycle, type MissionExecutionResult } from "../MissionRuntime.ts";
import { canonicalMissionWorkingDirectory } from "../mission-workspace-path.ts";
import type { SessionMissionExecutor } from '../SessionMissionExecutor.ts';
import { dispatchMarker, isTerminalReview, executionTimeout, canonicalSourceSlugs, terminalReviewBoundaryMismatch, ordinaryMissionRouteMismatch, pendingMissionRecoveryClaim, buildMissionSessionPrompt, parseResult, withTelemetry, sessionMarkerMessageId, recoveredTurnDurationMs, sessionMatchesPinnedSpecializedRoute } from './shared.ts';
import type { RequiredReviewInvocation, TerminalReviewSessionBoundary } from './shared.ts';

export async function executeUnmetered(transportOwner: SessionMissionExecutor, input: MissionExecutionInput, binding: MissionExecutionBinding, lifecycle: MissionExecutionLifecycle | undefined, startedAt: number): Promise<MissionExecutionResult> {
    if (binding.executorKind !== 'session' || binding.executionId !== input.dispatchId) {
        return { status: 'failed', reason: 'Mission dispatch binding does not match the session executor', retryable: false };
    }
    let missionWorkingDirectory: string;
    try {
        const canonicalCwd = canonicalMissionWorkingDirectory(transportOwner["options"].workspaceRoot, input.mission.cwd);
        if (input.ordinaryRoutePin && input.ordinaryRoutePin.cwd !== canonicalCwd) {
            throw new Error('ordinary route working directory drifted after admission');
        }
        missionWorkingDirectory = input.ordinaryRoutePin?.cwd ?? canonicalCwd;
    }
    catch (error) {
        return {
            status: 'failed',
            reason: `Mission working directory is invalid: ${error instanceof Error ? error.message : String(error)}`,
            retryable: false,
            ambiguousMutation: false,
        };
    }
    const reviewPreflight = await transportOwner["preflightRequiredReviewInvocations"](input, missionWorkingDirectory);
    if (!reviewPreflight.allowed) {
        return {
            status: 'failed',
            reason: reviewPreflight.reason,
            retryable: false,
            ambiguousMutation: false,
        };
    }
    if (input.ordinaryRoutePin && isTerminalReview(input)
        && !isDeepStrictEqual(canonicalSourceSlugs(reviewPreflight.enabledSourceSlugs), canonicalSourceSlugs(input.ordinaryRoutePin.effectiveSourceSlugs))) {
        return {
            status: 'failed',
            reason: 'Mission terminal-review sources do not match the host-owned ordinary route pin',
            retryable: false,
            ambiguousMutation: false,
        };
    }
    const collisions = transportOwner["options"].host.getSessions(transportOwner["options"].workspaceId)
        .filter((session) => session.missionDispatchId === input.dispatchId);
    if (collisions.length > 1 || collisions.some((session) => session.missionId !== input.mission.id || session.missionWorkItemId !== input.item.id)) {
        return { status: 'failed', reason: 'Mission dispatch identity collision in session storage', retryable: false };
    }
    let session = collisions[0];
    if (!session) {
        try {
            const terminalReview = isTerminalReview(input);
            const parent = input.mission.originSessionId
                ? transportOwner["options"].host.getSessions(transportOwner["options"].workspaceId).find(candidate => candidate.id === input.mission.originSessionId)
                : undefined;
            const pinnedAccount = getRobbOperationsExtension()?.connectionPolicy === 'pinned-account'
                ? parent?.llmConnection ?? transportOwner["options"].defaultLlmConnection
                : undefined;
            if (getRobbOperationsExtension()?.connectionPolicy === 'pinned-account' && !pinnedAccount) {
                throw new Error('Robb Operations requires an AI account on the originating mission session');
            }
            if (pinnedAccount && input.ordinaryRoutePin?.connectionSlug !== undefined
                && input.ordinaryRoutePin.connectionSlug !== pinnedAccount) {
                throw new Error('Mission route pin differs from the selected Robb Operations account');
            }
            session = await transportOwner["options"].host.createSession(transportOwner["options"].workspaceId, {
                name: `${input.profile.role}: ${input.item.title}`,
                parentSessionId: input.mission.originSessionId,
                projectId: input.mission.projectId,
                workingDirectory: missionWorkingDirectory,
                permissionMode: reviewPreflight.effectivePermissionMode,
                ...inheritMissionModelSettings(
                    pinnedAccount ? { ...input.profile, llmConnection: pinnedAccount, model: undefined } : input.profile,
                    parent, transportOwner["options"].defaultLlmConnection,
                ),
                enabledSourceSlugs: input.ordinaryRoutePin?.effectiveSourceSlugs
                    ?? reviewPreflight.enabledSourceSlugs,
                sessionStatus: 'in-progress',
                // Full inherited Execute uses the ordinary session tool surface. Every
                // Ask/Safe/default path keeps Mission's restrictive isolation envelope.
                // Terminal reviews remain read-only even under an Execute parent.
                ...(!input.specializedProfile && !terminalReview
                    && reviewPreflight.grantsFullToolAndNetworkAccess ? {} : {
                    executionIsolation: reviewPreflight.executionIsolation,
                }),
                missionId: input.mission.id,
                missionWorkItemId: input.item.id,
                missionDispatchId: input.dispatchId,
                missionRole: input.profile.role,
                ...(input.specializedProfile ? {
                    missionRouteLockSha256: input.specializedProfile.executionRouteSha256,
                } : {}),
            }, input.ordinaryRoutePin ? {
                missionOrdinaryRouteLock: structuredClone(input.ordinaryRoutePin),
            } : undefined);
        }
        catch (error) {
            return {
                status: 'failed',
                reason: `Could not create mission session: ${error instanceof Error ? error.message : String(error)}`,
                retryable: input.item.effect === 'read',
                ambiguousMutation: false,
            };
        }
    }
    const terminalReviewBoundary: TerminalReviewSessionBoundary | undefined = isTerminalReview(input)
        ? {
            permissionMode: 'safe',
            enabledSourceSlugs: canonicalSourceSlugs(reviewPreflight.enabledSourceSlugs),
            executionIsolation: reviewPreflight.executionIsolation,
        }
        : undefined;
    if (terminalReviewBoundary || input.ordinaryRoutePin) {
        const current = await transportOwner["options"].host.getSession(session.id);
        if (!current) {
            return {
                status: 'failed',
                reason: `Mission session ${session.id} disappeared before boundary verification`,
                retryable: false,
                ambiguousMutation: false,
            };
        }
        session = current;
    }
    const boundaryMismatch = terminalReviewBoundaryMismatch(session, terminalReviewBoundary);
    if (boundaryMismatch) {
        return {
            status: 'failed',
            reason: `Existing Mission review session cannot be resumed safely: ${boundaryMismatch}`,
            retryable: false,
            ambiguousMutation: false,
        };
    }
    const ordinaryRouteMismatch = ordinaryMissionRouteMismatch(input, session);
    if (ordinaryRouteMismatch) {
        return {
            status: 'failed',
            reason: `Mission ordinary route cannot be resumed safely: ${ordinaryRouteMismatch}`,
            retryable: false,
            ambiguousMutation: input.item.effect !== 'read',
        };
    }
    if (input.specializedProfile) {
        try {
            await transportOwner["options"].host.bindSpecializedMissionCapabilityLock(session.id, {
                schemaVersion: 1,
                capabilityEnvelopeSha256: input.specializedProfile.capabilityEnvelopeSha256,
                capabilities: [...input.specializedProfile.capabilityEnvelope],
            });
            session = await transportOwner["options"].host.getSession(session.id) ?? session;
        }
        catch (error) {
            return {
                status: 'failed',
                reason: `Could not seal specialized Mission capabilities: ${error instanceof Error ? error.message : String(error)}`,
                retryable: false,
                ambiguousMutation: false,
            };
        }
    }
    if (input.specializedProfile && !sessionMatchesPinnedSpecializedRoute(input, session)) {
        return {
            status: 'failed',
            reason: 'Mission specialist session route does not match its evaluated pinned route',
            retryable: false,
            ambiguousMutation: input.item.effect !== 'read',
        };
    }
    try {
        lifecycle?.bindExternalExecution(session.id);
    }
    catch (error) {
        return {
            status: 'failed',
            reason: `Could not durably bind mission session: ${error instanceof Error ? error.message : String(error)}`,
            retryable: false,
            ambiguousMutation: input.item.effect !== 'read',
        };
    }
    return transportOwner["runOrRecover"](input, session.id, lifecycle, startedAt, reviewPreflight.reviewInvocations, terminalReviewBoundary);
}

export async function runOrRecover(transportOwner: SessionMissionExecutor, input: MissionExecutionInput, sessionId: string, startedAt: number, reviewInvocations: readonly RequiredReviewInvocation[], lifecycle?: MissionExecutionLifecycle, terminalReviewBoundary?: TerminalReviewSessionBoundary): Promise<MissionExecutionResult> {
    const marker = dispatchMarker(input);
    const completion = transportOwner["waitForCompletion"](sessionId, executionTimeout(input, transportOwner["timeoutMs"]));
    let accepted = false;
    try {
        const current = await transportOwner["options"].host.getSession(sessionId);
        if (!current)
            return { status: 'failed', reason: `Mission session ${sessionId} disappeared`, retryable: false };
        const boundaryMismatch = terminalReviewBoundaryMismatch(current, terminalReviewBoundary);
        if (boundaryMismatch) {
            return {
                status: 'failed',
                reason: `Mission review session boundary drifted before provider dispatch: ${boundaryMismatch}`,
                retryable: false,
                ambiguousMutation: false,
            };
        }
        const ordinaryRouteMismatch = ordinaryMissionRouteMismatch(input, current);
        if (ordinaryRouteMismatch) {
            return {
                status: 'failed',
                reason: `Mission ordinary route drifted before provider dispatch: ${ordinaryRouteMismatch}`,
                retryable: false,
                ambiguousMutation: input.item.effect !== 'read',
            };
        }
        if (input.specializedProfile && !sessionMatchesPinnedSpecializedRoute(input, current)) {
            return {
                status: 'failed',
                reason: 'Mission specialist session route drifted before execution',
                retryable: false,
                ambiguousMutation: input.item.effect !== 'read',
            };
        }
        const acceptedMessageId = sessionMarkerMessageId(current, marker);
        if (acceptedMessageId) {
            lifecycle?.recordTurnAccepted(sessionId, acceptedMessageId);
            const finalText = transportOwner["options"].host.getSessionFinalText(sessionId);
            if (!current.isProcessing && finalText) {
                completion.cancel();
                return withTelemetry(parseResult(input, finalText), startedAt, current.tokenUsage, recoveredTurnDurationMs(current, acceptedMessageId));
            }
            if (!current.isProcessing) {
                if (!transportOwner["options"].host.claimAndResumePendingMissionTurn) {
                    completion.cancel();
                    return {
                        status: 'failed',
                        reason: 'A durable mission turn was accepted but has no terminal assistant output',
                        retryable: input.item.effect === 'read',
                        ambiguousMutation: input.item.effect !== 'read',
                    };
                }
                // waitForCompletion() was installed before this claim. A fast resumed
                // provider turn therefore cannot publish its terminal event between
                // ownership transfer and listener registration. Every Mission role
                // uses this path: otherwise a worker can race the generic restart
                // scheduler and continue outside its durable Mission journal.
                const resumed = await transportOwner["options"].host.claimAndResumePendingMissionTurn(sessionId, pendingMissionRecoveryClaim(input, current));
                if (!resumed.allowed) {
                    completion.cancel();
                    return {
                        status: 'failed',
                        reason: resumed.reason,
                        retryable: false,
                        ambiguousMutation: false,
                    };
                }
            }
        }
        else {
            await transportOwner["options"].host.sendMessage(sessionId, buildMissionSessionPrompt(input, reviewInvocations), undefined, undefined, {
                internalOrigin: {
                    kind: 'spawned-session',
                    senderSessionId: input.mission.originSessionId,
                },
            }, undefined, undefined, (messageId) => {
                accepted = true;
                lifecycle?.recordTurnAccepted(sessionId, messageId);
            });
        }
        const event = await completion.promise;
        if (event.reason !== 'complete') {
            return {
                status: 'failed',
                reason: `Mission session ended with ${event.reason}`,
                retryable: input.item.effect === 'read',
                ambiguousMutation: input.item.effect !== 'read',
            };
        }
        if (input.item.effect === 'external-mutation') {
            if (!event.executionProof || !transportOwner["options"].verifyExecutionProof) {
                return {
                    status: 'failed',
                    reason: 'External mutation completed without an authoritative reconciled execution proof',
                    retryable: false,
                    ambiguousMutation: true,
                };
            }
            const proof = transportOwner["options"].verifyExecutionProof(event.executionProof, {
                workspaceId: transportOwner["options"].workspaceId,
                missionId: input.mission.id,
                nodeId: input.item.id,
                idempotencyKey: input.dispatchId,
            });
            if (!proof.allowed) {
                return {
                    status: 'failed',
                    reason: `External mutation proof rejected: ${proof.code}: ${proof.reason}`,
                    retryable: false,
                    ambiguousMutation: true,
                };
            }
        }
        const finalSession = await transportOwner["options"].host.getSession(sessionId);
        if (!finalSession) {
            return {
                status: 'failed',
                reason: 'Mission session disappeared while execution was in flight',
                retryable: false,
                ambiguousMutation: input.item.effect !== 'read',
            };
        }
        const finalReviewBoundaryMismatch = terminalReviewBoundaryMismatch(finalSession, terminalReviewBoundary);
        if (finalReviewBoundaryMismatch) {
            return {
                status: 'failed',
                reason: `Mission review session boundary drifted while execution was in flight: ${finalReviewBoundaryMismatch}`,
                retryable: false,
                ambiguousMutation: input.item.effect !== 'read',
            };
        }
        const finalOrdinaryRouteMismatch = ordinaryMissionRouteMismatch(input, finalSession);
        if (finalOrdinaryRouteMismatch) {
            return {
                status: 'failed',
                reason: `Mission ordinary route drifted while execution was in flight: ${finalOrdinaryRouteMismatch}`,
                retryable: false,
                ambiguousMutation: input.item.effect !== 'read',
            };
        }
        if (input.specializedProfile && !sessionMatchesPinnedSpecializedRoute(input, finalSession)) {
            return {
                status: 'failed',
                reason: 'Mission specialist session route drifted while execution was in flight',
                retryable: false,
                ambiguousMutation: input.item.effect !== 'read',
            };
        }
        return withTelemetry(parseResult(input, event.finalText ?? transportOwner["options"].host.getSessionFinalText(sessionId) ?? ''), startedAt, event.tokenUsage);
    }
    catch (error) {
        completion.cancel();
        const reason = error instanceof Error ? error.message : String(error);
        return {
            status: 'failed',
            reason: accepted ? `Mission turn failed after durable acceptance: ${reason}` : `Mission turn was not accepted: ${reason}`,
            retryable: input.item.effect === 'read',
            ambiguousMutation: accepted && input.item.effect !== 'read',
        };
    }
    finally {
        completion.cancel();
    }
}
