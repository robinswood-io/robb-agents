import { type RunLogEntry, appendRunLog, evaluateKillSwitch, type GuardDecision } from "@craft-agent/shared/tasks";
import { taskRunnerLog, FAILED_STATUS, MAX_TIMER_DELAY_MS } from "../shared.ts";
import type { RunLogEntryInput } from "../shared.ts";
import { REVIEWER_RETIRE_TIMEOUT_MS } from "../review.ts";
import type { ActiveRun } from '../active-run.ts';

/**
     * The set of nodes a repair pass re-runs: the orchestrator-named nodes plus everything that
     * (transitively) depends on them. Unknown/empty names degrade to the whole DAG.
     */
export function computeFrontier(transportOwner: ActiveRun, named?: string[]): Set<string> {
    const valid = (named ?? []).filter((id) => transportOwner["state"].has(id));
    if (valid.length === 0)
        return new Set(transportOwner["spec"].nodes.map((n) => n.id));
    const dependents = transportOwner.dependentsMap();
    const frontier = new Set<string>();
    const queue = [...valid];
    while (queue.length) {
        const id = queue.shift()!;
        if (frontier.has(id))
            continue;
        frontier.add(id);
        for (const d of dependents.get(id) ?? [])
            if (!frontier.has(d))
                queue.push(d);
    }
    return frontier;
}

/** Inverted `edges`: node id → set of nodes that directly depend on it (memoized). */
export function dependentsMap(transportOwner: ActiveRun): Map<string, Set<string>> {
    if (transportOwner.dependents)
        return transportOwner.dependents;
    const map = new Map<string, Set<string>>();
    for (const n of transportOwner["spec"].nodes)
        map.set(n.id, new Set());
    for (const [node, upstreams] of transportOwner.edges) {
        for (const u of upstreams)
            map.get(u)?.add(node);
    }
    transportOwner.dependents = map;
    return map;
}

export function hasDeferredRetry(transportOwner: ActiveRun): boolean {
    for (const st of transportOwner["state"].values()) {
        if (st.state === 'pending' && st.retryAtMs !== undefined && st.retryAtMs > transportOwner["currentTimeMs"]()) {
            return true;
        }
    }
    return false;
}

// --- helpers ---
export function isTerminal(transportOwner: ActiveRun): boolean {
    return transportOwner["runStatus"] === 'completed' || transportOwner["runStatus"] === 'failed' || transportOwner["runStatus"] === 'stopped';
}

export function currentTimeMs(transportOwner: ActiveRun): number {
    if (transportOwner["deps"].nowMs)
        return transportOwner["deps"].nowMs();
    return Date.now();
}

export function idempotencyKey(transportOwner: ActiveRun, nodeId: string): string {
    return `${transportOwner["deps"].workspaceId}:${transportOwner["spec"].id}:${transportOwner["runId"]}:${nodeId}`;
}

export function currentKillSwitch(transportOwner: ActiveRun): GuardDecision {
    try {
        return evaluateKillSwitch(transportOwner["deps"].getKillSwitch(), transportOwner["deps"].workspaceId, transportOwner["spec"].id);
    }
    catch {
        return { allowed: false, reason: 'Kill-switch state is unavailable' };
    }
}

export function stopForKillSwitch(transportOwner: ActiveRun, reason: string): void {
    if (transportOwner["isTerminal"]() || transportOwner["terminalIntent"])
        return;
    const scope = reason.startsWith('Global')
        ? 'global'
        : reason.startsWith('Workspace')
            ? 'workspace'
            : 'mission';
    transportOwner["setTerminalIntent"]({ target: 'stopped', cause: 'kill-switch', reason, scope });
    transportOwner["markRunningNodesCancelled"](reason);
    transportOwner["beginTerminalDrain"]();
}

export function armNodeTimeout(transportOwner: ActiveRun, nodeId: string, sessionId: string, attempt: number, timeoutMs: number): void {
    transportOwner["clearNodeTimeout"](nodeId);
    const deadlineMs = Math.min(Number.MAX_SAFE_INTEGER, transportOwner["currentTimeMs"]() + Math.max(0, timeoutMs));
    const onTimer = () => {
        transportOwner["nodeTimeouts"].delete(nodeId);
        const remainingMs = deadlineMs - transportOwner["currentTimeMs"]();
        if (remainingMs > 0) {
            const next = setTimeout(onTimer, Math.min(remainingMs, MAX_TIMER_DELAY_MS));
            transportOwner["nodeTimeouts"].set(nodeId, next);
            return;
        }
        const st = transportOwner["state"].get(nodeId);
        if (!st || st.state !== 'running' || st.sessionId !== sessionId || st.attempt !== attempt)
            return;
        void transportOwner.retireTimedOutNode(nodeId, sessionId, timeoutMs).catch((error: unknown) => {
            transportOwner["failForUnexpectedAsyncError"](`timeout retirement ${nodeId}`, error);
        });
    };
    const timer = setTimeout(onTimer, Math.min(Math.max(0, deadlineMs - transportOwner["currentTimeMs"]()), MAX_TIMER_DELAY_MS));
    transportOwner["nodeTimeouts"].set(nodeId, timer);
}

export async function retireTimedOutNode(transportOwner: ActiveRun, nodeId: string, sessionId: string, timeoutMs: number): Promise<void> {
    const st = transportOwner["state"].get(nodeId);
    if (!st || st.state !== 'running' || st.sessionId !== sessionId)
        return;
    if (transportOwner["timeoutRetirements"].has(sessionId))
        return;
    transportOwner["timeoutRetirements"].add(sessionId);
    const reason = `execution timeout after ${timeoutMs}ms`;
    // Fence completions and retries before requesting cancellation. A retry is
    // released only after the host proves this exact attempt idle.
    st.state = 'cancelled';
    st.lastFailure = reason;
    transportOwner["inFlight"] = Math.max(0, transportOwner["inFlight"] - 1);
    transportOwner["sessionToNode"].delete(sessionId);
    transportOwner["log"]({ kind: 'node-finished', nodeId, sessionId, state: 'cancelled', reason });
    try {
        const event = await transportOwner["deps"].host.cancelProcessingAndWait(sessionId, REVIEWER_RETIRE_TIMEOUT_MS);
        const budget = transportOwner["accountSessionUsage"](event);
        await transportOwner["deps"].host.setSessionStatus(sessionId, FAILED_STATUS);
        await transportOwner["deps"].host.setKanbanColumn(sessionId, 'todo');
        transportOwner["timeoutRetirements"].delete(sessionId);
        if (transportOwner["runStatus"] !== 'running' || transportOwner["terminalIntent"] || transportOwner["settled"])
            return;
        if (budget) {
            transportOwner["failForUsageIssue"](budget);
            return;
        }
        transportOwner["failNode"](nodeId, reason, sessionId, true, 'error');
    }
    catch (error) {
        st.lastFailure = `${reason}; retirement failed: ${error instanceof Error ? error.message : String(error)}`;
        if (!transportOwner["terminalIntent"] && !transportOwner["settled"]) {
            // A timed-out attempt whose stop cannot be proven is unsafe to retry.
            // Escalate to the durable whole-run barrier; terminal failure is still
            // withheld until a later strong attempt proves every child idle.
            transportOwner["setTerminalIntent"]({ target: 'failed', cause: 'timeout', reason: st.lastFailure });
            transportOwner["markRunningNodesCancelled"](st.lastFailure);
            transportOwner["beginTerminalDrain"]();
        }
        // Only release the local barrier after a durable terminal intent owns
        // the same identity. If persistence itself failed, withholding ordinary
        // completion is safer than publishing while the child may still spend.
        if (transportOwner["terminalIntent"] || transportOwner["settled"])
            transportOwner["timeoutRetirements"].delete(sessionId);
    }
}

export function clearNodeTimeout(transportOwner: ActiveRun, nodeId: string): void {
    const timeout = transportOwner["nodeTimeouts"].get(nodeId);
    if (timeout)
        clearTimeout(timeout);
    transportOwner["nodeTimeouts"].delete(nodeId);
}

export function armRetry(transportOwner: ActiveRun, nodeId: string, retryAtMs: number): void {
    if (transportOwner["retryTimeouts"].has(nodeId))
        return;
    const delayMs = Math.max(0, retryAtMs - transportOwner["currentTimeMs"]());
    const timer = setTimeout(() => {
        transportOwner["retryTimeouts"].delete(nodeId);
        const st = transportOwner["state"].get(nodeId);
        if (!st || st.state !== 'pending')
            return;
        if (st.retryAtMs !== undefined && st.retryAtMs > transportOwner["currentTimeMs"]()) {
            transportOwner["armRetry"](nodeId, st.retryAtMs);
            return;
        }
        delete st.retryAtMs;
        transportOwner["scheduleReady"]();
    }, Math.min(delayMs, 2147483647));
    transportOwner["retryTimeouts"].set(nodeId, timer);
}

export function clearRetryTimeout(transportOwner: ActiveRun, nodeId: string): void {
    const timeout = transportOwner["retryTimeouts"].get(nodeId);
    if (timeout)
        clearTimeout(timeout);
    transportOwner["retryTimeouts"].delete(nodeId);
}

export function reportAsyncFailure(transportOwner: ActiveRun, operation: string, error: unknown, context: Record<string, unknown>): void {
    taskRunnerLog.warn('Asynchronous TaskRunner operation failed', {
        taskSlug: transportOwner["slug"],
        runId: transportOwner["runId"],
        operation,
        ...context,
        error: error instanceof Error ? error.message : String(error),
    });
}

/** Board/session metadata is observational UI state. A rejected update must
     * be visible in logs, but must not rewrite the durable execution verdict. */
export function bestEffortHostMetadata(transportOwner: ActiveRun, operation: string, sessionId: string, mutation: () => Promise<void>): void {
    try {
        void mutation().catch((error: unknown) => {
            transportOwner.reportAsyncFailure(operation, error, { sessionId });
        });
    }
    catch (error) {
        transportOwner.reportAsyncFailure(operation, error, { sessionId });
    }
}

/** An unexpected rejection from a detached control-flow promise is a run
     * safety failure, not best-effort metadata. Convert it into the same durable
     * terminal barrier used by budget, deadline and timeout failures. */
export function failForUnexpectedAsyncError(transportOwner: ActiveRun, operation: string, error: unknown): void {
    transportOwner.reportAsyncFailure(operation, error);
    if (transportOwner["settled"] || transportOwner["terminalIntent"] || transportOwner["isTerminal"]())
        return;
    const reason = `${operation} failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`;
    try {
        transportOwner["setTerminalIntent"]({ target: 'failed', cause: 'recovery', reason });
        transportOwner["markRunningNodesCancelled"](reason);
        transportOwner["beginTerminalDrain"]();
    }
    catch (barrierError) {
        transportOwner.reportAsyncFailure(`${operation}: terminal barrier setup`, barrierError);
    }
}

export function log(transportOwner: ActiveRun, entry: RunLogEntryInput): void {
    const t = transportOwner["deps"].now ? transportOwner["deps"].now() : new Date().toISOString();
    appendRunLog(transportOwner["deps"].workspaceRoot, transportOwner["slug"], transportOwner["runId"], { ...entry, t } as RunLogEntry);
}
