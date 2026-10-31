import { setOptional } from '@craft-agent/shared/utils/json';
import { type NodeOutput, type RunLogEntry } from "@craft-agent/shared/tasks";
import type { RunStatus, PendingTaskApproval } from "../shared.ts";
import type { ActiveRun } from '../active-run.ts';

/**
     * Rebuild run state from a persisted run-log (cross-restart resume). Done nodes reuse their
     * recorded output and are NOT re-run; in-flight/cancelled nodes fall back to pending so they
     * re-dispatch. A done node whose output file is missing also falls back to pending.
     */
export function hydrate(transportOwner: ActiveRun, log: RunLogEntry[], loadOutput: (nodeId: string) => NodeOutput | null): void {
    const ambiguousNodes = new Set<string>();
    const verifiedMutationNodes = new Set<string>();
    const unresolvedApprovals = new Map<string, PendingTaskApproval>();
    let persistedStatus: RunStatus = 'running';
    for (const e of log) {
        if (e.kind === 'node-spawned') {
            const st = transportOwner["state"].get(e.nodeId);
            if (st) {
                st.sessionId = e.sessionId;
                transportOwner["sessionToNode"].set(e.sessionId, e.nodeId);
            }
        }
        else if (e.kind === 'node-routed') {
            const st = transportOwner["state"].get(e.nodeId);
            if (st) {
                st.lastRoute = {
                    ...(e.connectionSlug ? { llmConnection: e.connectionSlug } : {}),
                    ...(e.model ? { model: e.model } : {}),
                    ...(e.thinkingLevel ? { thinkingLevel: e.thinkingLevel } : {}),
                    ...(e.connectionRoutePinned ? { connectionRoutePinned: true } : {}),
                    ...(e.modelRoutePinned ? { modelRoutePinned: true } : {}),
                    ...(e.thinkingLevelPinned ? { thinkingLevelPinned: true } : {}),
                };
            }
        }
        else if (e.kind === 'node-scheduled') {
            const st = transportOwner["state"].get(e.nodeId);
            if (st) {
                st.attempt += 1;
                st.state = 'running';
                delete st.retryAtMs;
            }
        }
        else if (e.kind === 'node-finished') {
            const st = transportOwner["state"].get(e.nodeId);
            if (st)
                st.state = e.state;
        }
        else if (e.kind === 'node-retry') {
            const st = transportOwner["state"].get(e.nodeId);
            if (st) {
                st.state = 'pending';
                st.lastFailure = `Previous attempt failed: ${e.reason}. Address the cause before retrying.`;
                setOptional(st, "retryAtMs", e.retryAt ? Date.parse(e.retryAt) : undefined);
            }
        }
        else if (e.kind === 'node-checkpoint') {
            if (e.status === 'executing')
                ambiguousNodes.add(e.nodeId);
            else if (e.status === 'confirmed') {
                const checkpointNode = transportOwner["spec"].nodes.find((node) => node.id === e.nodeId);
                if (checkpointNode?.effect === 'external-mutation') {
                    const decision = e.executionProof && transportOwner["deps"].verifyExecutionProof
                        ? transportOwner["deps"].verifyExecutionProof(e.executionProof, {
                            workspaceId: transportOwner["deps"].workspaceId,
                            missionId: transportOwner["spec"].id,
                            nodeId: e.nodeId,
                            idempotencyKey: e.idempotencyKey,
                        })
                        : undefined;
                    if (decision?.allowed) {
                        verifiedMutationNodes.add(e.nodeId);
                        ambiguousNodes.delete(e.nodeId);
                        const state = transportOwner["state"].get(e.nodeId);
                        if (state)
                            state.state = 'done';
                    }
                    else {
                        ambiguousNodes.add(e.nodeId);
                    }
                }
                else {
                    ambiguousNodes.delete(e.nodeId);
                    const state = transportOwner["state"].get(e.nodeId);
                    if (state)
                        state.state = 'done';
                }
            }
        }
        else if (e.kind === 'approval-requested') {
            unresolvedApprovals.set(e.requestId, {
                requestId: e.requestId,
                slug: transportOwner["slug"],
                missionId: transportOwner["spec"].id,
                runId: transportOwner["runId"],
                nodeId: e.nodeId,
                reason: e.reason,
                impact: e.impact,
                ...(e.owner !== undefined ? { owner: e.owner } : {}),
            });
        }
        else if (e.kind === 'approval-resolved') {
            unresolvedApprovals.delete(e.requestId);
            const state = transportOwner["state"].get(e.nodeId);
            if (e.decision === 'approved') {
                transportOwner.approvedNodes.add(e.nodeId);
                if (state?.state === 'waiting-approval')
                    state.state = 'pending';
            }
            else if (state) {
                state.state = 'failed';
                state.lastFailure = e.comment || 'High-impact action rejected by validator.';
            }
        }
        else if (e.kind === 'verdict') {
            // Reconstruct the durable repair counters so a cross-restart resume honors the cap rather
            // than restarting the budget from zero (the in-memory counters reset on a fresh process).
            if (e.result === 'fail') {
                transportOwner.repairsUsed += 1;
                if (e.outputFingerprint) {
                    transportOwner.rejectedFingerprints.add(e.outputFingerprint);
                    transportOwner.stagnantRepeats = e.stagnantRepeats ?? transportOwner.stagnantRepeats;
                    transportOwner.reflectionHistory.push({
                        iteration: transportOwner.repairsUsed,
                        reason: e.reason ?? 'The verifier rejected the previous result.',
                        frontier: e.frontier ?? e.nodes ?? transportOwner["spec"].nodes.map((node) => node.id),
                        outputFingerprint: e.outputFingerprint,
                    });
                }
            }
            else if (e.result === 'unparsed')
                transportOwner.unparsedReAsks += 1;
            else if (e.result === 'pass')
                transportOwner.unparsedReAsks = 0;
        }
        else if (e.kind === 'usage-updated') {
            transportOwner["tokensUsed"] = e.tokensUsed;
            transportOwner["costUsed"] = e.costUsed ?? transportOwner["costUsed"];
            if (e.sourceSessionId) {
                if (Number.isFinite(e.cumulativeTokens) && e.cumulativeTokens! >= 0) {
                    transportOwner.sessionTokens.set(e.sourceSessionId, Math.max(transportOwner.sessionTokens.get(e.sourceSessionId) ?? 0, e.cumulativeTokens!));
                }
                if (Number.isFinite(e.cumulativeCostUsd) && e.cumulativeCostUsd! >= 0) {
                    transportOwner.sessionCosts.set(e.sourceSessionId, Math.max(transportOwner.sessionCosts.get(e.sourceSessionId) ?? 0, e.cumulativeCostUsd!));
                }
            }
        }
        else if (e.kind === 'run-paused') {
            persistedStatus = 'paused';
        }
        else if (e.kind === 'run-pause-draining') {
            persistedStatus = 'paused';
            transportOwner["pauseDrainRequired"] = true;
            transportOwner["pausedSessionIds"] = [...new Set(e.sessionIds)];
        }
        else if (e.kind === 'run-pause-drained') {
            transportOwner["pauseDrainRequired"] = false;
            transportOwner["pausedSessionIds"] = [];
        }
        else if (e.kind === 'run-draining') {
            transportOwner["terminalIntent"] = {
                target: e.target,
                cause: e.cause,
                sessionIds: [...e.sessionIds],
                reviewerSessionIds: [...(e.reviewerSessionIds ?? [])],
                ...(e.reason ? { reason: e.reason } : {}),
                ...(e.scope ? { scope: e.scope } : {}),
            };
            for (const sessionId of e.reviewerSessionIds ?? []) {
                transportOwner["pendingReviewerSessionIds"].add(sessionId);
            }
        }
        else if (e.kind === 'run-resumed' || e.kind === 'run-started') {
            persistedStatus = 'running';
        }
        else if (e.kind === 'run-verifying') {
            persistedStatus = 'verifying';
        }
        else if (e.kind === 'run-completed') {
            persistedStatus = 'completed';
        }
        else if (e.kind === 'run-failed') {
            persistedStatus = 'failed';
        }
        else if (e.kind === 'run-stopped' || e.kind === 'kill-switch') {
            persistedStatus = 'stopped';
        }
    }
    for (const [nodeId, st] of transportOwner["state"]) {
        if (st.state === 'done') {
            const node = transportOwner["spec"].nodes.find((candidate) => candidate.id === nodeId);
            if (node?.effect === 'external-mutation' && !verifiedMutationNodes.has(nodeId)) {
                st.state = 'failed';
                st.lastFailure = 'External mutation lacks a valid provider-reconciled execution proof.';
            }
            else {
                const out = loadOutput(nodeId);
                if (out)
                    transportOwner["outputs"][nodeId] = out;
                else if (node?.effect === 'read')
                    st.state = 'pending';
                else {
                    st.state = 'failed';
                    st.lastFailure = 'Confirmed mutation output is missing; reconcile durable state before replay.';
                }
            }
        }
        else if (st.state === 'running' || st.state === 'cancelled') {
            const node = transportOwner["spec"].nodes.find((candidate) => candidate.id === nodeId);
            if (node?.effect !== 'read' && ambiguousNodes.has(nodeId)) {
                // A child may have completed an external side effect before the
                // process stopped. Replaying it blindly could duplicate a mutation.
                st.state = 'failed';
                st.lastFailure = 'Interrupted after execution began; inspect provider state and approve a replay.';
            }
            else {
                st.state = 'pending';
            }
        }
    }
    for (const approval of unresolvedApprovals.values()) {
        const st = transportOwner["state"].get(approval.nodeId);
        if (!st || st.state === 'done' || st.state === 'failed')
            continue;
        st.state = 'waiting-approval';
        transportOwner.pendingApprovals.set(approval.requestId, approval);
    }
    // Preserve the exact reviewer across every crash window, including after
    // its bounded output changed from pending but before run-completed was
    // appended. Recovery must retire/reconcile that child before creating a
    // fresh reviewer.
    const persistedReviewer = loadOutput('__verdict__');
    const reviewerParams = persistedReviewer?.params;
    const persistedReviewerSessionIds = Array.isArray(reviewerParams?.["reviewerSessionIds"])
        ? reviewerParams["reviewerSessionIds"].filter((value: unknown): value is string => typeof value === 'string')
        : [];
    if (persistedStatus === 'verifying' || transportOwner["terminalIntent"]) {
        for (const sessionId of persistedReviewerSessionIds) {
            transportOwner["pendingReviewerSessionIds"].add(sessionId);
        }
    }
    if (persistedStatus === 'verifying'
        && (typeof reviewerParams?.["reviewerSessionId"] === 'string'
            || persistedReviewerSessionIds.length > 0)) {
        transportOwner["reviewerSessionId"] = typeof reviewerParams?.["reviewerSessionId"] === 'string'
            ? reviewerParams["reviewerSessionId"]
            : persistedReviewerSessionIds[0];
        if (transportOwner["reviewerSessionId"])
            transportOwner["pendingReviewerSessionIds"].add(transportOwner["reviewerSessionId"]);
        transportOwner["reviewerPending"] = true;
        transportOwner.recoveredReviewerResultReusable = reviewerParams?.["reviewerState"] !== 'invalid';
    }
    transportOwner["runStatus"] = transportOwner.pendingApprovals.size > 0 ? 'waiting-approval' : persistedStatus;
    if (persistedStatus === 'paused' && !transportOwner["pauseDrainRequired"]) {
        // A crash may occur after run-paused/node-finished but before the strong
        // pause intent was appended. Legacy logs have no explicit drain marker,
        // so reconstruct exact durable identities conservatively.
        transportOwner["pausedSessionIds"] = [...new Set([...transportOwner["state"].values()]
                .filter((state) => state.state !== 'done' && state.state !== 'skipped')
                .flatMap((state) => state.sessionId ? [state.sessionId] : []))];
        transportOwner["pauseDrainRequired"] = transportOwner["pausedSessionIds"].length > 0;
    }
    transportOwner["inFlight"] = 0;
}

/**
     * Activate a hydrated run. Paused runs can be registered without scheduling,
     * while previously-running/verifying runs resume after process restart.
     */
export function activateHydrated(transportOwner: ActiveRun, shouldResume: boolean): void {
    if (transportOwner["unsubscribe"])
        return;
    transportOwner["unsubscribe"] = transportOwner["deps"].host.onSessionComplete((evt) => transportOwner["onSessionComplete"](evt));
    if (transportOwner.pendingApprovals.size > 0) {
        transportOwner["runStatus"] = 'waiting-approval';
    }
    if (transportOwner["terminalIntent"]) {
        transportOwner["markRunningNodesCancelled"](transportOwner["terminalIntent"].reason ?? 'terminal retirement resumed');
        transportOwner["beginTerminalDrain"]();
        return;
    }
    const killSwitch = transportOwner["currentKillSwitch"]();
    if (!killSwitch.allowed) {
        transportOwner["stopForKillSwitch"](killSwitch.reason ?? 'Execution stopped by kill switch');
        return;
    }
    if (transportOwner.pendingApprovals.size > 0)
        return;
    if (transportOwner["runStatus"] === 'paused') {
        const discoveredWorkers = transportOwner["deps"].host.listTaskWorkerSessions(transportOwner["deps"].workspaceId, transportOwner["slug"], transportOwner["runId"]).map((session) => session.id);
        const merged = [...new Set([...transportOwner["pausedSessionIds"], ...discoveredWorkers])];
        if (merged.length > 0) {
            transportOwner["pausedSessionIds"] = merged;
            transportOwner["pauseDrainRequired"] = true;
            transportOwner["log"]({ kind: 'run-pause-draining', sessionIds: merged });
        }
    }
    if (transportOwner["runStatus"] === 'paused' && transportOwner["pauseDrainRequired"]) {
        transportOwner["resumeRequested"] = shouldResume;
        const drain = transportOwner["beginPauseDrain"]();
        if (shouldResume) {
            void drain.then(() => transportOwner["resumeAfterPauseDrain"](), () => { }).catch((error: unknown) => {
                transportOwner["failForUnexpectedAsyncError"]('resume hydrated pause drain', error);
            });
        }
        return;
    }
    if (!shouldResume)
        return;
    const recoveredWorkers = transportOwner["deps"].host.listTaskWorkerSessions(transportOwner["deps"].workspaceId, transportOwner["slug"], transportOwner["runId"]).map((session) => session.id);
    if (recoveredWorkers.length > 0) {
        const drain = transportOwner.resumeAfterRecoveredWorkerDrain(recoveredWorkers);
        transportOwner["hydrationWorkerDrain"] = drain;
        void drain.then(() => {
            if (transportOwner["hydrationWorkerDrain"] === drain)
                transportOwner["hydrationWorkerDrain"] = undefined;
        }, () => {
            if (transportOwner["hydrationWorkerDrain"] === drain)
                transportOwner["hydrationWorkerDrain"] = undefined;
        }).catch((error: unknown) => {
            transportOwner["failForUnexpectedAsyncError"]('hydrate recovered worker drain bookkeeping', error);
        });
        return;
    }
    transportOwner.continueHydratedResume();
}

export async function resumeAfterRecoveredWorkerDrain(transportOwner: ActiveRun, sessionIds: string[]): Promise<void> {
    const errors = await transportOwner.retireWorkerSessions(sessionIds);
    if (errors.length > 0) {
        const reason = `recovered worker retirement failed: ${errors.map((error) => error.message).join('; ')}`;
        transportOwner["setTerminalIntent"]({ target: 'failed', cause: 'recovery', reason });
        transportOwner["markRunningNodesCancelled"](reason);
        transportOwner["beginTerminalDrain"]();
        return;
    }
    transportOwner.continueHydratedResume();
}

export function continueHydratedResume(transportOwner: ActiveRun): void {
    if (transportOwner["settled"] || transportOwner["terminalIntent"] || transportOwner["isTerminal"]())
        return;
    if (transportOwner["deadlineExpired"]()) {
        transportOwner["failForDeadline"]();
        return;
    }
    transportOwner["armDeadline"]();
    if (transportOwner["runStatus"] === 'verifying') {
        transportOwner["log"]({ kind: 'run-resumed' });
        transportOwner["enterVerifying"]();
        return;
    }
    transportOwner["runStatus"] = 'running';
    transportOwner["log"]({ kind: 'run-resumed' });
    transportOwner["scheduleReady"]();
}
