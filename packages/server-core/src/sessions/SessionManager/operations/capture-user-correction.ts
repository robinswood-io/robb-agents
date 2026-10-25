import type { SessionOperationContext } from '../operation-context.ts';
import { persistenceRootFor, isLegacyHostObjectiveContractEnabled } from '../policy.ts';
import { getBuiltinPlaybook, loadWorkspacePlaybook } from '@craft-agent/shared/playbooks';
import type { FileAttachment, SendMessageOptions } from '@craft-agent/shared/protocol';
import type { Message, StoredAttachment } from '@craft-agent/core/types';
import { captureProjectUserCorrection, captureProjectTerminalLearning, handleProjectLearning, getProjectLearningPolicy } from '../../project-learning';
import { loadProjectById, loadProjectMemoryV2Context } from '@craft-agent/shared/projects';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { assertSessionOperationOwner as sessionOpAssertSessionOperationOwner, trackSessionOperation as sessionOpTrackSessionOperation } from './track-session-operation.ts';

/** Resolve project-owned data through the same captured physical root as the
 * session transcript. The logical workspace path may be a symlink retargeted
 * to another workspace while this ManagedSession is alive. */
function sessionOpSessionProjectLearningTarget(sessionOperationContext: SessionOperationContext, managed: ManagedSession): {
    rootPath: string;
    projectId: string;
    projectSlug: string;
} | undefined {
    if (!managed.projectId)
        return undefined;
    const rootPath = persistenceRootFor(managed);
    const project = loadProjectById(rootPath, managed.projectId);
    return project ? {
        rootPath,
        projectId: project.config.id,
        projectSlug: project.config.slug,
    } : undefined;
}

/** Resolve a session-bound playbook from the same immutable workspace root
 * as the session transcript. Built-ins remain the workspace-independent
 * fallback. */
function sessionOpLoadSessionPlaybook(sessionOperationContext: SessionOperationContext, managed: ManagedSession): ReturnType<typeof loadWorkspacePlaybook> {
    if (!managed.playbookSlug)
        return null;
    return loadWorkspacePlaybook(persistenceRootFor(managed), managed.playbookSlug)
        ?? getBuiltinPlaybook(managed.playbookSlug);
}

function sessionOpAssertSessionProjectLearningTarget(sessionOperationContext: SessionOperationContext, managed: ManagedSession, expected: {
    rootPath: string;
    projectId: string;
    projectSlug: string;
}): {
    rootPath: string;
    projectId: string;
    projectSlug: string;
} {
    sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
    const current = sessionOpSessionProjectLearningTarget(sessionOperationContext, managed);
    if (!current || current.rootPath !== expected.rootPath
        || current.projectId !== expected.projectId || current.projectSlug !== expected.projectSlug) {
        throw new Error(`Session project changed during project-learning I/O: ${managed.id}`);
    }
    return current;
}

async function sessionOpHandleSessionProjectLearning(sessionOperationContext: SessionOperationContext, managed: ManagedSession, request: Parameters<typeof handleProjectLearning>[4]): Promise<unknown> {
    const target = sessionOpSessionProjectLearningTarget(sessionOperationContext, managed);
    if (!target)
        throw new Error('Bind the session to an existing project first');
    const policy = await getProjectLearningPolicy(target.rootPath);
    const confirmed = sessionOpAssertSessionProjectLearningTarget(sessionOperationContext, managed, target);
    if (!policy.enabled && request.action !== 'list' && request.action !== 'revoke') {
        throw new Error('Project learning is disabled by workspace policy');
    }
    const result = await handleProjectLearning(confirmed.rootPath, confirmed.projectSlug, managed.id, managed.messages, {
        ...request,
        version: managed.lastUsedByApp?.buildCommit,
        ttlDays: Math.min(request.ttlDays ?? 30, policy.retentionDays),
    }, {
        legacyWorkspaceRootPath: managed.legacyProjectMemoryRootPath,
        assertTarget: () => { sessionOpAssertSessionProjectLearningTarget(sessionOperationContext, managed, confirmed); },
    });
    sessionOpAssertSessionProjectLearningTarget(sessionOperationContext, managed, confirmed);
    return result;
}

async function sessionOpLoadSessionProjectMemoryContext(sessionOperationContext: SessionOperationContext, managed: ManagedSession, query: string): Promise<string | null> {
    const target = sessionOpSessionProjectLearningTarget(sessionOperationContext, managed);
    if (!target)
        return null;
    const policy = await getProjectLearningPolicy(target.rootPath);
    const confirmed = sessionOpAssertSessionProjectLearningTarget(sessionOperationContext, managed, target);
    if (!policy.enabled)
        return null;
    return loadProjectMemoryV2Context(confirmed.rootPath, confirmed.projectSlug, {
        maxAgeDays: policy.retentionDays,
        query,
        requireQueryMatch: true,
        maxEntries: 6,
        maxTokens: 1800,
        version: managed.lastUsedByApp?.buildCommit,
        legacyWorkspaceRootPath: managed.legacyProjectMemoryRootPath,
    });
}

async function sessionOpCaptureSessionTerminalLearning(sessionOperationContext: SessionOperationContext, managed: ManagedSession, state: NonNullable<ManagedSession['activeObjective']>['terminalState']): Promise<void> {
    if (!managed.activeObjective || !managed.projectId || state === 'active')
        return;
    const target = sessionOpSessionProjectLearningTarget(sessionOperationContext, managed);
    if (!target)
        return;
    await captureProjectTerminalLearning(target.rootPath, target.projectSlug, managed.id, [...managed.messages], {
        objectiveId: managed.activeObjective.userMessageId,
        state,
        version: managed.lastUsedByApp?.buildCommit,
    }, {
        legacyWorkspaceRootPath: managed.legacyProjectMemoryRootPath,
        assertTarget: () => { sessionOpAssertSessionProjectLearningTarget(sessionOperationContext, managed, target); },
    });
    sessionOpAssertSessionProjectLearningTarget(sessionOperationContext, managed, target);
}

async function sessionOpCaptureUserCorrection(sessionOperationContext: SessionOperationContext, managed: ManagedSession, userMessage: Message): Promise<void> {
    if (!managed.projectId || sessionOperationContext.state.shuttingDown)
        return;
    try {
        const target = sessionOpSessionProjectLearningTarget(sessionOperationContext, managed);
        const messages = [...managed.messages];
        const position = messages.findIndex(item => item.id === userMessage.id);
        let corrected: Message | undefined;
        for (let index = position - 1; index >= 0; index--) {
            if (messages[index]!.role === 'assistant' && !messages[index]!.isIntermediate) {
                corrected = messages[index];
                break;
            }
        }
        if (target && corrected)
            await captureProjectUserCorrection(target.rootPath, target.projectSlug, managed.id, messages, {
                messageId: userMessage.id, correctedMessageId: corrected.id,
                objectiveId: managed.activeObjective?.userMessageId, version: managed.lastUsedByApp?.buildCommit,
            }, {
                legacyWorkspaceRootPath: managed.legacyProjectMemoryRootPath,
                assertTarget: () => { sessionOpAssertSessionProjectLearningTarget(sessionOperationContext, managed, target); },
            });
        if (target)
            sessionOpAssertSessionProjectLearningTarget(sessionOperationContext, managed, target);
    }
    catch (error) {
        sessionLog.warn('User correction capture unavailable', { sessionId: managed.id, error: String(error) });
    }
}

function sessionOpHasExplicitStructuredObjectiveTracking(sessionOperationContext: SessionOperationContext, managed: ManagedSession): boolean {
    return isLegacyHostObjectiveContractEnabled(managed)
        || !!managed.activeObjective?.acceptanceCriteria?.length;
}

async function sessionOpSendMessage(sessionOperationContext: SessionOperationContext, sessionId: string, message: string, attachments?: FileAttachment[], storedAttachments?: StoredAttachment[], options?: SendMessageOptions, existingMessageId?: string, _isAuthRetry?: boolean, onAck?: (messageId: string) => void, rpcContext?: {
    callerClientId?: string;
}, queuedDispatchToken?: symbol, queuedItem?: ManagedSession['messageQueue'][number], retryCancellationEpoch?: number, explicitRetryAllowanceToken?: symbol, sourceActivationDispatchToken?: symbol, authenticatedInternalContinuationToken?: symbol, delegatedDispatchContinuationToken?: symbol): Promise<void> {
    if (sessionOperationContext.state.shuttingDown)
        throw new Error('The application is closing; the saved turn will resume after restart');
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed)
        throw new Error(`Session ${sessionId} not found`);
    return sessionOpTrackSessionOperation(sessionOperationContext, managed, () => sessionOperationContext.owner["performSendMessage"](sessionId, message, attachments, storedAttachments, options, existingMessageId, _isAuthRetry, onAck, rpcContext, queuedDispatchToken, queuedItem, retryCancellationEpoch, explicitRetryAllowanceToken, sourceActivationDispatchToken, authenticatedInternalContinuationToken, delegatedDispatchContinuationToken));
}

export { sessionOpSessionProjectLearningTarget as sessionProjectLearningTarget };
export { sessionOpLoadSessionPlaybook as loadSessionPlaybook };
export { sessionOpAssertSessionProjectLearningTarget as assertSessionProjectLearningTarget };
export { sessionOpHandleSessionProjectLearning as handleSessionProjectLearning };
export { sessionOpLoadSessionProjectMemoryContext as loadSessionProjectMemoryContext };
export { sessionOpCaptureSessionTerminalLearning as captureSessionTerminalLearning };
export { sessionOpCaptureUserCorrection as captureUserCorrection };
export { sessionOpHasExplicitStructuredObjectiveTracking as hasExplicitStructuredObjectiveTracking };
export { sessionOpSendMessage as sendMessage };
