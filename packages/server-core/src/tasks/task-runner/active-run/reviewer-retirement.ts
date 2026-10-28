import type { SessionCompletionEvent } from "../../../sessions/SessionManager";
import { DONE_STATUS, FAILED_STATUS, MAX_TIMER_DELAY_MS } from "../shared.ts";
import type { UsageIssue } from "../shared.ts";
import { REVIEWER_RETIRE_TIMEOUT_MS, ReviewerRetirementError } from "../review.ts";
import type { ActiveRun } from '../active-run.ts';

export function isCurrentVerification(transportOwner: ActiveRun, generation: number): boolean {
    return !transportOwner["settled"]
        && !transportOwner["terminalIntent"]
        && transportOwner["runStatus"] === 'verifying'
        && transportOwner["verificationGeneration"] === generation;
}

export function isCurrentReviewer(transportOwner: ActiveRun, reviewerSessionId: string, generation: number): boolean {
    return transportOwner["isCurrentVerification"](generation) && transportOwner["reviewerSessionId"] === reviewerSessionId;
}

export function settleReviewerSession(transportOwner: ActiveRun, reviewerSessionId: string, acceptedResult: boolean): void {
    transportOwner["clearReviewerTimeout"]();
    transportOwner["verdictOff"]?.();
    transportOwner["verdictOff"] = undefined;
    transportOwner["reviewerPending"] = false;
    if (transportOwner["reviewerSessionId"] === reviewerSessionId) {
        transportOwner["reviewerSessionId"] = undefined;
        delete transportOwner.reviewerContract;
    }
    transportOwner["pendingReviewerSessionIds"].delete(reviewerSessionId);
    transportOwner["bestEffortHostMetadata"]('settle reviewer session status', reviewerSessionId, () => (transportOwner["deps"].host.setSessionStatus(reviewerSessionId, acceptedResult ? DONE_STATUS : FAILED_STATUS)));
    transportOwner["bestEffortHostMetadata"]('settle reviewer kanban column', reviewerSessionId, () => (transportOwner["deps"].host.setKanbanColumn(reviewerSessionId, acceptedResult ? 'done' : 'todo')));
}

export function failReviewer(transportOwner: ActiveRun, reviewerSessionId: string | undefined, reason: string): void {
    if (transportOwner["runStatus"] !== 'verifying' || transportOwner["reviewerFailure"] || transportOwner["terminalIntent"])
        return;
    transportOwner["verificationGeneration"] += 1;
    transportOwner["clearReviewerTimeout"]();
    transportOwner["verdictOff"]?.();
    transportOwner["verdictOff"] = undefined;
    const sessionId = reviewerSessionId ?? transportOwner["reviewerSessionId"];
    if (sessionId)
        transportOwner["pendingReviewerSessionIds"].add(sessionId);
    transportOwner["reviewerPending"] = transportOwner["pendingReviewerSessionIds"].size > 0;
    transportOwner.recoveredReviewerResultReusable = false;
    transportOwner["persistReviewerOutput"](sessionId, 'invalid', '', reason);
    transportOwner["log"]({ kind: 'verdict', result: 'unparsed', reason });
    // Every reviewer failure uses the same durable whole-run barrier as worker
    // failures. This prevents a discovered create-before-output reviewer from
    // being omitted by a one-id direct finish path.
    transportOwner["setTerminalIntent"]({ target: 'failed', cause: 'reviewer', reason });
    transportOwner["markRunningNodesCancelled"](reason);
    const retirement = transportOwner["beginTerminalDrain"]();
    transportOwner["reviewerFailure"] = retirement;
    void retirement.then(() => {
        if (transportOwner["reviewerFailure"] === retirement)
            transportOwner["reviewerFailure"] = undefined;
    }, () => {
        if (transportOwner["reviewerFailure"] === retirement)
            transportOwner["reviewerFailure"] = undefined;
    }).catch((error: unknown) => {
        transportOwner["failForUnexpectedAsyncError"]('reviewer retirement bookkeeping', error);
    });
}

export async function retirePendingReviewer(transportOwner: ActiveRun, initialSessionIds: string[]): Promise<SessionCompletionEvent | undefined> {
    transportOwner["clearReviewerTimeout"]();
    transportOwner["verdictOff"]?.();
    transportOwner["verdictOff"] = undefined;
    const orchestrator = transportOwner["opts"].orchestratorSessionId;
    const discovered = orchestrator
        ? transportOwner["deps"].host.listTaskReviewerSessions(transportOwner["deps"].workspaceId, transportOwner["slug"], transportOwner["runId"], orchestrator).map((session) => session.id)
        : [];
    const reviewerSessionIds = [...new Set([
            ...initialSessionIds,
            ...transportOwner["pendingReviewerSessionIds"],
            ...(transportOwner["reviewerSessionId"] ? [transportOwner["reviewerSessionId"]] : []),
            ...discovered,
        ])];
    if (reviewerSessionIds.length === 0) {
        transportOwner["reviewerSessionId"] = undefined;
        transportOwner["reviewerPending"] = false;
        delete transportOwner.reviewerContract;
        return undefined;
    }
    for (const sessionId of reviewerSessionIds)
        transportOwner["pendingReviewerSessionIds"].add(sessionId);
    // Close the create-before-output crash window before the first await.
    transportOwner["persistReviewerCandidateIds"]();
    const completed: SessionCompletionEvent[] = [];
    const retirementErrors: Array<{
        sessionId: string;
        error: Error;
    }> = [];
    let budget: UsageIssue | null = null;
    // Deliberately serial: no replacement can be created until every durable
    // candidate has received a strong retirement attempt. One failure does not
    // leave the remaining candidates spending unchecked.
    for (const reviewerSessionId of reviewerSessionIds) {
        try {
            const event = await transportOwner["deps"].host.cancelProcessingAndWait(reviewerSessionId, REVIEWER_RETIRE_TIMEOUT_MS);
            const observedBudget = transportOwner["accountSessionUsage"](event);
            budget ??= observedBudget;
            if (event.reason === 'complete')
                completed.push(event);
            else {
                await transportOwner["deps"].host.setSessionStatus(reviewerSessionId, 'cancelled');
                await transportOwner["deps"].host.setKanbanColumn(reviewerSessionId, 'todo');
                transportOwner["pendingReviewerSessionIds"].delete(reviewerSessionId);
            }
        }
        catch (error) {
            retirementErrors.push({
                sessionId: reviewerSessionId,
                error: error instanceof Error ? error : new Error(String(error)),
            });
        }
    }
    if (retirementErrors.length) {
        // Completed peers are already idle but cannot be reused while another
        // candidate remains ambiguous. Retire their metadata as well, retaining
        // any identity whose update could not be confirmed.
        for (const event of completed) {
            try {
                await transportOwner["deps"].host.setSessionStatus(event.sessionId, 'cancelled');
                await transportOwner["deps"].host.setKanbanColumn(event.sessionId, 'todo');
                transportOwner["pendingReviewerSessionIds"].delete(event.sessionId);
            }
            catch (error) {
                retirementErrors.push({
                    sessionId: event.sessionId,
                    error: error instanceof Error ? error : new Error(String(error)),
                });
            }
        }
        transportOwner["persistReviewerCandidateIds"]();
        throw new ReviewerRetirementError([...transportOwner["pendingReviewerSessionIds"]], retirementErrors.map((entry) => entry.error));
    }
    if (completed.length > 1) {
        const metadataErrors: Error[] = [];
        for (const event of completed) {
            try {
                await transportOwner["deps"].host.setSessionStatus(event.sessionId, FAILED_STATUS);
                await transportOwner["deps"].host.setKanbanColumn(event.sessionId, 'todo');
                transportOwner["pendingReviewerSessionIds"].delete(event.sessionId);
            }
            catch (error) {
                metadataErrors.push(error instanceof Error ? error : new Error(String(error)));
            }
        }
        transportOwner["persistReviewerCandidateIds"]();
        if (metadataErrors.length > 0) {
            throw new ReviewerRetirementError([...transportOwner["pendingReviewerSessionIds"]], metadataErrors);
        }
        throw new Error(`Ambiguous reviewer recovery: ${completed.length} completed reviewer sessions are eligible`);
    }
    if (completed[0])
        transportOwner["pendingReviewerSessionIds"].delete(completed[0].sessionId);
    transportOwner["persistReviewerCandidateIds"]();
    transportOwner["reviewerSessionId"] = undefined;
    transportOwner["reviewerPending"] = false;
    delete transportOwner.reviewerContract;
    if (budget) {
        transportOwner["failForUsageIssue"](budget);
    }
    return completed[0];
}

export function armReviewerTimeout(transportOwner: ActiveRun, reviewerSessionId: string, generation: number, timeoutMs: number): void {
    transportOwner["clearReviewerTimeout"]();
    const deadlineMs = Math.min(Number.MAX_SAFE_INTEGER, transportOwner["currentTimeMs"]() + Math.max(0, timeoutMs));
    const onTimer = () => {
        transportOwner["reviewerTimeout"] = undefined;
        if (!transportOwner["isCurrentReviewer"](reviewerSessionId, generation))
            return;
        const remainingMs = deadlineMs - transportOwner["currentTimeMs"]();
        if (remainingMs > 0) {
            transportOwner["reviewerTimeout"] = setTimeout(onTimer, Math.min(remainingMs, MAX_TIMER_DELAY_MS));
            return;
        }
        transportOwner["failReviewer"](reviewerSessionId, `reviewer timed out after ${timeoutMs} ms`);
    };
    transportOwner["reviewerTimeout"] = setTimeout(onTimer, Math.min(Math.max(0, deadlineMs - transportOwner["currentTimeMs"]()), MAX_TIMER_DELAY_MS));
}

export function clearReviewerTimeout(transportOwner: ActiveRun): void {
    if (transportOwner["reviewerTimeout"])
        clearTimeout(transportOwner["reviewerTimeout"]);
    transportOwner["reviewerTimeout"] = undefined;
}
