import type { SessionOperationContext } from '../operation-context.ts';
import { validAllocatedRecoveryDispatch, persistenceRootFor, reconcileCompletedChatRetention } from '../policy.ts';
import { setPermissionMode, hydratePreviousPermissionMode } from '@craft-agent/shared/agent';
import { getLlmConnection, getWorkspaces } from '@craft-agent/shared/config';
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import { listSessions as listStoredSessions, loadSession as loadStoredSession, captureSessionPersistenceRootPath } from '@craft-agent/shared/sessions';
import { storedToMessage } from '@craft-agent/core/types';
import { loadStatusConfig } from '@craft-agent/shared/statuses/storage';
import { isClosedSessionStatus } from '../../session-status-lifecycle';
import { hasAvailableExplicitRetryAllowance, exhaustPendingTurnRecovery, hasObjectiveContinuationProvenance } from '../../turn-recovery';
import { isMissionRuntimeOwnedRecovery, isTerminalReviewSession, terminalReviewExecutionIsolation } from '../review-lifecycle.ts';
import { sessionLog } from '../runtime-platform.ts';
import { createManagedSession, repairPersistedFalseCompletion } from '../session-creation.ts';
import { resolveEffectiveSessionSourceSelection } from '../source-selection.ts';
import { LEGACY_AUTOMATIC_RECOVERY_NEXT_STEP_QUESTION, isExactContextLimitNextStepQuestion } from '../user-input-authority.ts';
import { hydrateMessagesForColdPersist as sessionOpHydrateMessagesForColdPersist, drainDeferredAutomaticSessions as sessionOpDrainDeferredAutomaticSessions } from './drain-deferred-automatic-sessions.ts';
import { pendingRecoveryBelongsToCurrentObjective as sessionOpPendingRecoveryBelongsToCurrentObjective } from './pending-recovery-belongs-to-current-objective.ts';
import { preserveInterruptedObjectiveContinuation as sessionOpPreserveInterruptedObjectiveContinuation, hasExhaustedValidation as sessionOpHasExhaustedValidation } from './reconcile-provider-acceptance-unknown-for-retry.ts';
import { retireProvenObsoleteReadAmendmentQuestion as sessionOpRetireProvenObsoleteReadAmendmentQuestion } from './retryable-context-limit-request.ts';
import { hasTerminalObjectiveState as sessionOpHasTerminalObjectiveState } from './repair-legacy-synthetic-objective-authority.ts';
import { getPendingUserInputResponse as sessionOpGetPendingUserInputResponse } from './user-input-recovery.ts';
import { isManagedSessionYolo as sessionOpIsManagedSessionYolo } from './is-managed-session-yolo.ts';
import { retireYoloHumanHandoffs as sessionOpRetireYoloHumanHandoffs } from './retire-yolo-human-handoffs.ts';
import { resumeOrphanedContextAnswerAfterRestart as sessionOpResumeOrphanedContextAnswerAfterRestart } from './restore-pre-ack-agent-delivery-dequeues.ts';
import { ensureDelegatedTerminalResultDelivery as sessionOpEnsureDelegatedTerminalResultDelivery, scheduleDelegatedTerminalResultRetry as sessionOpScheduleDelegatedTerminalResultRetry } from './ensure-delegated-terminal-result-delivery.ts';
import { isCurrentDelegatedDescendant as sessionOpIsCurrentDelegatedDescendant } from './is-current-delegated-descendant.ts';

// Load all existing sessions from disk into memory (metadata only - messages are lazy-loaded)
function sessionOpLoadSessionsFromDisk(sessionOperationContext: SessionOperationContext): void {
    try {
        const workspaces = getWorkspaces();
        let totalSessions = 0;
        const pendingRecoverySessionIds: string[] = [];
        const orphanedContextAnswerSessionIds: string[] = [];
        const pendingInboxSessionIds: string[] = [];
        const terminalDelegatedSessionIds: string[] = [];
        // Iterate over each workspace and load its sessions
        for (const workspace of workspaces) {
            const workspaceRootPath = workspace.rootPath;
            reconcileCompletedChatRetention(captureSessionPersistenceRootPath(workspaceRootPath));
            const sessionMetadata = listStoredSessions(workspaceRootPath);
            // Load workspace config once per workspace for default working directory
            const wsConfig = loadWorkspaceConfig(workspaceRootPath);
            const statusConfig = loadStatusConfig(workspaceRootPath);
            const wsDefaultWorkingDir = wsConfig?.defaults?.workingDirectory;
            for (const meta of sessionMetadata) {
                const sourceSelection = resolveEffectiveSessionSourceSelection(meta.enabledSourceSlugs, wsConfig?.defaults?.enabledSourceSlugs);
                // Create managed session from metadata only (messages lazy-loaded on demand)
                // This dramatically reduces memory usage at startup - messages are loaded
                // when getSession() is called for a specific session
                const managed = createManagedSession(meta, workspace, {
                    // The header carries only an explicit session selection. Materialize
                    // the current workspace fallback now so the first renderer snapshot,
                    // routing sensitivity and MCP setup all see the same effective list.
                    ...sourceSelection,
                    workingDirectory: meta.workingDirectory ?? wsDefaultWorkingDir,
                });
                const restoredLineageChanged = managed.parentSessionId !== meta.parentSessionId
                    || JSON.stringify(managed.labels ?? []) !== JSON.stringify(meta.labels ?? []);
                // Reconcile legacy final receipts before publishing the metadata-only
                // catalogue. An old host could persist complete_verified although
                // its own final explicitly said work remained. Never replay actions.
                let restoredFalseCompletion = false;
                if (managed.activeObjective?.terminalState === 'complete_verified'
                    && !managed.activeObjective.lastOutcome && managed.lastFinalMessageId) {
                    const stored = loadStoredSession(persistenceRootFor(managed), managed.id);
                    const matchingFinals = stored?.messages?.filter(message => message.id === managed.lastFinalMessageId) ?? [];
                    if (matchingFinals.length === 1) {
                        restoredFalseCompletion = repairPersistedFalseCompletion(managed, storedToMessage(matchingFinals[0]!));
                    }
                }
                // Older hosts left a generic question pending at the retry ceiling.
                // Retire only that exact, unanswered host shape, then let the normal
                // terminal child-result path report the bounded failure to its parent.
                let restoredExhaustedRecoveryQuestion = false;
                const legacyExhaustionRequest = managed.userInputRequests?.find(request => request.status === 'pending'
                    && request.sessionId === managed.id
                    && request.originWorkspaceId === managed.workspace.id
                    && request.objectiveUserMessageId === managed.activeObjective?.userMessageId
                    && !request.responseMessageId
                    && request.questions.length === 1
                    && JSON.stringify(request.questions[0]) === JSON.stringify(LEGACY_AUTOMATIC_RECOVERY_NEXT_STEP_QUESTION));
                if (legacyExhaustionRequest && managed.activeObjective?.terminalState === 'active') {
                    // The header alone cannot authenticate the recovery anchor. Load
                    // its saved root before preserving an explicit Retry snapshot.
                    sessionOpHydrateMessagesForColdPersist(sessionOperationContext, managed);
                    legacyExhaustionRequest.status = 'cancelled';
                    legacyExhaustionRequest.answeredAt = Math.max(Date.now(), legacyExhaustionRequest.createdAt + 1);
                    const pending = managed.pendingTurnRecovery;
                    if (pending && sessionOpPendingRecoveryBelongsToCurrentObjective(sessionOperationContext, managed, pending)) {
                        managed.pendingTurnRecovery = exhaustPendingTurnRecovery({
                            ...pending, validationExhausted: true,
                        });
                        if (!sessionOpPreserveInterruptedObjectiveContinuation(sessionOperationContext, managed)) {
                            managed.pendingTurnRecovery = undefined;
                            managed.activeObjective.terminalState = 'exhausted';
                        }
                    }
                    else {
                        managed.activeObjective.terminalState = 'exhausted';
                    }
                    restoredExhaustedRecoveryQuestion = true;
                }
                // A previous host asked the user to authorize replacing bounded
                // Read checks because Pi appended its own pagination notice. Once
                // every unchanged registered check passes against its exact stored
                // observation, that technical question is obsolete; preserve the
                // current recovery marker so the reviewer can finish on restart.
                const restoredObsoleteReadQuestion = sessionOpRetireProvenObsoleteReadAmendmentQuestion(sessionOperationContext, managed);
                // Keep missing explicit connections visible. The next send must fail
                // until the user selects a replacement, rather than change providers.
                if (managed.llmConnection && !getLlmConnection(managed.llmConnection)) {
                    sessionLog.warn(`Session ${meta.id} references unavailable connection "${managed.llmConnection}"; keeping its selection`);
                }
                // Initialize mode-manager state for restored sessions even before agent creation.
                // This keeps diagnostics/effective mode aligned with persisted session metadata.
                let restoredReviewBoundaryChanged = false;
                if (managed.permissionMode && !['safe', 'ask', 'allow-all'].includes(managed.permissionMode)) {
                    sessionLog.warn('Invalid persisted permission mode restored as safe; explicit valid mode selection required', { sessionId: meta.id });
                    managed.permissionMode = 'safe';
                    restoredReviewBoundaryChanged = true;
                }
                if (isTerminalReviewSession(managed)) {
                    const reviewIsolation = terminalReviewExecutionIsolation(managed.executionIsolation, workspace.rootPath);
                    if (managed.permissionMode !== 'safe')
                        restoredReviewBoundaryChanged = true;
                    if (JSON.stringify(managed.executionIsolation) !== JSON.stringify(reviewIsolation)) {
                        restoredReviewBoundaryChanged = true;
                    }
                    managed.permissionMode = 'safe';
                    managed.executionIsolation = reviewIsolation;
                }
                if (restoredReviewBoundaryChanged || restoredLineageChanged
                    || restoredFalseCompletion || restoredExhaustedRecoveryQuestion
                    || restoredObsoleteReadQuestion) {
                    sessionOperationContext.owner["persistSession"](managed);
                }
                setPermissionMode(meta.id, managed.permissionMode ?? 'ask', { changedBy: 'restore' });
                if (managed.previousPermissionMode) {
                    hydratePreviousPermissionMode(meta.id, managed.previousPermissionMode);
                }
                if (managed.pendingTurnRecovery?.waitingForPermission) {
                    managed.pendingTurnRecovery = {
                        ...managed.pendingTurnRecovery,
                        waitingForPermission: { ...managed.pendingTurnRecovery.waitingForPermission, recoveryRequired: true },
                    };
                }
                sessionOperationContext.state.sessions.set(meta.id, managed);
                // Old hard-limit gates could accept an ordinary structured answer,
                // cancel their follow-up, and leave no recovery marker. The saved
                // transcript authenticates this narrow metadata hint below.
                if (!managed.pendingTurnRecovery && managed.activeObjective?.terminalState === 'active'
                    && managed.lastMessageRole === 'user'
                    && managed.contextCompactionAttempt?.hardLimitFollowUpAttempted === true
                    && (managed.tokenUsage?.contextTokens ?? 0)
                        >= (managed.contextCompactionAttempt.hardLimitTokens ?? Infinity)
                    && managed.userInputRequests?.some(request => (request.status === 'answered' && !!request.responseMessageId
                        && !isExactContextLimitNextStepQuestion(request)
                        && request.sessionId === managed.id
                        && request.originWorkspaceId === managed.workspace.id
                        && request.objectiveUserMessageId === managed.activeObjective?.userMessageId))) {
                    orphanedContextAnswerSessionIds.push(meta.id);
                }
                if (managed.delegation && (managed.delegation.finishedAt || sessionOpHasTerminalObjectiveState(sessionOperationContext, managed))) {
                    terminalDelegatedSessionIds.push(meta.id);
                }
                // Auth handoffs have no active-turn marker. Load only these indexed
                // waits so the initial root/child DTO can render their saved form.
                if (meta.pendingAuthRequestId)
                    sessionOpHydrateMessagesForColdPersist(sessionOperationContext, managed);
                if (meta.pendingQueuedMessageIds?.length || meta.pendingAgentDeliveryIds?.length)
                    pendingInboxSessionIds.push(meta.id);
                if (managed.pendingTurnRecovery) {
                    const pendingRecovery = managed.pendingTurnRecovery;
                    const closedForRecovery = isClosedSessionStatus(statusConfig, managed.sessionStatus);
                    const objectiveClosedForRecovery = managed.activeObjective?.terminalState != null
                        && managed.activeObjective.terminalState !== 'active';
                    const retainedExpiredPermissionBlock = !closedForRecovery
                        && managed.activeObjective?.terminalState === 'blocked_human'
                        && pendingRecovery.waitingForPermission?.recoveryRequired === true;
                    // Header metadata is only a hydration hint. It may keep an exact
                    // answered-response candidate alive long enough for the transcript
                    // and FIFO to authenticate it below, but it never authorizes a
                    // provider admission on its own.
                    const answeredRecoveryHydrationHint = managed.userInputRequests?.some(request => (request.status === 'answered'
                        && request.responseMessageId === pendingRecovery.userMessageId
                        && request.sessionId === managed.id
                        && request.originWorkspaceId === managed.workspace.id
                        && request.objectiveUserMessageId === managed.activeObjective?.userMessageId)) === true;
                    const humanRecovery = pendingRecovery.lastCause === 'user_retry'
                        || answeredRecoveryHydrationHint
                        || !!sessionOpGetPendingUserInputResponse(sessionOperationContext, managed, true);
                    const activeObjectiveId = managed.activeObjective?.terminalState === 'active'
                        ? managed.activeObjective.objectiveId ?? managed.activeObjective.userMessageId
                        : undefined;
                    const resumableExhaustedRecovery = pendingRecovery.lastCause === 'user_retry'
                        || !!validAllocatedRecoveryDispatch(pendingRecovery)
                        || hasAvailableExplicitRetryAllowance(pendingRecovery, activeObjectiveId)
                        || humanRecovery;
                    if ((closedForRecovery || (objectiveClosedForRecovery && !humanRecovery)) && !retainedExpiredPermissionBlock) {
                        sessionLog.warn('Clearing stale restart recovery marker for terminal session', {
                            sessionId: meta.id,
                            sessionStatus: managed.sessionStatus,
                            objectiveTerminalState: managed.activeObjective?.terminalState,
                        });
                        sessionOperationContext.owner["clearPendingTurnRecovery"](managed);
                        sessionOperationContext.owner["persistSession"](managed);
                    }
                    else if (retainedExpiredPermissionBlock) {
                        // This terminal marker is explicit Retry context, not automatic
                        // restart authority. Keep it visible but never enqueue it.
                    }
                    else if (pendingRecovery.exhaustedAt
                        && hasObjectiveContinuationProvenance(pendingRecovery)
                        && managed.activeObjective?.terminalState === 'active'
                        && !resumableExhaustedRecovery) {
                        // The process may have exited after durably exhausting the retry
                        // budget but before the live completion path moved it into the
                        // explicit-Retry snapshot. Finish that transition during cold
                        // metadata hydration. The transcript must authenticate the
                        // recovery before its counters/work can become Retry authority.
                        sessionOpHydrateMessagesForColdPersist(sessionOperationContext, managed);
                        if (!sessionOpPreserveInterruptedObjectiveContinuation(sessionOperationContext, managed)) {
                            const recoveryUserMessageId = managed.pendingTurnRecovery?.userMessageId;
                            managed.pendingTurnRecovery = undefined;
                            managed.activeObjective.interruptedTurnRecovery = undefined;
                            sessionLog.warn('Revoked exhausted recovery with stale objective provenance', {
                                sessionId: managed.id,
                                objectiveId: managed.activeObjective.objectiveId ?? managed.activeObjective.userMessageId,
                                recoveryUserMessageId,
                            });
                        }
                        sessionOperationContext.owner["persistSession"](managed);
                    }
                    else if ((!sessionOpHasExhaustedValidation(sessionOperationContext, managed) || humanRecovery)
                        && (!pendingRecovery.exhaustedAt || resumableExhaustedRecovery)) {
                        if (isMissionRuntimeOwnedRecovery(managed)) {
                            sessionOperationContext.state.missionRuntimeOwnedRestoredRecoverySessionIds.add(managed.id);
                            sessionLog.info('Deferred Mission recovery to MissionRuntime ownership', {
                                sessionId: managed.id,
                                missionId: managed.missionId,
                                missionWorkItemId: managed.missionWorkItemId,
                                missionDispatchId: managed.missionDispatchId,
                            });
                        }
                        else {
                            pendingRecoverySessionIds.push(meta.id);
                        }
                    }
                }
                // Initialize session metadata in AutomationSystem for diffing
                const automationSystem = sessionOperationContext.state.automationSystems.get(workspaceRootPath);
                if (automationSystem) {
                    automationSystem.setInitialSessionMetadata(meta.id, {
                        permissionMode: meta.permissionMode,
                        labels: managed.labels,
                        isFlagged: meta.isFlagged,
                        sessionStatus: meta.sessionStatus,
                        sessionName: managed.name,
                    });
                }
                totalSessions++;
            }
        }
        sessionLog.info(`Loaded ${totalSessions} sessions from disk (metadata only)`);
        // A turn marker survives a host update/crash. Resume only after the
        // complete session catalogue has been restored so source/session lookups
        // behave exactly like a normal user send.
        setImmediate(() => {
            void (async () => {
                if (sessionOperationContext.state.shuttingDown)
                    return;
                // Retire legacy unanswered handoffs before any provider recovery.
                // Every transition is flushed; cancellation never becomes an answer.
                for (const managed of sessionOperationContext.state.sessions.values()) {
                    if (sessionOpIsManagedSessionYolo(sessionOperationContext, managed)) {
                        await sessionOpRetireYoloHumanHandoffs(sessionOperationContext, managed);
                    }
                }
                await sessionOperationContext.owner["resumePendingTurnsAfterRestart"](pendingRecoverySessionIds);
                for (const id of orphanedContextAnswerSessionIds) {
                    try {
                        await sessionOpResumeOrphanedContextAnswerAfterRestart(sessionOperationContext, id);
                    }
                    catch (error) {
                        sessionLog.warn('Cold authenticated context answer recovery failed', {
                            sessionId: id,
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                }
                for (const id of pendingInboxSessionIds) {
                    const managed = sessionOperationContext.state.sessions.get(id);
                    if (managed)
                        await sessionOperationContext.owner["ensureMessagesLoaded"](managed);
                }
                // A child may have reached a durable terminal state immediately
                // before the host exited, without appending its parent receipt. The
                // deterministic delivery key makes this reconciliation idempotent.
                for (const id of terminalDelegatedSessionIds) {
                    const child = sessionOperationContext.state.sessions.get(id);
                    if (!child)
                        continue;
                    try {
                        const delivered = await sessionOpEnsureDelegatedTerminalResultDelivery(sessionOperationContext, child);
                        if (!delivered) {
                            const parent = child.parentSessionId ? sessionOperationContext.state.sessions.get(child.parentSessionId) : undefined;
                            if (parent && sessionOpIsCurrentDelegatedDescendant(sessionOperationContext, parent, child)) {
                                sessionOpScheduleDelegatedTerminalResultRetry(sessionOperationContext, child.id);
                            }
                        }
                    }
                    catch (error) {
                        sessionLog.warn('Cold delegated terminal result reconciliation failed', {
                            childSessionId: child.id,
                            error: error instanceof Error ? error.message : String(error),
                        });
                        sessionOpScheduleDelegatedTerminalResultRetry(sessionOperationContext, child.id);
                    }
                }
                if (sessionOperationContext.state.deferredAutomaticSessions.size > 0) {
                    await sessionOpDrainDeferredAutomaticSessions(sessionOperationContext);
                }
            })().catch(error => sessionLog.error('Durable inbox recovery failed', error));
        });
    }
    catch (error) {
        sessionLog.error('Failed to load sessions from disk:', error);
    }
}

export { sessionOpLoadSessionsFromDisk as loadSessionsFromDisk };
