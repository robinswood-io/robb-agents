import type { SessionOperationContext } from '../operation-context.ts';
import { mergeSessionScopedToolCallbacks, TERMINAL_RECONCILIATION_CAPABILITY_FIELD } from '@craft-agent/shared/agent';
import type { SessionStatus } from '@craft-agent/shared/sessions';
import type { AgentMessageType } from '@craft-agent/session-tools-core';
import { loadLabelConfig } from '@craft-agent/shared/labels/storage';
import { resolveSessionLabels } from '@craft-agent/shared/labels';
import { loadStatusConfig } from '@craft-agent/shared/statuses/storage';
import { registerObjectiveAcceptanceCriteria } from '../../objective-acceptance-criteria';
import { businessProcedureCoverage } from '../../business-procedures';
import { objectiveReviewBinding } from '../../objective-contract';
import type { ManagedSession } from '../managed-session.ts';
import { getSessionToolInfo as sessionOpGetSessionToolInfo } from './is-managed-session-yolo.ts';
import { monotonic as sessionOpMonotonic } from './runtime-host.ts';
import { consumeTerminalInvocationCapability as sessionOpConsumeTerminalInvocationCapability, hasTerminalObjectiveState as sessionOpHasTerminalObjectiveState } from './repair-legacy-synthetic-objective-authority.ts';
import { waitForDelegatedSessions as sessionOpWaitForDelegatedSessions } from './wait-for-delegated-sessions.ts';
import { persistRegisteredObjectiveForCurrentTurn as sessionOpPersistRegisteredObjectiveForCurrentTurn } from './objective-registration.ts';
import { handleSessionProjectLearning as sessionOpHandleSessionProjectLearning } from './capture-user-correction.ts';
import { sendAgentMessageToSession as sessionOpSendAgentMessageToSession } from './send-agent-message-to-session.ts';

export function installRuntimeSessionToolCallbacks(sessionOperationContext: SessionOperationContext, managed: ManagedSession, createdAgent: NonNullable<ManagedSession['agent']>) {
    // Wire up session self-management tools (set_session_labels, set_session_status, etc.)
    mergeSessionScopedToolCallbacks(managed.id, {
        validateMissionCapabilitiesFn: async (toolName, input) => {
            await sessionOperationContext.owner["assertSpecializedMissionCapabilities"](managed, toolName, input);
        },
        setSessionLabelsFn: async (sessionId: string | undefined, labels: string[]) => {
            await sessionOperationContext.owner.setSessionLabels(sessionId ?? managed.id, labels);
        },
        setSessionStatusFn: async (sessionId: string | undefined, status: string) => {
            await sessionOperationContext.owner.setSessionStatus(sessionId ?? managed.id, status as SessionStatus);
        },
        getSessionInfoFn: (sessionId?: string) => {
            return sessionOpGetSessionToolInfo(sessionOperationContext, managed, sessionId);
        },
        listSessionsFn: (options) => {
            const DEFAULT_LIMIT = 20;
            const MAX_LIMIT = 100;
            const limit = Math.min(options?.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
            const offset = options?.offset ?? 0;
            let sessions = sessionOperationContext.owner.getSessions(managed.workspace.id);
            // Filter
            if (options?.status) {
                sessions = sessions.filter(s => s.sessionStatus === options.status);
            }
            if (options?.label) {
                sessions = sessions.filter(s => s.labels?.includes(options.label!));
            }
            if (options?.search) {
                const needle = options.search.toLowerCase();
                sessions = sessions.filter(s => s.name?.toLowerCase().includes(needle));
            }
            // Sort
            const sortBy = options?.sortBy ?? 'recent';
            if (sortBy === 'recent') {
                sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
            }
            else if (sortBy === 'name') {
                sessions.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
            }
            else if (sortBy === 'status') {
                sessions.sort((a, b) => (a.sessionStatus ?? '').localeCompare(b.sessionStatus ?? ''));
            }
            const total = sessions.length;
            // Paginate
            const page = sessions.slice(offset, offset + limit);
            return {
                total,
                returned: page.length,
                sessions: page.map(s => ({
                    id: s.id,
                    name: s.name ?? s.id,
                    labels: s.labels ?? [],
                    status: s.sessionStatus ?? 'todo',
                    createdAt: s.createdAt ?? 0,
                    projectId: s.projectId,
                })),
            };
        },
        waitForSessionsFn: (sessionIds, timeoutMs, afterCursors, terminalCapability, mode) => {
            const terminalObjective = managed.activeObjective?.terminalReconciliation;
            const invocationInput: Record<string, unknown> = {
                sessionIds,
                ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                ...(afterCursors !== undefined ? { afterCursors } : {}),
                ...(mode !== undefined ? { mode } : {}),
                ...(terminalCapability ? {
                    [TERMINAL_RECONCILIATION_CAPABILITY_FIELD]: terminalCapability,
                } : {}),
            };
            if (terminalObjective && !sessionOpConsumeTerminalInvocationCapability(sessionOperationContext, managed, 'mcp__session__wait_sessions', invocationInput, terminalCapability))
                throw new Error('The terminal wait capability is missing, stale, or belongs to another objective revision.');
            if (!terminalObjective && terminalCapability) {
                throw new Error('A terminal wait capability cannot be used outside its bound reconciliation objective.');
            }
            return sessionOpWaitForDelegatedSessions(sessionOperationContext, managed, sessionIds, timeoutMs ?? 60000, afterCursors, mode);
        },
        listBackgroundTasksFn: (sessionId?: string) => {
            const targetId = sessionId ?? managed.id;
            const now = Date.now();
            return sessionOperationContext.owner.listBackgroundTasks(targetId).map((t) => {
                // Prefer wall-clock elapsed; running tasks tick off startTime, terminal
                // tasks freeze at completion. Fall back to the last progress value.
                const anchorEnd = t.status === 'running' ? now : (t.completedAt ?? now);
                const wallElapsed = Math.max(0, Math.round((anchorEnd - t.startTime) / 1000));
                return {
                    taskId: t.taskId,
                    intent: t.intent,
                    status: t.status,
                    startTime: t.startTime,
                    elapsedSeconds: t.elapsedSeconds ?? wallElapsed,
                    completedAt: t.completedAt,
                };
            });
        },
        resolveLabelsFn: (labels: string[]) => {
            const labelConfig = loadLabelConfig(managed.workspace.rootPath);
            return resolveSessionLabels(labels, labelConfig.labels);
        },
        resolveStatusFn: (status: string) => {
            const statusConfig = loadStatusConfig(managed.workspace.rootPath);
            const allStatuses = statusConfig.statuses;
            const available = allStatuses.map(s => s.id);
            // Exact ID match
            const byId = allStatuses.find(s => s.id === status);
            if (byId)
                return { resolved: byId.id, available, category: byId.category };
            // Case-insensitive label → ID
            const byLabel = allStatuses.find(s => s.label.toLowerCase() === status.toLowerCase());
            if (byLabel)
                return { resolved: byLabel.id, available, category: byLabel.category };
            return { resolved: null, available };
        },
        requestUserInputFn: questions => sessionOperationContext.owner.requestUserInput(managed.id, questions),
        setCompletionCriteriaFn: async (criteria, procedure, terminalCapability) => {
            if (!managed.activeObjective)
                throw new Error('No active objective');
            const objectiveBefore = managed.activeObjective;
            const invocationInput: Record<string, unknown> = {
                criteria,
                ...(procedure !== undefined ? { procedure } : {}),
                ...(terminalCapability ? {
                    [TERMINAL_RECONCILIATION_CAPABILITY_FIELD]: terminalCapability,
                } : {}),
            };
            if (objectiveBefore.terminalReconciliation && !sessionOpConsumeTerminalInvocationCapability(sessionOperationContext, managed, 'mcp__session__set_completion_criteria', invocationInput, terminalCapability))
                throw new Error('The terminal acceptance-registration capability is missing, stale, or belongs to another objective revision.');
            if (!objectiveBefore.terminalReconciliation && terminalCapability) {
                throw new Error('A terminal acceptance-registration capability cannot be used outside its bound reconciliation objective.');
            }
            const generationBefore = managed.processingGeneration;
            const authorityEpochBefore = sessionOperationContext.state.objectiveAuthorityEpochs.get(managed) ?? 0;
            const registered = registerObjectiveAcceptanceCriteria(objectiveBefore, criteria, sessionOpMonotonic(sessionOperationContext), procedure, managed.messages, managed.id);
            if (managed.agent! !== createdAgent || managed.processingGeneration !== generationBefore
                || managed.activeObjective !== objectiveBefore
                || (sessionOperationContext.state.objectiveAuthorityEpochs.get(managed) ?? 0) !== authorityEpochBefore) {
                throw new Error('The objective changed before acceptance criteria could be registered.');
            }
            if (registered !== objectiveBefore) {
                await sessionOpPersistRegisteredObjectiveForCurrentTurn(sessionOperationContext, managed, createdAgent, objectiveBefore, registered, generationBefore, authorityEpochBefore);
            }
            if (managed.agent! !== createdAgent || managed.processingGeneration !== generationBefore
                || managed.activeObjective !== registered
                || (sessionOperationContext.state.objectiveAuthorityEpochs.get(managed) ?? 0) !== authorityEpochBefore) {
                throw new Error('The objective changed while acceptance criteria were being persisted; the stale provider turn receives no registration receipt.');
            }
            // Bind this receipt to the exact registration, even if a newer human
            // objective is accepted while its persistence is being flushed.
            return { ...objectiveReviewBinding(registered), criteria: registered.acceptanceCriteria,
                procedure: registered.procedure,
                missingRequirements: registered.procedure ? businessProcedureCoverage(registered.procedure.id, registered.acceptanceCriteria ?? []) : [],
            };
        },
        projectLearningFn: async (request) => {
            return sessionOpHandleSessionProjectLearning(sessionOperationContext, managed, request);
        },
        sendAgentMessageFn: async (sessionId: string, message: string, attachments?: Array<{
            path: string;
            name?: string;
        }>, messageType: AgentMessageType = 'progress') => {
            const target = sessionOperationContext.state.sessions.get(sessionId);
            if (!target || target.workspace.id !== managed.workspace.id)
                throw new Error('Target session must belong to the current workspace');
            if (sessionOpHasTerminalObjectiveState(sessionOperationContext, target)) {
                throw new Error(`Target session objective is terminal (${target.activeObjective?.terminalState}); no agent message was queued. Reuse its completed result. A new delegation is valid only when the objective or version genuinely changed, and grants no new authority.`);
            }
            return sessionOpSendAgentMessageToSession(sessionOperationContext, managed, target, message, attachments, messageType);
        },
        activateSourceInSessionFn: async (sourceSlug: string) => {
            const cb = managed.agent!?.onSourceActivationRequest;
            if (!cb) {
                return { ok: false, reason: 'Agent has no activation callback wired' };
            }
            const ok = await cb(sourceSlug);
            if (!ok) {
                return {
                    ok: false,
                    reason: 'Activation failed — source may be unusable (disabled/unauthenticated) or server build failed. Check session logs.',
                };
            }
            // Both backends need the current turn to end before new tools are visible:
            // Claude SDK freezes mcpServers at query() start; Pi only picks up new proxy
            // tool defs on the next handlePrompt (`toolsChanged` flag in pi-agent-server).
            // Mark a pending restart on the agent — ClaudeAgent/PiAgent consume it after
            // the next tool_result, yield source_activated, and forceAbort. The
            // `source_activated` handler in this class then schedules a server-side
            // resend of the original user message with a "[{slug} activated]" suffix —
            // landing in a fresh turn with tools live (craft-agents-oss#804).
            const userMessage = managed.agent!?.getCurrentTurnUserMessage?.() ?? '';
            if (userMessage) {
                managed.agent!?.setPendingSourceActivationRestart({ sourceSlug, userMessage });
            }
            return { ok: true, availability: 'next-turn' as const };
        },
    });
}


