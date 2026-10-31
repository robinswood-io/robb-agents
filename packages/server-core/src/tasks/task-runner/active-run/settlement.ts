import { createHash } from "node:crypto";
import { operationValueHash, type SignedExecutionProof } from "@craft-agent/shared/governance";
import type { SessionCompletionEvent } from "../../../sessions/SessionManager";
import { type NodeOutput, writeNodeOutput } from "@craft-agent/shared/tasks";
import { DONE_STATUS, FAILED_STATUS, retryMatches, retryDelayMs } from "../shared.ts";
import type { TaskFailureClass, RunStatus } from "../shared.ts";
import type { ActiveRun } from '../active-run.ts';

export function onSessionComplete(transportOwner: ActiveRun, evt: SessionCompletionEvent): void {
    const nodeId = transportOwner["sessionToNode"].get(evt.sessionId);
    if (!nodeId)
        return; // not one of our child nodes
    const st = transportOwner["state"].get(nodeId);
    if (!st || st.state !== 'running')
        return; // already settled/cancelled
    if (st.sessionId !== evt.sessionId)
        return; // stale completion from an earlier retry attempt
    transportOwner["clearNodeTimeout"](nodeId);
    const measuredBreach = transportOwner["accountSessionUsage"](evt);
    if (measuredBreach && transportOwner["runStatus"] === 'running') {
        transportOwner["failForUsageIssue"](measuredBreach);
        return;
    }
    if (evt.reason === 'complete') {
        const text = evt.finalText ?? transportOwner["deps"].host.getSessionFinalText(evt.sessionId) ?? '';
        // A clean turn-completion is not proof of success: a node that declared `outputs` but
        // produced no text delivered nothing. Treat that as a failure (retry/needs-review) instead
        // of silently marking it done. Nodes with no declared outputs keep the lenient behavior.
        const node = transportOwner["spec"].nodes.find((n) => n.id === nodeId);
        if ((node?.outputs?.length ?? 0) > 0 && text.trim() === '') {
            transportOwner["failNode"](nodeId, 'completed without producing declared output', evt.sessionId, true, 'empty');
            return;
        }
        let executionProof: SignedExecutionProof | undefined;
        if (node?.effect === 'external-mutation') {
            if (!evt.executionProof || !transportOwner["deps"].verifyExecutionProof) {
                transportOwner["failNode"](nodeId, 'external mutation completed without an authoritative provider-reconciled execution proof', evt.sessionId, false);
                return;
            }
            const proofDecision = transportOwner["deps"].verifyExecutionProof(evt.executionProof, {
                workspaceId: transportOwner["deps"].workspaceId,
                missionId: transportOwner["spec"].id,
                nodeId,
                idempotencyKey: transportOwner["idempotencyKey"](nodeId),
            });
            if (!proofDecision.allowed) {
                transportOwner["failNode"](nodeId, `external mutation proof rejected: ${proofDecision.code}: ${proofDecision.reason}`, evt.sessionId, false);
                return;
            }
            executionProof = proofDecision.proof;
        }
        const output: NodeOutput = { text };
        transportOwner["outputs"][nodeId] = output;
        st.state = 'done';
        transportOwner["inFlight"] = Math.max(0, transportOwner["inFlight"] - 1);
        writeNodeOutput(transportOwner["deps"].workspaceRoot, transportOwner["slug"], transportOwner["runId"], nodeId, output);
        transportOwner["log"]({
            kind: 'node-checkpoint',
            nodeId,
            idempotencyKey: transportOwner["idempotencyKey"](nodeId),
            status: 'confirmed',
            proofHash: executionProof
                ? operationValueHash(executionProof)
                : createHash('sha256').update(text, 'utf8').digest('hex'),
            ...(executionProof ? { executionProof } : {}),
        });
        transportOwner["log"]({ kind: 'node-finished', nodeId, sessionId: evt.sessionId, state: 'done' });
        transportOwner["sessionToNode"].delete(evt.sessionId);
        transportOwner["bestEffortHostMetadata"]('mark completed worker session done', evt.sessionId, () => (transportOwner["deps"].host.setSessionStatus(evt.sessionId, DONE_STATUS)));
        transportOwner["bestEffortHostMetadata"]('mark completed worker column done', evt.sessionId, () => (transportOwner["deps"].host.setKanbanColumn(evt.sessionId, 'done')));
        transportOwner["scheduleReady"]();
    }
    else if (evt.reason === 'interrupted') {
        const interruptedNode = transportOwner["spec"].nodes.find((candidate) => candidate.id === nodeId);
        if (interruptedNode?.effect !== 'read') {
            transportOwner["failNode"](nodeId, 'mutation interrupted after execution began; reconcile durable state before an explicit replay', evt.sessionId, false);
        }
        else {
            // Read-only and workspace-local work can be explicitly resumed from pending state.
            st.state = 'cancelled';
            transportOwner["inFlight"] = Math.max(0, transportOwner["inFlight"] - 1);
            transportOwner["log"]({ kind: 'node-finished', nodeId, sessionId: evt.sessionId, state: 'cancelled', reason: 'interrupted' });
            transportOwner["bestEffortHostMetadata"]('return interrupted worker column to todo', evt.sessionId, () => (transportOwner["deps"].host.setKanbanColumn(evt.sessionId, 'todo')));
            transportOwner["scheduleReady"]();
        }
    }
    else {
        // 'error' | 'timeout'
        transportOwner["failNode"](nodeId, evt.reason, evt.sessionId);
    }
}

export function failNode(transportOwner: ActiveRun, nodeId: string, reason: string, allowRetry: boolean, failureClass: TaskFailureClass, sessionId?: string): void {
    transportOwner["clearNodeTimeout"](nodeId);
    const st = transportOwner["state"].get(nodeId)!;
    const wasRunning = st.state === 'running';
    if (wasRunning)
        transportOwner["inFlight"] = Math.max(0, transportOwner["inFlight"] - 1);
    // Bounded, failure-aware retry: node override → task default → production fallback.
    // Invalid policy/permission/isolation failures remain fail-closed and are never retried.
    const node = transportOwner["spec"].nodes.find((n) => n.id === nodeId);
    const retry = node?.retry ?? transportOwner["spec"].defaults?.retry ?? transportOwner["deps"].defaultRetry;
    const autoRetrySafe = node?.effect !== 'external-mutation';
    if (allowRetry
        && autoRetrySafe
        && retry
        && st.attempt <= retry.limit
        && retryMatches(retry.when, failureClass)) {
        st.lastFailure = `Previous attempt failed: ${reason} (${failureClass}). Address the cause before retrying with a different approach.`;
        st.state = 'pending';
        const sid = sessionId ?? st.sessionId;
        if (sid) {
            transportOwner["sessionToNode"].delete(sid);
            transportOwner["bestEffortHostMetadata"]('return retrying worker column to todo', sid, () => (transportOwner["deps"].host.setKanbanColumn(sid, 'todo')));
        }
        const delayMs = retryDelayMs(retry.backoff, st.attempt);
        if (delayMs > 0) {
            st.retryAtMs = transportOwner["currentTimeMs"]() + delayMs;
            transportOwner["log"]({
                kind: 'node-retry',
                nodeId,
                attempt: st.attempt,
                reason,
                delayMs,
                retryAt: new Date(st.retryAtMs).toISOString(),
            });
            transportOwner["armRetry"](nodeId, st.retryAtMs);
        }
        else {
            transportOwner["log"]({ kind: 'node-retry', nodeId, attempt: st.attempt, reason, delayMs: 0 });
            transportOwner["scheduleReady"]();
        }
        return;
    }
    st.state = 'failed';
    const sid = sessionId ?? st.sessionId;
    if (sid)
        transportOwner["sessionToNode"].delete(sid);
    transportOwner["log"]({ kind: 'node-finished', nodeId, sessionId: sid ?? '', state: 'failed', reason });
    if (sid) {
        transportOwner["bestEffortHostMetadata"]('mark failed worker session needs-review', sid, () => (transportOwner["deps"].host.setSessionStatus(sid, FAILED_STATUS)));
    }
    transportOwner["scheduleReady"]();
}

export function maybeFinish(transportOwner: ActiveRun): void {
    if (transportOwner["runStatus"] !== 'running')
        return;
    if (transportOwner["inFlight"] > 0)
        return;
    if (transportOwner["timeoutRetirements"].size > 0)
        return;
    if (transportOwner["spec"].nodes.some((n) => transportOwner["isReady"](n)))
        return; // more to dispatch
    if (transportOwner["hasDeferredRetry"]())
        return;
    const allGood = transportOwner["spec"].nodes.every((n) => {
        const s = transportOwner["state"].get(n.id)!.state;
        return s === 'done' || s === 'skipped';
    });
    if (!allGood) {
        transportOwner["finish"]('failed');
        return;
    }
    // All nodes succeeded. Gate the terminal status on the orchestrator's verdict when there is one
    // to ask; with no orchestrator there is nothing to verify against, so complete directly.
    if (transportOwner["opts"].verifyOnComplete && transportOwner["opts"].orchestratorSessionId) {
        transportOwner["enterVerifying"]();
    }
    else {
        transportOwner["finish"]('completed');
    }
}

/** Enter the non-terminal `verifying` state and launch one independent reviewer. */
export function enterVerifying(transportOwner: ActiveRun): void {
    transportOwner["runStatus"] = 'verifying';
    transportOwner["log"]({ kind: 'run-verifying' });
    const generation = ++transportOwner["verificationGeneration"];
    void transportOwner["sendVerification"](generation).catch((error: unknown) => {
        transportOwner["failForUnexpectedAsyncError"]('reviewer verification dispatch', error);
    });
}

export function finish(transportOwner: ActiveRun, status: RunStatus): void {
    if (transportOwner["reviewerPending"] || transportOwner["reviewerSessionId"] || transportOwner["pendingReviewerSessionIds"].size > 0) {
        const reason = 'terminal publication was blocked because a reviewer retirement is still pending';
        if (transportOwner["terminalIntent"])
            throw new Error(reason);
        transportOwner["setTerminalIntent"]({ target: 'failed', cause: 'reviewer', reason });
        transportOwner["markRunningNodesCancelled"](reason);
        transportOwner["beginTerminalDrain"]();
        return;
    }
    transportOwner["runStatus"] = status;
    transportOwner["log"]({ kind: status === 'completed' ? 'run-completed' : 'run-failed' });
    // Settle the task tile: completed → done, failed → needs-review (the fixed status set has no
    // 'failed'). The in-progress column was set at start().
    const orchestrator = transportOwner["opts"].orchestratorSessionId;
    if (orchestrator) {
        if (status === 'completed') {
            transportOwner["bestEffortHostMetadata"]('mark completed orchestrator column done', orchestrator, () => (transportOwner["deps"].host.setKanbanColumn(orchestrator, 'done')));
            transportOwner["bestEffortHostMetadata"]('mark completed orchestrator session done', orchestrator, () => (transportOwner["deps"].host.setSessionStatus(orchestrator, DONE_STATUS)));
        }
        else {
            transportOwner["bestEffortHostMetadata"]('mark failed orchestrator session needs-review', orchestrator, () => (transportOwner["deps"].host.setSessionStatus(orchestrator, FAILED_STATUS)));
        }
    }
    transportOwner["finalize"]();
}

export function finalize(transportOwner: ActiveRun): void {
    for (const timeout of transportOwner["nodeTimeouts"].values())
        clearTimeout(timeout);
    transportOwner["nodeTimeouts"].clear();
    for (const timeout of transportOwner["retryTimeouts"].values())
        clearTimeout(timeout);
    transportOwner["retryTimeouts"].clear();
    if (transportOwner["deadlineTimeout"])
        clearTimeout(transportOwner["deadlineTimeout"]);
    transportOwner["deadlineTimeout"] = undefined;
    if (transportOwner["pauseRetryTimeout"])
        clearTimeout(transportOwner["pauseRetryTimeout"]);
    transportOwner["pauseRetryTimeout"] = undefined;
    if (transportOwner["terminalRetryTimeout"])
        clearTimeout(transportOwner["terminalRetryTimeout"]);
    transportOwner["terminalRetryTimeout"] = undefined;
    transportOwner["verificationGeneration"] += 1;
    transportOwner["clearReviewerTimeout"]();
    transportOwner["unsubscribe"]?.();
    transportOwner["unsubscribe"] = undefined;
    transportOwner["verdictOff"]?.();
    transportOwner["verdictOff"] = undefined;
    if (transportOwner["settled"])
        return;
    transportOwner["settled"] = true;
    const snap = transportOwner["snapshot"]();
    for (const resolve of transportOwner["settleResolvers"])
        resolve(snap);
    transportOwner["settleResolvers"] = [];
}
