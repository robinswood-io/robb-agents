import type { ManagedSession } from '../managed-session.ts';
import type { SessionOperationContext } from '../operation-context.ts';
import { isWorkspaceAutomaticToolFallbackEnabled, loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import type { PendingTurnRecovery } from '@craft-agent/shared/sessions';
import { buildCleanRecoveryContinuationPrompt } from '../../turn-recovery';
import { sessionLog } from '../runtime-platform.ts';
import { resumeAllocatedRecoveryDispatch as sessionOpResumeAllocatedRecoveryDispatch } from './dispatch-allocated-clean-retry.ts';
import { stopImmutableRestartRecovery as sessionOpStopImmutableRestartRecovery } from './exact-user-input-response.ts';
import { reclaimableUnobservedStartedRecoveryDispatch as sessionOpReclaimableUnobservedStartedRecoveryDispatch } from './create-autonomous-context-limit-handoff.ts';

export async function reclaimColdStartedDispatch(managed: ManagedSession, sessionOperationContext: SessionOperationContext, pending: PendingTurnRecovery, reclaimObjective: ManagedSession['activeObjective'], restartRecoveryStillAuthorized: () => boolean, sessionId: string): Promise<void> {
    if (await sessionOpStopImmutableRestartRecovery(sessionOperationContext, managed))
        return;
    // The immutable-lineage check awaits disk/child state. Stop, a new human
    // objective, or another recovery may supersede this candidate meanwhile.
    const currentReclaimable = managed.pendingTurnRecovery === pending
        && managed.activeObjective === reclaimObjective
        && restartRecoveryStillAuthorized()
        ? sessionOpReclaimableUnobservedStartedRecoveryDispatch(sessionOperationContext, managed, pending)
        : undefined;
    if (!currentReclaimable)
        return;
    if (!sessionOperationContext.owner["claimAutomaticAdmission"](managed))
        return;
    // Remove only the exact host prompt whose dispatch identity proved that
    // no provider activity followed it. Persist `allocated` before rebuilding
    // the transient FIFO, so another crash can replay the same identity but
    // can never mint or consume a further automatic attempt.
    const reclaimedPrompt = managed.messages[currentReclaimable.messageIndex]!;
    managed.messages.splice(currentReclaimable.messageIndex, 1);
    let reclaimedPending: PendingTurnRecovery = {
        ...pending,
        recoveryDispatch: currentReclaimable.allocatedDispatch,
    };
    const providerStateBeforeReclaim = {
        sdkSessionId: managed.sdkSessionId,
        branchFromSdkSessionId: managed.branchFromSdkSessionId,
        branchFromSessionPath: managed.branchFromSessionPath,
        branchFromSdkCwd: managed.branchFromSdkCwd,
        branchFromSdkTurnId: managed.branchFromSdkTurnId,
        branchContextStrategy: managed.branchContextStrategy,
        branchSeedApplied: managed.branchSeedApplied,
        providerContextBoundaryMessageId: managed.providerContextBoundaryMessageId,
        contextCompactionAttempt: managed.contextCompactionAttempt,
        transferredSessionSummary: managed.transferredSessionSummary,
        transferredSessionSummaryApplied: managed.transferredSessionSummaryApplied,
        tokenUsage: managed.tokenUsage ? { ...managed.tokenUsage } : undefined,
    };
    const disabledStartedFallback = !isWorkspaceAutomaticToolFallbackEnabled(loadWorkspaceConfig(managed.workspace.rootPath)) && !!currentReclaimable.allocatedDispatch.fallbackIntent;
    if (disabledStartedFallback) {
        const genericDispatch = { ...currentReclaimable.allocatedDispatch };
        delete genericDispatch.fallbackIntent;
        const genericPending = { ...reclaimedPending, recoveryDispatch: genericDispatch };
        const handoff = sessionOperationContext.owner["createAutonomousContextLimitHandoff"](managed, genericPending);
        if (!handoff || !buildCleanRecoveryContinuationPrompt(handoff)) {
            managed.messages.splice(currentReclaimable.messageIndex, 0, reclaimedPrompt);
            sessionOperationContext.state.automaticAdmissionReservations.delete(managed.id);
            sessionLog.error('Refused to replay a disabled started routing fallback without a clean handoff', {
                sessionId: managed.id,
                dispatchId: genericDispatch.id,
            });
            return;
        }
        const cleanDispatch = { ...genericDispatch, cleanContinuationId: handoff.id };
        reclaimedPending = {
            ...genericPending,
            recoveryDispatch: cleanDispatch,
            cleanContextBoundaryMessageId: cleanDispatch.id,
        };
        const finalHandoff = sessionOperationContext.owner["createAutonomousContextLimitHandoff"](managed, reclaimedPending);
        const finalPrompt = finalHandoff && buildCleanRecoveryContinuationPrompt(finalHandoff);
        if (!finalHandoff || finalHandoff.id !== cleanDispatch.cleanContinuationId
            || !finalPrompt) {
            managed.messages.splice(currentReclaimable.messageIndex, 0, reclaimedPrompt);
            sessionOperationContext.state.automaticAdmissionReservations.delete(managed.id);
            sessionLog.error('Refused an unstable clean handoff for a disabled started routing fallback', {
                sessionId: managed.id,
                dispatchId: genericDispatch.id,
            });
            return;
        }
        managed.sdkSessionId = undefined;
        managed.branchFromSdkSessionId = undefined;
        managed.branchFromSessionPath = undefined;
        managed.branchFromSdkCwd = undefined;
        managed.branchFromSdkTurnId = undefined;
        managed.branchContextStrategy = undefined;
        managed.branchSeedApplied = true;
        managed.providerContextBoundaryMessageId = cleanDispatch.id;
        managed.contextCompactionAttempt = undefined;
        managed.transferredSessionSummary = undefined;
        managed.transferredSessionSummaryApplied = undefined;
        if (managed.tokenUsage) {
            managed.tokenUsage = {
                ...managed.tokenUsage,
                contextTokens: Math.max(1, Math.ceil(finalPrompt.length / 4)),
            };
        }
    }
    managed.pendingTurnRecovery = reclaimedPending;
    sessionOperationContext.owner["persistSession"](managed);
    try {
        await sessionOperationContext.owner.flushSession(managed.id);
    }
    catch (error) {
        // The conversion was not ACKed. Restore the exact pre-conversion state
        // only if it still belongs to this objective; never overwrite a Stop or
        // newer objective that won while the flush was pending.
        if (sessionOperationContext.state.sessions.get(sessionId) === managed
            && managed.pendingTurnRecovery === reclaimedPending
            && managed.activeObjective === reclaimObjective
            && !managed.stopRequested) {
            if (!managed.messages.some(message => message.id === reclaimedPrompt.id)) {
                managed.messages.splice(Math.min(currentReclaimable.messageIndex, managed.messages.length), 0, reclaimedPrompt);
            }
            managed.pendingTurnRecovery = pending;
            managed.sdkSessionId = providerStateBeforeReclaim.sdkSessionId;
            managed.branchFromSdkSessionId = providerStateBeforeReclaim.branchFromSdkSessionId;
            managed.branchFromSessionPath = providerStateBeforeReclaim.branchFromSessionPath;
            managed.branchFromSdkCwd = providerStateBeforeReclaim.branchFromSdkCwd;
            managed.branchFromSdkTurnId = providerStateBeforeReclaim.branchFromSdkTurnId;
            managed.branchContextStrategy = providerStateBeforeReclaim.branchContextStrategy;
            managed.branchSeedApplied = providerStateBeforeReclaim.branchSeedApplied;
            managed.providerContextBoundaryMessageId = providerStateBeforeReclaim.providerContextBoundaryMessageId;
            managed.contextCompactionAttempt = providerStateBeforeReclaim.contextCompactionAttempt;
            managed.transferredSessionSummary = providerStateBeforeReclaim.transferredSessionSummary;
            managed.transferredSessionSummaryApplied = providerStateBeforeReclaim.transferredSessionSummaryApplied;
            managed.tokenUsage = providerStateBeforeReclaim.tokenUsage;
            sessionOperationContext.state.deferredAutomaticSessions.add(sessionId);
            sessionOperationContext.owner["persistSession"](managed);
            try {
                await sessionOperationContext.owner.flushSession(managed.id);
            }
            catch (rollbackError) {
                sessionLog.warn('Failed to flush automatic recovery reclaim rollback', {
                    sessionId,
                    dispatchId: pending.recoveryDispatch?.id,
                    error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
                });
            }
        }
        throw error;
    }
    if (sessionOperationContext.state.shuttingDown || !restartRecoveryStillAuthorized()
        || managed.pendingTurnRecovery !== reclaimedPending || managed.activeObjective !== reclaimObjective
        || managed.isProcessing)
        return;
    if (sessionOpResumeAllocatedRecoveryDispatch(sessionOperationContext, managed, reclaimedPending)) {
        sessionLog.warn('Reclaimed automatic recovery dispatch with no persisted provider activity', {
            sessionId: managed.id,
            originalUserMessageId: reclaimedPending.userMessageId,
            cause: currentReclaimable.allocatedDispatch.cause,
            attempt: currentReclaimable.allocatedDispatch.attempt,
            dispatchId: currentReclaimable.allocatedDispatch.id,
        });
    }
    return;
}


