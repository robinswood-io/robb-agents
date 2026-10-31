import type { SessionOperationContext } from '../operation-context.ts';
import { readFile } from 'fs/promises';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import type { RunningBackgroundTask } from '../runtime-types.ts';
import { trackSessionOperation as sessionOpTrackSessionOperation, assertSessionOperationOwner as sessionOpAssertSessionOperationOwner } from './track-session-operation.ts';

async function sessionOpKillShell(sessionOperationContext: SessionOperationContext, sessionId: string, shellId: string): Promise<{
    success: boolean;
    error?: string;
}> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed) {
        return { success: false, error: 'Session not found' };
    }
    return sessionOpTrackSessionOperation(sessionOperationContext, managed, () => sessionOpPerformKillShell(sessionOperationContext, managed, shellId));
}

async function sessionOpPerformKillShell(sessionOperationContext: SessionOperationContext, managed: ManagedSession, shellId: string): Promise<{
    success: boolean;
    error?: string;
}> {
    const sessionId = managed.id;
    sessionLog.info(`Killing shell ${shellId} for session: ${sessionId}`);
    // Try to kill the actual process using the stored command
    const command = managed.backgroundShellCommands.get(shellId);
    if (command) {
        try {
            // Use pkill to find and kill processes matching the command
            // The -f flag matches against the full command line
            const { exec } = await import('child_process');
            const { promisify } = await import('util');
            const execAsync = promisify(exec);
            // Escape the command for use in pkill pattern
            // We search for the unique command string in process args
            const escapedCommand = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            sessionLog.info(`Attempting to kill process with command: ${command.slice(0, 100)}...`);
            // Use pgrep first to find the PID, then kill it
            // This is safer than pkill -f which can match too broadly
            try {
                const { stdout } = await execAsync(`pgrep -f "${escapedCommand}"`);
                const pids = stdout.trim().split('\n').filter(Boolean);
                if (pids.length > 0) {
                    sessionLog.info(`Found ${pids.length} process(es) to kill: ${pids.join(', ')}`);
                    // Kill each process
                    for (const pid of pids) {
                        try {
                            await execAsync(`kill -TERM ${pid}`);
                            sessionLog.info(`Sent SIGTERM to process ${pid}`);
                        }
                        catch (killErr) {
                            // Process may have already exited
                            sessionLog.warn(`Failed to kill process ${pid}: ${killErr}`);
                        }
                    }
                }
                else {
                    sessionLog.info(`No processes found matching command`);
                }
            }
            catch {
                // pgrep returns exit code 1 when no processes found, which is fine
                sessionLog.info(`No matching processes found (pgrep returned no results)`);
            }
            // Clean up the stored command only while this exact session remains
            // the live owner. Deletion waits on this lease and then owns teardown.
            sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
            managed.backgroundShellCommands.delete(shellId);
        }
        catch (err) {
            sessionLog.error(`Error killing shell process: ${err}`);
        }
    }
    else {
        sessionLog.warn(`No command stored for shell ${shellId}, cannot kill process`);
    }
    sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
    // Always emit shell_killed to remove from UI regardless of process kill success
    sessionOperationContext.owner["sendEvent"]({
        type: 'shell_killed',
        sessionId,
        shellId,
    }, managed.workspace.id);
    return { success: true };
}

/**
 * Evict stale entries from both background-task maps to bound memory.
 * - backgroundTaskOutputs: completed outputs older than 1h (existing behavior).
 * - backgroundTaskRegistry: terminal/orphaned entries older than 1h. Running
 *   entries are never evicted here (they are resolved on completion or orphaned
 *   at turn end).
 */
function sessionOpEvictStaleBackgroundTasks(sessionOperationContext: SessionOperationContext, managed: ManagedSession): void {
    const ONE_HOUR = 3600000;
    const now = Date.now();
    for (const [tid, info] of managed.backgroundTaskOutputs) {
        if (now - info.completedAt > ONE_HOUR) {
            managed.backgroundTaskOutputs.delete(tid);
            sessionOperationContext.state.taskOutputIndex.delete(tid);
        }
    }
    for (const [tid, info] of managed.backgroundTaskRegistry) {
        if (info.status !== 'running' && info.completedAt && now - info.completedAt > ONE_HOUR) {
            managed.backgroundTaskRegistry.delete(tid);
        }
    }
}

/**
 * Mark still-running background tasks for a session as `orphaned`.
 *
 * Called when a turn finishes (onProcessingStopped). With the default per-turn
 * subprocess model, background sub-agents die when the query/subprocess is torn
 * down at turn end, but their terminal notifications may never arrive (or arrive
 * only on a later turn's subprocess). Marking them `orphaned` here keeps a
 * "status?" query truthful — it must never report a dead task as "running".
 *
 * No-op once WS2 keep-alive is enabled: with a persistent query the tasks
 * genuinely outlive the turn, so `keepBackgroundTasksAlive` short-circuits this.
 */
function sessionOpMarkOrphanedBackgroundTasks(sessionOperationContext: SessionOperationContext, sessionId: string): void {
    if (sessionOperationContext.state.keepBackgroundTasksAlive)
        return;
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed)
        return;
    const now = Date.now();
    let orphaned = 0;
    for (const info of managed.backgroundTaskRegistry.values()) {
        if (info.status === 'running') {
            info.status = 'orphaned';
            info.completedAt = now;
            orphaned++;
        }
    }
    if (orphaned > 0) {
        sessionLog.info(`[bg-lifecycle] turn ended — orphaned ${orphaned} still-running background task(s)`, {
            sessionId,
        });
    }
}

/**
 * Enumerate background tasks for a session for a "status?" query.
 * Returns the main-process registry snapshot — the real source of truth across
 * subprocess boundaries (the SDK's in-subprocess task tools cannot see tasks
 * from a prior, torn-down subprocess).
 */
function sessionOpListBackgroundTasks(sessionOperationContext: SessionOperationContext, sessionId: string): RunningBackgroundTask[] {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed)
        return [];
    return Array.from(managed.backgroundTaskRegistry.values())
        .map((t) => ({ ...t }))
        .sort((a, b) => b.startTime - a.startTime);
}

/** Resolve the session owning a completed task without consuming output. */
function sessionOpGetTaskSessionId(sessionOperationContext: SessionOperationContext, taskId: string): string | undefined {
    return sessionOperationContext.state.taskOutputIndex.get(taskId);
}

/**
 * Get output from a background task
 *
 * Looks up the output file stored when a task_completed event was received,
 * reads its contents, and returns them. Falls back to the SDK-provided summary
 * if the file cannot be read.
 *
 * @param taskId - The task or shell ID
 * @returns Task output content, or null if task not found
 */
async function sessionOpGetTaskOutput(sessionOperationContext: SessionOperationContext, taskId: string): Promise<string | null> {
    // O(1) lookup via taskOutputIndex
    const sessionId = sessionOperationContext.state.taskOutputIndex.get(taskId);
    if (!sessionId) {
        sessionLog.info(`No output found for task: ${taskId} (task may still be running)`);
        return null;
    }
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    const info = managed?.backgroundTaskOutputs.get(taskId);
    if (!info) {
        // Index out of sync — clean up stale entry
        sessionOperationContext.state.taskOutputIndex.delete(taskId);
        return null;
    }
    sessionLog.info(`Found output for task ${taskId}: file=${info.outputFile}, status=${info.status}`);
    try {
        const content = await readFile(info.outputFile, 'utf-8');
        // Delete after successful read to prevent memory leak
        managed!.backgroundTaskOutputs.delete(taskId);
        sessionOperationContext.state.taskOutputIndex.delete(taskId);
        return content;
    }
    catch (err) {
        sessionLog.error(`Failed to read task output file: ${info.outputFile}`, err);
        // Fall back to SDK-provided summary
        return info.summary || null;
    }
}

export { sessionOpKillShell as killShell };
export { sessionOpPerformKillShell as performKillShell };
export { sessionOpEvictStaleBackgroundTasks as evictStaleBackgroundTasks };
export { sessionOpMarkOrphanedBackgroundTasks as markOrphanedBackgroundTasks };
export { sessionOpListBackgroundTasks as listBackgroundTasks };
export { sessionOpGetTaskSessionId as getTaskSessionId };
export { sessionOpGetTaskOutput as getTaskOutput };
