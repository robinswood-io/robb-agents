import { PAUSE_RETIRE_RETRY_BASE_MS, PAUSE_RETIRE_RETRY_MAX_MS, TERMINAL_RETIRE_RETRY_BASE_MS, TERMINAL_RETIRE_RETRY_MAX_MS } from "../shared.ts";
import type { TerminalIntent } from "../shared.ts";
import { REVIEWER_RETIRE_TIMEOUT_MS } from "../review.ts";
import type { ActiveRun } from '../active-run.ts';
import type { ActiveRunSetTerminalIntentIntentPayload } from './protocol.ts';

/** Move runnable children behind a scheduling fence. Actual cancellation is
     * performed by the strong terminal barrier below. */
export function markRunningNodesCancelled(transportOwner: ActiveRun, reason: string): void {
    for (const [nodeId, st] of transportOwner["state"]) {
        if (st.state === 'waiting-approval') {
            st.state = 'cancelled';
            transportOwner["log"]({
                kind: 'node-finished',
                nodeId,
                sessionId: st.sessionId ?? '',
                state: 'cancelled',
                reason,
            });
            continue;
        }
        if (st.state !== 'running')
            continue;
        transportOwner["clearNodeTimeout"](nodeId);
        st.state = 'cancelled';
        transportOwner["log"]({
            kind: 'node-finished',
            nodeId,
            sessionId: st.sessionId ?? '',
            state: 'cancelled',
            reason,
        });
    }
    transportOwner["inFlight"] = 0;
}

export function terminalSessionIds(transportOwner: ActiveRun): string[] {
    return [...new Set([
            ...(transportOwner["terminalIntent"]?.sessionIds ?? []),
            ...[...transportOwner["state"].values()]
                .filter((state) => state.state !== 'done' && state.state !== 'skipped')
                .flatMap((state) => state.sessionId ? [state.sessionId] : []),
        ])];
}

export function setTerminalIntent(transportOwner: ActiveRun, intent: Omit<TerminalIntent, 'sessionIds' | 'reviewerSessionIds'> & ActiveRunSetTerminalIntentIntentPayload): void {
    const sessionIds = transportOwner["terminalSessionIds"]();
    const reviewerSessionIds = [...new Set([
            ...(transportOwner["terminalIntent"]?.reviewerSessionIds ?? []),
            ...(intent.reviewerSessionIds ?? []),
            ...transportOwner["pendingReviewerSessionIds"],
            ...(transportOwner["reviewerSessionId"] ? [transportOwner["reviewerSessionId"]] : []),
        ])];
    transportOwner["terminalIntent"] = { ...intent, sessionIds, reviewerSessionIds };
    transportOwner["log"]({
        kind: 'run-draining',
        target: intent.target,
        cause: intent.cause,
        sessionIds,
        ...(reviewerSessionIds.length > 0 ? { reviewerSessionIds } : {}),
        ...(intent.reason ? { reason: intent.reason } : {}),
        ...(intent.scope ? { scope: intent.scope } : {}),
    });
}

/** Start (or join) the exactly-once terminal barrier. The promise is kept
     * retryable: a failure clears only the in-process attempt, never the durable
     * intent or child identities. */
export function beginTerminalDrain(transportOwner: ActiveRun): Promise<void> {
    if (transportOwner["terminalDrain"])
        return transportOwner["terminalDrain"];
    const intent = transportOwner["terminalIntent"];
    if (!intent)
        return Promise.reject(new Error('Terminal drain requested without a durable intent'));
    const drain = (async () => {
        await transportOwner["drainTerminalChildren"](intent.sessionIds, intent.reviewerSessionIds);
        if (transportOwner["settled"])
            return;
        if (transportOwner["reviewerPending"] || transportOwner["reviewerSessionId"] || transportOwner["pendingReviewerSessionIds"].size > 0) {
            throw new Error('terminal retirement completed without releasing every reviewer identity');
        }
        transportOwner["terminalRetirementAttempts"] = 0;
        if (transportOwner["terminalRetryTimeout"])
            clearTimeout(transportOwner["terminalRetryTimeout"]);
        transportOwner["terminalRetryTimeout"] = undefined;
        if (intent.target === 'failed') {
            transportOwner["finish"]('failed');
            return;
        }
        transportOwner["runStatus"] = 'stopped';
        if (intent.cause === 'kill-switch') {
            transportOwner["log"]({
                kind: 'kill-switch',
                scope: intent.scope ?? 'mission',
                reason: intent.reason ?? 'Execution stopped by kill switch',
            });
        }
        else {
            transportOwner["log"]({ kind: 'run-stopped' });
        }
        transportOwner["finalize"]();
    })();
    transportOwner["terminalDrain"] = drain;
    // Attach a rejection handler for callback-initiated drains while preserving
    // the original promise for explicit stop() callers that need the failure.
    void drain.then(() => {
        if (transportOwner["terminalDrain"] === drain)
            transportOwner["terminalDrain"] = undefined;
    }, () => {
        if (transportOwner["terminalDrain"] === drain) {
            transportOwner["terminalDrain"] = undefined;
            transportOwner["scheduleTerminalDrainRetry"]();
        }
    }).catch((error) => {
        transportOwner["failForUnexpectedAsyncError"]('terminal drain supervision', error);
    });
    return drain;
}

/** Terminal intent is durable, but the current process must also keep
     * supervising a failed strong-retirement attempt. A bounded retry prevents
     * an active child from spending indefinitely until an operator intervenes. */
export function scheduleTerminalDrainRetry(transportOwner: ActiveRun): void {
    if (transportOwner["terminalRetryTimeout"] || !transportOwner["terminalIntent"] || transportOwner["settled"])
        return;
    transportOwner["terminalRetirementAttempts"] += 1;
    const delayMs = Math.min(TERMINAL_RETIRE_RETRY_MAX_MS, TERMINAL_RETIRE_RETRY_BASE_MS * (2 ** Math.min(transportOwner["terminalRetirementAttempts"] - 1, 6)));
    transportOwner["terminalRetryTimeout"] = setTimeout(() => {
        transportOwner["terminalRetryTimeout"] = undefined;
        if (!transportOwner["terminalIntent"] || transportOwner["settled"])
            return;
        void transportOwner["beginTerminalDrain"]().catch(() => {
            // beginTerminalDrain's rejection handler schedules the next bounded
            // attempt; this handler only prevents an unhandled rejection.
        });
    }, delayMs);
    transportOwner["terminalRetryTimeout"].unref?.();
}

export function beginPauseDrain(transportOwner: ActiveRun): Promise<void> {
    if (transportOwner["pauseDrain"])
        return transportOwner["pauseDrain"];
    if (!transportOwner["pauseDrainRequired"]
        && transportOwner["pausedSessionIds"].length === 0
        && transportOwner["activeCreations"].size === 0) {
        return Promise.resolve();
    }
    const drain = (async () => {
        const errors = await transportOwner["retireWorkerSessions"](transportOwner["pausedSessionIds"]);
        if (errors.length > 0) {
            const discovered = transportOwner["deps"].host.listTaskWorkerSessions(transportOwner["deps"].workspaceId, transportOwner["slug"], transportOwner["runId"]).map((session) => session.id);
            transportOwner["pausedSessionIds"] = [...new Set([
                    ...transportOwner["pausedSessionIds"],
                    ...transportOwner["terminalSessionIds"](),
                    ...discovered,
                ])];
            transportOwner["log"]({ kind: 'run-pause-draining', sessionIds: [...transportOwner["pausedSessionIds"]] });
            throw new AggregateError(errors, 'One or more paused task workers could not be retired');
        }
        transportOwner["pausedSessionIds"] = [];
        transportOwner["pauseRetirementAttempts"] = 0;
        if (transportOwner["pauseRetryTimeout"])
            clearTimeout(transportOwner["pauseRetryTimeout"]);
        transportOwner["pauseRetryTimeout"] = undefined;
        if (transportOwner["pauseDrainRequired"]) {
            transportOwner["pauseDrainRequired"] = false;
            transportOwner["log"]({ kind: 'run-pause-drained' });
        }
    })();
    transportOwner["pauseDrain"] = drain;
    void drain.then(() => {
        if (transportOwner["pauseDrain"] === drain) {
            transportOwner["pauseDrain"] = undefined;
            // Resume may have been requested while an earlier drain was failing.
            // The successful watchdog attempt owns that request exactly once.
            transportOwner["resumeAfterPauseDrain"]();
        }
    }, () => {
        if (transportOwner["pauseDrain"] === drain) {
            transportOwner["pauseDrain"] = undefined;
            transportOwner["schedulePauseDrainRetry"]();
        }
    }).catch((error) => {
        transportOwner["failForUnexpectedAsyncError"]('pause drain supervision', error);
    });
    return drain;
}

/** A failed pause fence must remain actively supervised even when nobody
     * presses Resume. The durable pause-draining record lets restart take over;
     * this watchdog keeps retrying while the current process is alive. */
export function schedulePauseDrainRetry(transportOwner: ActiveRun): void {
    if (transportOwner["pauseRetryTimeout"] || transportOwner["runStatus"] !== 'paused'
        || transportOwner["terminalIntent"] || transportOwner["settled"] || !transportOwner["pauseDrainRequired"])
        return;
    transportOwner["pauseRetirementAttempts"] += 1;
    const delayMs = Math.min(PAUSE_RETIRE_RETRY_MAX_MS, PAUSE_RETIRE_RETRY_BASE_MS * (2 ** Math.min(transportOwner["pauseRetirementAttempts"] - 1, 6)));
    transportOwner["pauseRetryTimeout"] = setTimeout(() => {
        transportOwner["pauseRetryTimeout"] = undefined;
        if (transportOwner["runStatus"] !== 'paused' || transportOwner["terminalIntent"] || transportOwner["settled"]
            || !transportOwner["pauseDrainRequired"])
            return;
        void transportOwner["beginPauseDrain"]().catch(() => {
            // beginPauseDrain's own rejection handler schedules the next bounded
            // attempt; this handler only prevents an unhandled rejection.
        });
    }, delayMs);
    transportOwner["pauseRetryTimeout"].unref?.();
}

/** Strongly retire worker identities and close a concurrent createSession
     * window. Errors are returned so terminal drainage can still attempt the
     * reviewer before failing the aggregate barrier. */
export async function retireWorkerSessions(transportOwner: ActiveRun, initialSessionIds: string[]): Promise<Error[]> {
    const retired = new Set<string>();
    const errors: Error[] = [];
    const retireWorker = async (sessionId: string): Promise<void> => {
        if (retired.has(sessionId))
            return;
        retired.add(sessionId);
        try {
            const event = await transportOwner["deps"].host.cancelProcessingAndWait(sessionId, REVIEWER_RETIRE_TIMEOUT_MS);
            const issue = transportOwner["accountSessionUsage"](event);
            if (issue)
                transportOwner["failForUsageIssue"](issue);
            await transportOwner["deps"].host.setSessionStatus(sessionId, 'cancelled');
            await transportOwner["deps"].host.setKanbanColumn(sessionId, 'todo');
        }
        catch (error) {
            errors.push(error instanceof Error ? error : new Error(String(error)));
        }
    };
    const discoverWorkers = () => transportOwner["deps"].host.listTaskWorkerSessions(transportOwner["deps"].workspaceId, transportOwner["slug"], transportOwner["runId"]).map((session) => session.id);
    for (const sessionId of [...new Set([...initialSessionIds, ...discoverWorkers()])]) {
        await retireWorker(sessionId);
    }
    // Each tracked creation logs its identity before resolving. Waiting here
    // ensures the second snapshot contains every child that raced the fence.
    const creations = [...transportOwner["activeCreations"]];
    if (creations.length > 0)
        await Promise.allSettled(creations);
    for (const sessionId of [...new Set([...transportOwner["terminalSessionIds"](), ...discoverWorkers()])]) {
        await retireWorker(sessionId);
    }
    return errors;
}

/** Prove every worker and reviewer idle, and record their final cumulative
     * usage, before a terminal state is published. All candidates are attempted
     * even when one retirement fails. */
export async function drainTerminalChildren(transportOwner: ActiveRun, initialSessionIds: string[], initialReviewerSessionIds: string[]): Promise<void> {
    const errors = await transportOwner["retireWorkerSessions"](initialSessionIds);
    try {
        const completedReviewer = await transportOwner["retirePendingReviewer"](initialReviewerSessionIds);
        if (completedReviewer) {
            await transportOwner["deps"].host.setSessionStatus(completedReviewer.sessionId, 'cancelled');
            await transportOwner["deps"].host.setKanbanColumn(completedReviewer.sessionId, 'todo');
        }
    }
    catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
    }
    if (errors.length > 0) {
        throw new AggregateError(errors, 'One or more task child sessions could not be retired');
    }
}
