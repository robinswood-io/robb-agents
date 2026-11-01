import type { SessionOperationContext } from '../operation-context.ts';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';

export function createRuntimeContextCallbacks(sessionOperationContext: SessionOperationContext, managed: ManagedSession, isCurrentRuntime: () => boolean) {
    const cleanRecoveryBoundaryIndex = () => {
        const boundaryMessageId = managed.providerContextBoundaryMessageId
            ?? managed.pendingTurnRecovery?.cleanContextBoundaryMessageId;
        const explicitBoundary = boundaryMessageId
            ? managed.messages.findIndex(message => message.id === boundaryMessageId && message.role === 'user')
            : -1;
        if (explicitBoundary >= 0)
            return explicitBoundary;
        return managed.messages.findLastIndex(message => (message.role === 'user' && message.hidden === true
            && message.content.startsWith('<host_clean_recovery_continuation id="clean-continuation-v1-')
            && message.content.endsWith('</host_clean_recovery_continuation>')));
    };
    const messagesAfterCleanRecoveryBoundary = () => {
        const boundaryIndex = cleanRecoveryBoundaryIndex();
        return boundaryIndex >= 0 ? managed.messages.slice(boundaryIndex) : managed.messages;
    };
    const getRecoveryMessages = () => {
        const relevantMessages = messagesAfterCleanRecoveryBoundary()
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .filter(m => !m.isIntermediate)
            .slice(-6);
        return relevantMessages.map(m => ({
            type: m.role as 'user' | 'assistant',
            content: m.content,
        }));
    };
    const getBranchFallbackMessages = () => {
        if (!managed.branchFromMessageId)
            return [];
        return messagesAfterCleanRecoveryBoundary()
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .filter(m => !m.isIntermediate)
            .map(m => ({
            type: m.role as 'user' | 'assistant',
            content: m.content,
        }));
    };
    const getBranchSeedMessages = () => {
        if (managed.branchContextStrategy !== 'seeded-fresh-session')
            return [];
        if (managed.branchSeedApplied)
            return [];
        const seedMessages = messagesAfterCleanRecoveryBoundary()
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .filter(m => !m.isIntermediate);
        return seedMessages.map(m => ({
            type: m.role as 'user' | 'assistant',
            content: m.content,
        }));
    };
    const markBranchSeedApplied = () => {
        if (!isCurrentRuntime())
            return;
        if (managed.branchContextStrategy !== 'seeded-fresh-session')
            return;
        if (managed.branchSeedApplied)
            return;
        managed.branchSeedApplied = true;
        sessionLog.info('Branch seed context applied', {
            sessionId: managed.id,
            strategy: managed.branchContextStrategy,
        });
    };
    const getTransferredSessionSummary = () => {
        if (cleanRecoveryBoundaryIndex() >= 0)
            return null;
        const summary = managed.transferredSessionSummaryApplied ? null : (managed.transferredSessionSummary ?? null);
        sessionLog.info(`[transfer-context] getTransferredSessionSummary for ${managed.id}: applied=${managed.transferredSessionSummaryApplied}, has_summary=${!!managed.transferredSessionSummary}, returning=${summary ? `${summary.length} chars` : 'null'}`);
        return summary;
    };
    const markTransferredSessionSummaryApplied = () => {
        if (!isCurrentRuntime())
            return;
        if (managed.transferredSessionSummaryApplied || !managed.transferredSessionSummary)
            return;
        managed.transferredSessionSummaryApplied = true;
        sessionOperationContext.owner["persistSession"](managed);
        sessionLog.info('Transferred session summary applied', {
            sessionId: managed.id,
        });
    };
    return { getRecoveryMessages, getBranchFallbackMessages, getBranchSeedMessages, markBranchSeedApplied, getTransferredSessionSummary, markTransferredSessionSummaryApplied };
}


