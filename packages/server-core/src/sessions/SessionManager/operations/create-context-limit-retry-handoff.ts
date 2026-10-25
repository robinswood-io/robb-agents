import type { SessionOperationContext } from '../operation-context.ts';
import { boundObjectiveForCleanHandoff, hasAuthenticatedObjectiveRoot } from '../policy.ts';
import type { PendingTurnRecovery, ActiveSessionObjective } from '@craft-agent/shared/sessions';
import { createCleanRecoveryContinuationHandoff } from '../../turn-recovery';
import type { ManagedSession } from '../managed-session.ts';
import { isCleanSetupRetryBlocked as sessionOpIsCleanSetupRetryBlocked, pendingRecoveryBelongsToCurrentObjective as sessionOpPendingRecoveryBelongsToCurrentObjective } from './pending-recovery-belongs-to-current-objective.ts';
import { contextLimitAuthenticatedAnswerEvidence as sessionOpContextLimitAuthenticatedAnswerEvidence } from './context-limit-authenticated-answer-evidence.ts';

function sessionOpCreateContextLimitRetryHandoff(sessionOperationContext: SessionOperationContext, managed: ManagedSession, pending: PendingTurnRecovery): ReturnType<typeof createCleanRecoveryContinuationHandoff> {
    const storedObjective = managed.activeObjective;
    const objective = storedObjective?.terminalState === 'blocked_human'
        && sessionOpIsCleanSetupRetryBlocked(sessionOperationContext, pending.recoveryDispatch)
        ? { ...storedObjective, terminalState: 'active' as const, completedAt: undefined }
        : storedObjective;
    const criteria = objective?.acceptanceCriteria;
    const registeredRevision = objective?.acceptanceRegisteredRevision;
    const lineage = new Set([
        objective?.userMessageId,
        objective?.lastUserMessageId,
        ...(objective?.amendments ?? []).map(amendment => amendment.messageId),
    ].filter((id): id is string => !!id));
    if (!objective || objective.terminalState !== 'active'
        || !criteria?.length
        || objective.acceptanceNeedsReview === true
        || !registeredRevision || !lineage.has(registeredRevision)
        || !hasAuthenticatedObjectiveRoot(managed, objective)
        || !sessionOpPendingRecoveryBelongsToCurrentObjective(sessionOperationContext, managed, pending))
        return undefined;
    const visibleSourceUserMessageId = objective.lastUserMessageId ?? objective.userMessageId;
    const sourceIsVisible = pending.userMessageId === objective.userMessageId
        || pending.userMessageId === visibleSourceUserMessageId;
    const authenticatedAnswers = sessionOpContextLimitAuthenticatedAnswerEvidence(sessionOperationContext, managed, objective, sourceIsVisible ? undefined : pending.userMessageId, pending);
    if (!authenticatedAnswers)
        return undefined;
    if (!sourceIsVisible && !authenticatedAnswers.responseMessageIds.has(pending.userMessageId)) {
        return undefined;
    }
    // The generic clean-handoff schema intentionally admits only visible
    // objective lineage as its recovery source. After authenticating a hidden
    // structured answer above, project that source to the latest visible
    // revision and carry every exact host-authenticated selection as bounded
    // evidence. Rebuilding after the Retry uses the same evidence, so the
    // deterministic handoff id remains stable across the provider reset.
    const handoffPending = sourceIsVisible ? pending : {
        ...pending,
        userMessageId: visibleSourceUserMessageId,
    };
    const hostGaps = (pending.validationGaps ?? []).flatMap(gap => {
        const bounded = gap.trim();
        if (!bounded)
            return [];
        const text = bounded.length > 1450 ? `${bounded.slice(0, 1445)}...` : bounded;
        return [`Resolve host validation gap: ${text}`];
    });
    const criterionWork: string[] = [];
    const outcomeCriteria: NonNullable<ActiveSessionObjective['lastOutcome']>['criteria'] = [];
    for (const criterion of criteria.slice(0, 16)) {
        const id = typeof criterion?.id === 'string' ? criterion.id.trim() : '';
        const rawDescription = typeof criterion?.description === 'string' ? criterion.description.trim() : '';
        if (!id || id.length > 512 || !rawDescription)
            return undefined;
        const prefix = `Reconcile the current target state against registered acceptance criterion ${id}; only if it is unmet, complete it idempotently, then verify it: `;
        const maxDescLen = Math.max(64, 1500 - prefix.length);
        const description = rawDescription.length > maxDescLen
            ? `${rawDescription.slice(0, maxDescLen - 3)}...`
            : rawDescription;
        criterionWork.push(`${prefix}${description}`);
        outcomeCriteria.push({ id, satisfied: false, evidence: [] });
    }
    const remainingWork = [...new Set([...hostGaps, ...criterionWork])].slice(0, 16);
    if (!remainingWork.length)
        return undefined;
    const derivedObjective: ActiveSessionObjective = {
        ...objective,
        lastOutcome: {
            state: 'continue',
            blocker: null,
            criteria: outcomeCriteria,
            remainingWork,
        },
    };
    const bounded = boundObjectiveForCleanHandoff(managed, derivedObjective);
    return createCleanRecoveryContinuationHandoff({
        objective: bounded.objective,
        pending: { ...handoffPending, lastCause: 'user_retry' },
        objectiveText: bounded.objectiveText,
        evidence: authenticatedAnswers.evidence,
        remainingWork,
    });
}

export { sessionOpCreateContextLimitRetryHandoff as createContextLimitRetryHandoff };
