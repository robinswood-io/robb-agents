import type { SessionOperationContext } from '../operation-context.ts';
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import { isYoloMode } from '@craft-agent/shared/agent';
import { buildObjectiveValidationEvidenceContext } from '../../objective-validation-context';
import { exhaustPendingTurnRecovery } from '../../turn-recovery';
import type { ManagedSession } from '../managed-session.ts';
import { recordAutonomyEvent as sessionOpRecordAutonomyEvent } from './persist-tool-result-after-permission-expiry.ts';
import { monotonic as sessionOpMonotonic } from './runtime-host.ts';

function sessionOpIsManagedSessionYolo(sessionOperationContext: SessionOperationContext, managed: ManagedSession): boolean {
    const seen = new Set<string>();
    let cursor: ManagedSession | undefined = managed;
    while (cursor && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        if (cursor.permissionMode === 'allow-all' && isYoloMode(cursor.permissionMode, cursor.pendingExternalActionPolicy
            ?? (cursor.workspace?.rootPath ? loadWorkspaceConfig(cursor.workspace.rootPath)?.defaults?.externalActionPolicy : undefined)))
            return true;
        const parent: ManagedSession | undefined = cursor.parentSessionId ? sessionOperationContext.state.sessions.get(cursor.parentSessionId) : undefined;
        const edge = cursor.delegation;
        const root = edge ? sessionOperationContext.state.sessions.get(edge.rootSessionId) : undefined;
        if (!parent || !root || !edge || parent.workspace.id !== managed.workspace.id
            || root.workspace.id !== managed.workspace.id
            || edge.parentObjectiveId !== (parent.activeObjective?.objectiveId ?? parent.activeObjective?.userMessageId)
            || edge.rootObjectiveId !== (root.activeObjective?.objectiveId ?? root.activeObjective?.userMessageId))
            return false;
        // Restrict child interaction without expanding its permission mode.
        cursor = parent;
    }
    return false;
}

function sessionOpReportBackendAuthUnavailable(sessionOperationContext: SessionOperationContext, managed: ManagedSession, reason: string, level: 'error' | 'warning' | 'info' = 'error'): void {
    const yolo = sessionOpIsManagedSessionYolo(sessionOperationContext, managed);
    const message = yolo
        ? 'YOLO: provider authentication is unavailable. The objective remains incomplete; no sign-in, credential or human-input request was opened. Automatic recovery remains subject to the existing budgets.'
        : reason;
    if (yolo) {
        sessionOpRecordAutonomyEvent(sessionOperationContext, managed, { phase: 'diagnosis', message });
        sessionOperationContext.owner["persistSession"](managed);
    }
    sessionOperationContext.owner["sendEvent"]({ type: 'info', sessionId: managed.id, message, level }, managed.workspace.id);
}

/** Exhaustion is a durable incomplete result, never a fabricated answer or
 * a pending human request. Retain the original recovery identity and receipts. */
async function sessionOpStopYoloHumanHandoff(sessionOperationContext: SessionOperationContext, managed: ManagedSession, reason: string): Promise<void> {
    const objective = managed.activeObjective;
    if (objective?.terminalState === 'active') {
        objective.terminalState = 'exhausted';
        objective.completedAt = Date.now();
    }
    if (managed.pendingTurnRecovery) {
        managed.pendingTurnRecovery = exhaustPendingTurnRecovery({ ...managed.pendingTurnRecovery,
            validationGaps: [...(managed.pendingTurnRecovery.validationGaps ?? []), reason].slice(-8) });
    }
    sessionOpRecordAutonomyEvent(sessionOperationContext, managed, { phase: 'diagnosis', message: reason });
    sessionOperationContext.owner["persistSession"](managed);
    await sessionOperationContext.owner.flushSession(managed.id);
    sessionOperationContext.owner["sendEvent"]({ type: 'info', sessionId: managed.id, level: 'warning',
        timestamp: sessionOpMonotonic(sessionOperationContext), message: reason }, managed.workspace.id);
}

function sessionOpGetSessionToolInfo(sessionOperationContext: SessionOperationContext, caller: ManagedSession, targetId = caller.id) {
    const session = sessionOperationContext.state.sessions.get(targetId);
    if (!session)
        return null;
    return {
        id: session.id,
        name: session.name ?? session.id,
        labels: session.labels ?? [],
        status: session.sessionStatus ?? 'todo',
        permissionMode: session.permissionMode ?? 'ask',
        createdAt: session.createdAt ?? 0,
        workingDirectory: session.workingDirectory,
        projectId: session.projectId,
        llmConnection: session.llmConnection,
        model: session.model,
        isActive: session.agent != null,
        objectiveEvidenceContext: session === caller && session.messagesLoaded && session.activeObjective
            ? buildObjectiveValidationEvidenceContext(session.messages, session.activeObjective, session.id)
            : undefined,
    };
}

export { sessionOpIsManagedSessionYolo as isManagedSessionYolo };
export { sessionOpReportBackendAuthUnavailable as reportBackendAuthUnavailable };
export { sessionOpStopYoloHumanHandoff as stopYoloHumanHandoff };
export { sessionOpGetSessionToolInfo as getSessionToolInfo };
