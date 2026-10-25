import type { SessionOperationContext } from '../operation-context.ts';
import type { AgentEvent } from '@craft-agent/shared/agent';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { evictStaleBackgroundTasks as sessionOpEvictStaleBackgroundTasks } from './background-tasks.ts';

export function handleAgentTaskBackgrounded(sessionOperationContext: SessionOperationContext, managed: ManagedSession, event: Extract<AgentEvent, { type: 'task_backgrounded' }>, sessionId: string, workspaceId: string): void {
    // Record in the running-task registry so a cross-subprocess "status?"
    // query can enumerate live tasks (WS3). The renderer still shows the
    // chip via its own atom; this is the main-process source of truth.
    if (managed) {
        managed.backgroundTaskRegistry.set(event.taskId, {
            taskId: event.taskId,
            toolUseId: event.toolUseId,
            intent: event.intent,
            startTime: Date.now(),
            status: 'running',
            turnId: event.turnId,
            // Workflow launches carry a wf_ id + a live sub-agent completion count.
            ...(event.workflowId ? { workflowId: event.workflowId } : {}),
            ...(event.kind === 'workflow' ? { agentsCompleted: 0 } : {}),
        });
        sessionLog.info(`[bg-lifecycle] task backgrounded`, {
            sessionId,
            taskId: event.taskId,
            intent: event.intent,
            turnId: event.turnId,
        });
    }
    // Forward background task event directly to renderer
    sessionOperationContext.owner["sendEvent"]({
        ...event,
        sessionId,
    }, workspaceId);
    return;
}

export function handleAgentWorkflowAgentCompleted(sessionOperationContext: SessionOperationContext, managed: ManagedSession, event: Extract<AgentEvent, { type: 'workflow_agent_completed' }>, sessionId: string, workspaceId: string): void {
    // One sub-agent of a running Workflow finished (SubagentStop, attributed
    // by wf_ id). Bump the owning workflow chip's completed count so the user
    // sees live fan-out progress. Lightweight: registry counter + renderer
    // forward, no persistence (this can fire dozens of times per workflow).
    if (managed) {
        for (const info of managed.backgroundTaskRegistry.values()) {
            if (info.workflowId && info.workflowId === event.workflowId) {
                info.agentsCompleted = (info.agentsCompleted ?? 0) + 1;
                break;
            }
        }
    }
    sessionOperationContext.owner["sendEvent"]({
        ...event,
        sessionId,
    }, workspaceId);
    return;
}

export function handleAgentTaskProgress(sessionOperationContext: SessionOperationContext, managed: ManagedSession, event: Extract<AgentEvent, { type: 'task_progress' }>, sessionId: string, workspaceId: string): void {
    // Update elapsed/last-progress on the registry entry (best-effort — the
    // async-by-default path may not emit progress; the renderer derives
    // elapsed from startTime as a fallback).
    if (managed) {
        // task_progress is keyed by toolUseId, not taskId — find the entry.
        for (const info of managed.backgroundTaskRegistry.values()) {
            if (info.toolUseId && info.toolUseId === event.toolUseId) {
                info.elapsedSeconds = event.elapsedSeconds;
                info.lastProgressAt = Date.now();
                break;
            }
        }
    }
    // Forward background task event directly to renderer
    sessionOperationContext.owner["sendEvent"]({
        ...event,
        sessionId,
    }, workspaceId);
    return;
}

export function handleAgentTaskCompleted(sessionOperationContext: SessionOperationContext, managed: ManagedSession, event: Extract<AgentEvent, { type: 'task_completed' }>, sessionId: string, workspaceId: string): void {
    {
        // Capture whether we'd already recorded a terminal result for this task
        // BEFORE mutating state below, so the idle auto-surface (further down)
        // fires at most once even if a duplicate terminal notification arrives.
        // A Workflow's completion notification may key on either the returned
        // Task ID (the registry key) or the wf_ run id, so fall back to a
        // workflowId match before giving up.
        const priorEntry = managed
            ? (managed.backgroundTaskRegistry.get(event.taskId)
                ?? [...managed.backgroundTaskRegistry.values()].find(t => t.workflowId === event.taskId))
            : undefined;
        const wasAlreadyTerminal = priorEntry
            ? priorEntry.status !== 'running'
            : sessionOperationContext.state.taskOutputIndex.has(event.taskId);
        // Store output for later retrieval via getTaskOutput()
        if (managed) {
            managed.backgroundTaskOutputs.set(event.taskId, {
                outputFile: event.outputFile || '',
                summary: event.summary || '',
                status: event.status,
                completedAt: Date.now(),
            });
            // O(1) index for getTaskOutput() — avoids scanning all sessions
            sessionOperationContext.state.taskOutputIndex.set(event.taskId, sessionId);
            // Resolve the running-task registry entry to its terminal status so a
            // later "status?" query reflects reality instead of a stale "running".
            // Match by taskId, or by workflowId (a workflow may complete under its
            // wf_ run id rather than the returned Task ID).
            const running = managed.backgroundTaskRegistry.get(event.taskId)
                ?? [...managed.backgroundTaskRegistry.values()].find(t => t.workflowId === event.taskId);
            if (running) {
                running.status = event.status;
                running.completedAt = Date.now();
            }
            else {
                // Terminal notification for a task we never saw backgrounded (e.g.
                // it completed in the same subprocess before task_backgrounded was
                // matched). Record it so status queries are still truthful.
                managed.backgroundTaskRegistry.set(event.taskId, {
                    taskId: event.taskId,
                    startTime: Date.now(),
                    status: event.status,
                    completedAt: Date.now(),
                });
            }
            sessionLog.info(`[bg-lifecycle] task completed`, {
                sessionId,
                taskId: event.taskId,
                status: event.status,
            });
            sessionOpEvictStaleBackgroundTasks(sessionOperationContext, managed);
        }
        // Forward to renderer for UI update
        sessionOperationContext.owner["sendEvent"]({
            ...event,
            sessionId,
        }, workspaceId);
        // WS2 keep-alive: when a background agent finishes while the session is
        // IDLE, nobody is consuming its result — the main agent already ended its
        // turn, so the completion only updates the registry/chip and the findings
        // never make it back into the conversation ("the agent never returned the
        // result"). Wake the session with a system-generated follow-up so the agent
        // reads the output and presents it. During an active turn (isProcessing)
        // the terminal notification reaches the agent through the live stream, so
        // we skip then. Gated on keep-alive because only that mode delivers this
        // event between turns; guarded against duplicate notifications.
        if (managed && sessionOperationContext.state.keepBackgroundTasksAlive && !managed.isProcessing && !wasAlreadyTerminal) {
            const taskIntent = managed.backgroundTaskRegistry.get(event.taskId)?.intent;
            const outputFile = event.outputFile || managed.backgroundTaskOutputs.get(event.taskId)?.outputFile;
            const label = taskIntent ? `"${taskIntent}"` : `task ${event.taskId}`;
            const nudge = event.status === 'completed'
                ? [
                    `[background-task-completed] The background agent you launched (${label}) has finished.`,
                    outputFile ? `Its full output is saved at: ${outputFile}` : '',
                    `Read that output file and present the results to the user now. Do NOT spawn another background agent — just read the file and summarize the findings inline.`,
                ].filter(Boolean).join('\n')
                : [
                    `[background-task-${event.status}] The background agent you launched (${label}) ended with status "${event.status}".`,
                    outputFile ? `Any partial output is at: ${outputFile}.` : '',
                    `Briefly let the user know it did not complete successfully. Do NOT spawn another background agent.`,
                ].filter(Boolean).join('\n');
            sessionLog.info(`[bg-lifecycle] surfacing completed background task to idle session`, {
                sessionId,
                taskId: event.taskId,
                status: event.status,
            });
            // Ride the normal turn machinery (resume + persistence). `hidden: true`
            // keeps the nudge out of the transcript — the agent's response (the
            // presented result) renders as a normal assistant turn.
            void sessionOperationContext.owner.sendMessage(sessionId, nudge, [], [], {
                hidden: true,
                internalOrigin: { kind: 'agent-message' },
            }).catch((err) => {
                sessionLog.error(`[bg-lifecycle] failed to surface completed task ${event.taskId}:`, err);
            });
        }
        return;
    }
}

export function handleAgentShellBackgrounded(sessionOperationContext: SessionOperationContext, managed: ManagedSession, event: Extract<AgentEvent, { type: 'shell_backgrounded' }>, sessionId: string, workspaceId: string): void {
    // Store the command for later process killing
    if (event.command && managed) {
        managed.backgroundShellCommands.set(event.shellId, event.command);
        sessionLog.info(`Stored command for shell ${event.shellId}: ${event.command.slice(0, 50)}...`);
    }
    // Forward to renderer
    sessionOperationContext.owner["sendEvent"]({
        ...event,
        sessionId,
    }, workspaceId);
    return;
}


