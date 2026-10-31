import { setOptional } from '@craft-agent/shared/utils/json';
import { AGENT_RUNTIME_ACTIVITY } from '@craft-agent/core/types';
import { resolveEffectiveAgentContextLimits } from '@craft-agent/shared/config';
import { COST_CONTROL_COMPACTION_INSTRUCTIONS, assessContextCompactionResult, classifyContextCompactionFailure, isHardLimitFollowUpContextCompaction, isHardLimitRecoveryContextCompaction, shouldAttemptContextCompaction } from '../../context-compaction';
import { sessionLog } from '../runtime-platform.ts';
import type { AgentInstance } from '../runtime-types.ts';
import type { RuntimePreparationInput } from './runtime-preparation-input.ts';

export async function compactPreparedAgentContext(
    runtimePreparationInput: RuntimePreparationInput,
    agent: AgentInstance,
    contextTokens: number,
    effectiveContextLimits: ReturnType<typeof resolveEffectiveAgentContextLimits>,
    contextCompactionObjectiveRootId: string
): Promise<void> {
    const {
        managed,
        sessionOperationContext,
        assertActivePreparation,
        sendSpan,
        ownsActiveTurn,
    } = runtimePreparationInput;

const now = Date.now();
    const contextCompactionDecision = {
        contextTokens,
        compactAtTokens: effectiveContextLimits.compactAtTokens,
        hardLimitTokens: effectiveContextLimits.hardLimitTokens,
        objectiveRootId: contextCompactionObjectiveRootId,
        now,
        previous: managed.contextCompactionAttempt,
    };
    const shouldAttempt = shouldAttemptContextCompaction(contextCompactionDecision);
    const immediateHardLimitFollowUpAttempt = shouldAttempt
        && isHardLimitFollowUpContextCompaction(contextCompactionDecision);
    const hardLimitRecoveryAttempt = shouldAttempt
        && isHardLimitRecoveryContextCompaction(contextCompactionDecision);
    const hardLimitFollowUpAttempted = immediateHardLimitFollowUpAttempt
        || hardLimitRecoveryAttempt
            && managed.contextCompactionAttempt?.hardLimitFollowUpAttempted === true;
    const hardLimitRecoveryAttempted = hardLimitRecoveryAttempt
        && !immediateHardLimitFollowUpAttempt;
    if (!shouldAttempt) {
        if (managed.pendingRoutingMeta?.costControl) {
            managed.pendingRoutingMeta.costControl.compacted = false;
            managed.pendingRoutingMeta.costControl.compactionOutcome = 'skipped-cooldown';
        }
        sessionLog.info('cost-control context compaction skipped during retry cooldown', {
            sessionId: managed.id,
            contextTokens,
            previousOutcome: managed.contextCompactionAttempt?.outcome,
        });
    }
    else {
        try {
            sessionOperationContext.owner["sendEvent"]({ type: 'status', sessionId: runtimePreparationInput.sessionId, message: AGENT_RUNTIME_ACTIVITY.preparingContext }, managed.workspace.id);
            const compacted = await agent.compactContext!(COST_CONTROL_COMPACTION_INSTRUCTIONS);
            assertActivePreparation();
            const compactionDurationMs = Math.max(0, Date.now() - now);
            const assessment = assessContextCompactionResult(compacted);
            managed.contextCompactionAttempt = {
                attemptedAt: now,
                contextTokensBefore: contextTokens,
                outcome: assessment.outcome,
                objectiveRootId: contextCompactionObjectiveRootId,
                ...(assessment.outcome === 'succeeded'
                    ? { awaitingProviderContextBaseline: true as const }
                    : {}),
                hardLimitTokens: effectiveContextLimits.hardLimitTokens,
                ...(hardLimitFollowUpAttempted ? { hardLimitFollowUpAttempted: true as const } : {}),
                ...(hardLimitRecoveryAttempted ? { hardLimitRecoveryAttempted: true as const } : {}),
            };
            // estimatedTokensAfter is a retained-message estimate produced by
            // the SDK, not a provider-scale context measurement. Keep it in
            // telemetry only; the first subsequent provider usage event will
            // establish the durable like-for-like growth baseline.
            if (managed.pendingRoutingMeta?.costControl) {
                managed.pendingRoutingMeta.costControl.compacted = assessment.outcome === 'succeeded';
                managed.pendingRoutingMeta.costControl.compactionOutcome = assessment.outcome;
                setOptional(managed.pendingRoutingMeta.costControl, "compactionModel", compacted?.compactionModel);
                managed.pendingRoutingMeta.costControl.compactionDurationMs = compactionDurationMs;
                setOptional(managed.pendingRoutingMeta.costControl, "contextTokensAfter", assessment.tokensAfter);
                setOptional(managed.pendingRoutingMeta.costControl, "reclaimedTokens", assessment.reclaimedTokens);
                setOptional(managed.pendingRoutingMeta.costControl, "reductionRatio", assessment.reductionRatio);
                setOptional(managed.pendingRoutingMeta.costControl, "compactionIssueCodes", assessment.issues.length > 0
                    ? assessment.issues
                    : undefined);
            }
            sessionOperationContext.owner["persistSession"](managed);
            // The compaction itself is already billable and irreversible from
            // the host's perspective. Flush its bounded receipt before the
            // provider turn continues so a crash cannot replay the same work.
            await sessionOperationContext.owner.flushSession(managed.id);
            assertActivePreparation();
            if (assessment.outcome === 'succeeded') {
                sendSpan.mark('cost-control.compacted');
                sessionLog.info('cost-control context compacted and measured', {
                    sessionId: managed.id,
                    tokensBefore: assessment.tokensBefore,
                    tokensAfter: assessment.tokensAfter,
                    reclaimedTokens: assessment.reclaimedTokens,
                    reductionRatio: assessment.reductionRatio,
                    compactionModel: compacted?.compactionModel,
                    durationMs: compactionDurationMs,
                });
            }
            else {
                sendSpan.mark(`cost-control.compaction-${assessment.outcome}`);
                sessionLog.warn('cost-control context compaction result was not effective and verifiable', {
                    sessionId: managed.id,
                    outcome: assessment.outcome,
                    issues: assessment.issues,
                    tokensBefore: assessment.tokensBefore,
                    tokensAfter: assessment.tokensAfter,
                });
            }
        }
        catch (error) {
            assertActivePreparation();
            const issueCode = classifyContextCompactionFailure(error);
            const compactionOutcome = issueCode === 'not-needed'
                ? 'skipped-not-needed' as const
                : 'failed' as const;
            managed.contextCompactionAttempt = {
                attemptedAt: now,
                contextTokensBefore: contextTokens,
                outcome: compactionOutcome,
                objectiveRootId: contextCompactionObjectiveRootId,
                hardLimitTokens: effectiveContextLimits.hardLimitTokens,
                ...(hardLimitFollowUpAttempted ? { hardLimitFollowUpAttempted: true as const } : {}),
                ...(hardLimitRecoveryAttempted ? { hardLimitRecoveryAttempted: true as const } : {}),
                issueCode,
            };
            if (managed.pendingRoutingMeta?.costControl) {
                managed.pendingRoutingMeta.costControl.compacted = false;
                managed.pendingRoutingMeta.costControl.compactionOutcome = compactionOutcome;
                managed.pendingRoutingMeta.costControl.compactionDurationMs = Math.max(0, Date.now() - now);
                managed.pendingRoutingMeta.costControl.compactionIssueCodes = [issueCode];
            }
            sessionOperationContext.owner["persistSession"](managed);
            // Persist even failed/not-needed receipts synchronously: their
            // cooldown is what prevents a restart from re-billing the same
            // context immediately.
            await sessionOperationContext.owner.flushSession(managed.id);
            assertActivePreparation();
            const logCompactionIssue = issueCode === 'not-needed'
                ? sessionLog.info.bind(sessionLog)
                : sessionLog.warn.bind(sessionLog);
            logCompactionIssue(issueCode === 'not-needed'
                ? 'cost-control context compaction skipped because SDK found no compactable history'
                : 'cost-control context compaction failed; provider admission will be re-evaluated', {
                sessionId: managed.id,
                issueCode,
                error: error instanceof Error ? error.message : String(error),
            });
        }
        finally {
            // This preparation runs before the agent iterator is consumed.
            // Clear via the existing transient status channel even on failure,
            // but never publish late activity after Stop or a replaced turn.
            if (ownsActiveTurn())
                sessionOperationContext.owner["sendEvent"]({ type: 'status', sessionId: runtimePreparationInput.sessionId, message: '' }, managed.workspace.id);
        }
    }
}
