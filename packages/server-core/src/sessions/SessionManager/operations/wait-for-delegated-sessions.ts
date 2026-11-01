import { omitUndefined } from '@craft-agent/shared/utils/json';
import type { SessionOperationContext } from '../operation-context.ts';
import { waitForSessionChange } from '../../session-wait';
import { buildSessionWaitDiagnostic } from '../../session-wait-diagnostic';
import { isSessionDescendant } from '../../autonomous-session-admission';
import { objectiveReviewBinding } from '../../objective-contract';
import type { ManagedSession } from '../managed-session.ts';
import { resolveObjectiveMutationAuthority as sessionOpResolveObjectiveMutationAuthority } from './resolve-objective-mutation-authority.ts';
import { isCleanSetupRetryBlocked as sessionOpIsCleanSetupRetryBlocked } from './pending-recovery-belongs-to-current-objective.ts';
import { isCleanSetupPersistenceFenced as sessionOpIsCleanSetupPersistenceFenced } from './start-recovery-dispatch.ts';
import { hasExhaustedValidation as sessionOpHasExhaustedValidation } from './reconcile-provider-acceptance-unknown-for-retry.ts';
import { autonomousAdmissionBlock as sessionOpAutonomousAdmissionBlock, hasQueuedHumanAuthority as sessionOpHasQueuedHumanAuthority } from './exact-user-input-response.ts';
import { hasPendingDecision as sessionOpHasPendingDecision } from './repair-legacy-synthetic-objective-authority.ts';
import { providerDispatchAcceptanceUnknown as sessionOpProviderDispatchAcceptanceUnknown } from './reconcile-live-provider-dispatch-uncertainty.ts';

/** One host subscription per wait; repeated finished siblings never cause polling. */
async function sessionOpWaitForDelegatedSessions(sessionOperationContext: SessionOperationContext, caller: ManagedSession, sessionIds: string[], timeoutMs: number, afterCursors?: Record<string, string>, mode: import('@craft-agent/session-tools-core').WaitSessionsMode = 'first'): Promise<import('@craft-agent/session-tools-core').WaitSessionsResult> {
    const ids = [...new Set(sessionIds)];
    if (ids.length < 1 || ids.length > 8 || ids.includes(caller.id))
        throw new Error('Invalid delegated wait targets');
    const waitTargetAllowed = (id: string): boolean => {
        const target = sessionOperationContext.state.sessions.get(id);
        if (!target || target.workspace.id !== caller.workspace.id
            || !isSessionDescendant(id, caller.id, candidate => sessionOperationContext.state.sessions.get(candidate)))
            return false;
        const authority = sessionOpResolveObjectiveMutationAuthority(sessionOperationContext, caller, caller.activeObjective);
        const policy = authority.terminalReconciliationPolicy;
        if (policy)
            return policy.kind === 'terminal-reconciliation'
                && policy.waitReviewerSessionIds.includes(id)
                && target.parentSessionId === caller.id
                && target.delegation?.role === 'reviewer'
                && target.delegation.rootSessionId === caller.id
                && target.delegation.depth === 1
                && !!caller.activeObjective
                && target.delegation.rootObjectiveId
                    === objectiveReviewBinding(caller.activeObjective).objectiveId
                && target.delegation.parentObjectiveId
                    === objectiveReviewBinding(caller.activeObjective).objectiveId
                && target.delegation.reviewBinding?.objectiveId
                    === objectiveReviewBinding(caller.activeObjective).objectiveId
                && target.delegation.reviewBinding.acceptanceSha256
                    === objectiveReviewBinding(caller.activeObjective).acceptanceSha256;
        // A persisted terminal reviewer binding is never a generic delegation.
        // Once its parent leaves that exact terminal policy (for example after a
        // retarget that retains the objective root id), the old reviewer cannot
        // be waited on or reused through the legacy lineage fallback.
        if (target.delegation?.reviewBinding)
            return false;
        if (!target.delegation)
            return false;
        const root = sessionOperationContext.state.sessions.get(target.delegation.rootSessionId);
        const parent = target.parentSessionId ? sessionOperationContext.state.sessions.get(target.parentSessionId) : undefined;
        return !!root?.activeObjective && !!parent?.activeObjective
            && root.workspace.id === caller.workspace.id && parent.workspace.id === caller.workspace.id
            && (root.activeObjective.objectiveId ?? root.activeObjective.userMessageId)
                === target.delegation.rootObjectiveId
            && (parent.activeObjective.objectiveId ?? parent.activeObjective.userMessageId)
                === target.delegation.parentObjectiveId;
    };
    const assertWaitTargets = () => {
        if (ids.some(id => !waitTargetAllowed(id))) {
            throw new Error('Wait targets must be current delegated descendants; terminal reconciliation permits only direct reviewers bound to the exact current objective and acceptance SHA.');
        }
    };
    assertWaitTargets();
    // Restore actual persisted final messages only for visible targets. An idle
    // session alone is never upgraded to a verified success receipt.
    await Promise.all(ids.map(async (id) => {
        const target = sessionOperationContext.state.sessions.get(id);
        if (target?.workspace.id === caller.workspace.id && !target.isProcessing)
            await sessionOperationContext.owner["ensureMessagesLoaded"](target);
    }));
    assertWaitTargets();
    const waitOnce = (waitTimeoutMs: number, previous: Record<string, string>) => waitForSessionChange({
        previous, timeoutMs: waitTimeoutMs,
        snapshot: () => ids.map(sessionId => {
            const target = sessionOperationContext.state.sessions.get(sessionId);
            if (!target || !waitTargetAllowed(sessionId))
                return { sessionId, state: 'missing' as const };
            const objectiveState = target.activeObjective?.terminalState;
            const terminal = !!objectiveState && objectiveState !== 'active';
            const setupDispatch = target.pendingTurnRecovery?.recoveryDispatch;
            const setupBlocked = sessionOpIsCleanSetupRetryBlocked(sessionOperationContext, setupDispatch);
            const setupPersistenceFenced = sessionOpIsCleanSetupPersistenceFenced(sessionOperationContext, target, setupDispatch);
            // A retained machine inbox is not runnable work. Human continuations
            // retain their own authority, while capacity waits remain active.
            const autonomousContinuation = !terminal && !target.stopRequested
                && !setupBlocked && !setupPersistenceFenced
                && !sessionOpHasExhaustedValidation(sessionOperationContext, target) && !sessionOpAutonomousAdmissionBlock(sessionOperationContext, target, false, false);
            const queuedContinuation = target.messageQueue.length > 0
                && (sessionOpHasQueuedHumanAuthority(sessionOperationContext, target) || autonomousContinuation);
            const recovering = !!target.pendingTurnRecovery && objectiveState === 'active' && autonomousContinuation;
            const active = target.isProcessing || queuedContinuation || recovering
                || (!terminal && !setupBlocked && !setupPersistenceFenced
                    && sessionOperationContext.state.automaticAdmissionReservations.has(target.id));
            const needsAttention = sessionOperationContext.owner["hasPendingUserInput"](target) || sessionOpHasPendingDecision(sessionOperationContext, target)
                || !!sessionOpProviderDispatchAcceptanceUnknown(sessionOperationContext, target)
                || setupBlocked || setupPersistenceFenced
                || (!active && terminal && objectiveState !== 'complete_verified');
            const event = target.lastWaitCompletion?.generation === target.processingGeneration
                ? target.lastWaitCompletion.event : undefined;
            // A later host validation stop invalidates a prior completion receipt,
            // even if no provider generation has run since that receipt was emitted.
            const verifiedFinalState = !objectiveState || objectiveState === 'complete_verified';
            const completionReason = event?.reason === 'complete' && !verifiedFinalState ? undefined : event?.reason;
            const restoredVerified = !active && !target.pendingTurnRecovery && objectiveState === 'complete_verified';
            const finalMessageId = verifiedFinalState ? event?.finalMessageId ?? (restoredVerified ? target.lastFinalMessageId : undefined) : undefined;
            const finalText = verifiedFinalState ? event?.finalText ?? (finalMessageId ? target.messages.find(m => m.id === finalMessageId && m.role === 'assistant' && !m.isIntermediate)?.content : undefined) : undefined;
            const diagnostic = !active && terminal && !verifiedFinalState
                && !sessionOperationContext.owner["hasPendingUserInput"](target) && !sessionOpHasPendingDecision(sessionOperationContext, target)
                ? buildSessionWaitDiagnostic({ ...(target.activeObjective !== undefined ? { objective: target.activeObjective } : {}), messages: target.messages,
                    ...(target.pendingTurnRecovery !== undefined ? { pending: target.pendingTurnRecovery } : {}), processingGeneration: target.processingGeneration,
                    ...(target.waitDiagnosticBoundary !== undefined ? { boundary: target.waitDiagnosticBoundary } : {}), ...(target.lastFinalMessageId !== undefined ? { lastFinalMessageId: target.lastFinalMessageId } : {}) }) : undefined;
            return omitUndefined({
                sessionId, state: active && !needsAttention ? 'active' as const : 'idle' as const,
                status: target.sessionStatus ?? 'todo', processingGeneration: target.processingGeneration, objectiveState,
                ...(needsAttention ? { needsAttention: true } : {}),
                ...(diagnostic ? { diagnostic } : {}),
                ...(!active && !needsAttention ? {
                    reason: completionReason ?? (restoredVerified ? 'complete' as const : undefined),
                    finalMessageId,
                    ...(finalText !== undefined ? { finalText: finalText.slice(0, 32000), ...(finalText.length > 32000 ? { finalTextTruncated: true } : {}) } : {}),
                } : {}),
            });
        }),
        subscribe: wake => {
            const listener = (id: string) => { if (ids.includes(id))
                wake(); };
            sessionOperationContext.state.sessionWaitListeners.add(listener);
            return () => { sessionOperationContext.state.sessionWaitListeners.delete(listener); };
        },
    });
    const initialCursors = { ...caller.waitCursors, ...afterCursors };
    let result: import('@craft-agent/session-tools-core').WaitSessionsResult;
    if (mode === 'first') {
        result = await waitOnce(timeoutMs, initialCursors);
    }
    else {
        const deadline = Date.now() + timeoutMs;
        const cursors = { ...initialCursors };
        const accumulated = new Map<string, import('@craft-agent/session-tools-core').WaitSessionSnapshot>();
        const settled = (snapshot: import('@craft-agent/session-tools-core').WaitSessionSnapshot): boolean => (snapshot.state !== 'active'
            && (snapshot.state === 'missing'
                || snapshot.needsAttention === true
                || snapshot.reason !== undefined
                || snapshot.diagnostic !== undefined
                || (snapshot.objectiveState !== undefined && snapshot.objectiveState !== 'active')));
        const merge = (current: readonly import('@craft-agent/session-tools-core').WaitSessionSnapshot[]) => {
            for (const snapshot of current) {
                const prior = accumulated.get(snapshot.sessionId);
                const sameDeliveredCursor = !!prior?.cursor
                    && prior.cursor === snapshot.cursor
                    && snapshot.changed === false;
                // A new cursor is a new current state: replace the old snapshot so
                // needsAttention, diagnostic and truncation flags cannot leak across
                // a resume. Only retain one-shot payload bytes when the host reports
                // the exact same already-delivered cursor as unchanged.
                accumulated.set(snapshot.sessionId, sameDeliveredCursor ? {
                    ...snapshot,
                    ...(snapshot.finalText === undefined && prior.finalText !== undefined
                        ? { finalText: prior.finalText, ...(prior.finalTextTruncated !== undefined ? { finalTextTruncated: prior.finalTextTruncated } : {}) }
                        : {}),
                    ...(prior.diagnostic !== undefined
                        ? { diagnostic: prior.diagnostic }
                        : {}),
                } : { ...snapshot });
                if (snapshot.cursor)
                    cursors[snapshot.sessionId] = snapshot.cursor;
            }
        };
        const ordered = () => ids.flatMap(id => {
            const snapshot = accumulated.get(id);
            return snapshot ? [snapshot] : [];
        });
        // Always inspect current state without subscribing first. This makes an
        // already-terminal set return immediately even when every cursor is
        // unchanged, and preserves one-shot final payloads before cursors advance.
        const initial = await waitOnce(0, cursors);
        merge(initial.sessions);
        while (ordered().length !== ids.length || !ordered().every(settled)) {
            const remaining = timeoutMs === 0 ? 0 : Math.max(0, deadline - Date.now());
            if (remaining === 0)
                break;
            const next = await waitOnce(remaining, cursors);
            merge(next.sessions);
            if (next.outcome === 'timeout')
                break;
        }
        const sessions = ordered();
        result = {
            outcome: sessions.length === ids.length && sessions.every(settled) ? 'completed' : 'timeout',
            mode: 'all',
            sessions,
        };
    }
    const cursors = caller.waitCursors ??= {};
    for (const item of result.sessions)
        if (item.cursor)
            cursors[item.sessionId] = item.cursor;
    // Per caller bound: explicit cursors remain usable after eviction.
    for (const id of Object.keys(cursors).slice(0, Math.max(0, Object.keys(cursors).length - 256)))
        delete cursors[id];
    return { ...result, mode };
}

export { sessionOpWaitForDelegatedSessions as waitForDelegatedSessions };
