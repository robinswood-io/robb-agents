import { writeNodeOutput, readNodeOutput, writeRunContextSnapshot, writeRunSpecSnapshot } from "@craft-agent/shared/tasks";
import { RUNNING_STATUS } from "../shared.ts";
import type { RunSnapshot } from "../shared.ts";
import type { ActiveRun } from '../active-run.ts';

// --- lifecycle ---
export function start(transportOwner: ActiveRun): void {
    // The immutable run snapshot is part of the durability contract. Starting
    // without it would make recovery depend on a later-edited task.yaml.
    writeRunSpecSnapshot(transportOwner["deps"].workspaceRoot, transportOwner["slug"], transportOwner["runId"], transportOwner["spec"]);
    writeRunContextSnapshot(transportOwner["deps"].workspaceRoot, transportOwner["slug"], transportOwner["runId"], {
        params: transportOwner["opts"].params ?? {},
        verifyOnComplete: transportOwner["opts"].verifyOnComplete,
    });
    transportOwner["unsubscribe"] = transportOwner["deps"].host.onSessionComplete((evt) => transportOwner["onSessionComplete"](evt));
    transportOwner["log"]({ kind: 'run-started', taskId: transportOwner["spec"].id, runId: transportOwner["runId"], orchestratorSessionId: transportOwner["opts"].orchestratorSessionId });
    if (transportOwner["opts"].replay) {
        transportOwner["log"]({
            kind: 'run-replayed',
            sourceRunId: transportOwner["opts"].replay.sourceRunId,
            externalMutationsApproved: transportOwner["opts"].replay.externalMutationsApproved,
        });
        for (const reused of transportOwner["opts"].replay.reusedNodes) {
            const output = readNodeOutput(transportOwner["deps"].workspaceRoot, transportOwner["slug"], transportOwner["opts"].replay.sourceRunId, reused.nodeId);
            const state = transportOwner["state"].get(reused.nodeId);
            if (!output || !state)
                continue;
            state.state = 'done';
            transportOwner["outputs"][reused.nodeId] = output;
            writeNodeOutput(transportOwner["deps"].workspaceRoot, transportOwner["slug"], transportOwner["runId"], reused.nodeId, output);
            transportOwner["log"]({
                kind: 'node-reused',
                nodeId: reused.nodeId,
                sourceRunId: transportOwner["opts"].replay.sourceRunId,
                proofHash: reused.proofHash,
            });
        }
    }
    transportOwner["runStatus"] = 'running';
    // Move the task tile to the in-progress column for the duration of the run.
    if (transportOwner["opts"].orchestratorSessionId) {
        transportOwner["bestEffortHostMetadata"]('mark orchestrator column in-progress', transportOwner["opts"].orchestratorSessionId, () => (transportOwner["deps"].host.setKanbanColumn(transportOwner["opts"].orchestratorSessionId!, 'in-progress')));
        transportOwner["bestEffortHostMetadata"]('mark orchestrator session in-progress', transportOwner["opts"].orchestratorSessionId, () => (transportOwner["deps"].host.setSessionStatus(transportOwner["opts"].orchestratorSessionId!, RUNNING_STATUS)));
        // Publish the full node count up front so the board's subtask progress denominator is stable,
        // rather than growing as children are spawned lazily at dispatch.
        transportOwner["bestEffortHostMetadata"]('publish orchestrator task-node count', transportOwner["opts"].orchestratorSessionId, () => (transportOwner["deps"].host.setTaskNodeCount(transportOwner["opts"].orchestratorSessionId!, transportOwner["spec"].nodes.length)));
    }
    if (transportOwner["deadlineExpired"]()) {
        transportOwner["failForDeadline"]();
        return;
    }
    transportOwner["armDeadline"]();
    transportOwner["scheduleReady"]();
}

export function pause(transportOwner: ActiveRun): void {
    if (transportOwner["runStatus"] !== 'running')
        return;
    transportOwner["runStatus"] = 'paused';
    transportOwner["resumeRequested"] = false;
    transportOwner["log"]({ kind: 'run-paused' });
    for (const [nodeId, st] of transportOwner["state"]) {
        if (st.state !== 'running')
            continue;
        transportOwner["clearNodeTimeout"](nodeId);
        const node = transportOwner["spec"].nodes.find((candidate) => candidate.id === nodeId);
        const replayWouldBeAmbiguous = node?.effect !== 'read';
        st.state = replayWouldBeAmbiguous ? 'failed' : 'cancelled';
        st.lastFailure = replayWouldBeAmbiguous
            ? 'Mutation interrupted by pause; reconcile durable state before an explicit replay.'
            : 'Interrupted by mission pause.';
        transportOwner["log"]({
            kind: 'node-finished',
            nodeId,
            sessionId: st.sessionId ?? '',
            state: st.state,
            reason: st.lastFailure,
        });
    }
    transportOwner["inFlight"] = 0;
    transportOwner["pausedSessionIds"] = transportOwner["terminalSessionIds"]();
    transportOwner["pauseDrainRequired"] = transportOwner["pausedSessionIds"].length > 0 || transportOwner["activeCreations"].size > 0;
    if (transportOwner["pauseDrainRequired"]) {
        transportOwner["log"]({ kind: 'run-pause-draining', sessionIds: [...transportOwner["pausedSessionIds"]] });
    }
    transportOwner["beginPauseDrain"]();
}

export function resume(transportOwner: ActiveRun): void {
    if (transportOwner["runStatus"] !== 'paused')
        return;
    transportOwner["resumeRequested"] = true;
    if (transportOwner["pauseDrain"] || transportOwner["pausedSessionIds"].length > 0) {
        const drain = transportOwner["beginPauseDrain"]();
        void drain.then(() => transportOwner["resumeAfterPauseDrain"](), () => { }).catch((error) => {
            transportOwner["failForUnexpectedAsyncError"]('resume after pause drain', error);
        });
        return;
    }
    transportOwner["resumeAfterPauseDrain"]();
}

export function resumeAfterPauseDrain(transportOwner: ActiveRun): void {
    if (transportOwner["runStatus"] !== 'paused' || !transportOwner["resumeRequested"])
        return;
    transportOwner["resumeRequested"] = false;
    // Cancelled nodes return to pending so they re-dispatch. Nodes that exhausted their `retry`
    // budget stay 'failed' — automatic retry happens in failNode within the run, not on resume.
    for (const [, st] of transportOwner["state"])
        if (st.state === 'cancelled')
            st.state = 'pending';
    transportOwner["runStatus"] = 'running';
    transportOwner["log"]({ kind: 'run-resumed' });
    if (transportOwner["deadlineExpired"]()) {
        transportOwner["failForDeadline"]();
        return;
    }
    transportOwner["armDeadline"]();
    transportOwner["scheduleReady"]();
}

export async function stop(transportOwner: ActiveRun): Promise<void> {
    if (transportOwner["settled"] || (transportOwner["isTerminal"]() && transportOwner["runStatus"] !== 'stopped'))
        return;
    if (transportOwner["reviewerFailure"]) {
        try {
            await transportOwner["reviewerFailure"];
        }
        catch { /* durable terminal intent is retried below */ }
        if (transportOwner["settled"])
            return;
    }
    if (transportOwner["pauseDrain"]) {
        try {
            await transportOwner["pauseDrain"];
        }
        catch { /* terminal drain retries below */ }
        if (transportOwner["settled"])
            return;
    }
    if (transportOwner["hydrationWorkerDrain"]) {
        try {
            await transportOwner["hydrationWorkerDrain"];
        }
        catch { /* terminal drain retries below */ }
        if (transportOwner["settled"])
            return;
    }
    if (transportOwner["terminalDrain"]) {
        try {
            await transportOwner["terminalDrain"];
        }
        catch {
            // The explicit stop below retries every durable identity.
        }
        if (transportOwner["settled"])
            return;
    }
    // A failed durable drain is retried with its original terminal target and
    // cause. An operator Stop must not rewrite a budget/deadline/timeout
    // failure into a benign stopped result.
    if (transportOwner["terminalIntent"]) {
        await transportOwner["beginTerminalDrain"]();
        return;
    }
    transportOwner["setTerminalIntent"]({ target: 'stopped', cause: 'operator', reason: 'stopped' });
    transportOwner["markRunningNodesCancelled"]('stopped');
    await transportOwner["beginTerminalDrain"]();
}

export function waitUntilSettled(transportOwner: ActiveRun): Promise<RunSnapshot> {
    if (transportOwner["settled"])
        return Promise.resolve(transportOwner["snapshot"]());
    return new Promise((resolve) => transportOwner["settleResolvers"].push(resolve));
}

export function snapshot(transportOwner: ActiveRun): RunSnapshot {
    return {
        slug: transportOwner["slug"],
        runId: transportOwner["runId"],
        taskId: transportOwner["spec"].id,
        status: transportOwner["runStatus"],
        orchestratorSessionId: transportOwner["opts"].orchestratorSessionId,
        tokensUsed: transportOwner["tokensUsed"],
        costUsed: transportOwner["costUsed"],
        nodes: transportOwner["spec"].nodes.map((n) => {
            const st = transportOwner["state"].get(n.id)!;
            return { id: n.id, state: st.state, sessionId: st.sessionId, attempt: st.attempt };
        }),
    };
}

/** Apply a newly published kill switch immediately to this active run. */
export function enforceKillSwitch(transportOwner: ActiveRun): boolean {
    if (transportOwner["isTerminal"]() || transportOwner["terminalIntent"])
        return false;
    const decision = transportOwner["currentKillSwitch"]();
    if (decision.allowed)
        return false;
    transportOwner["stopForKillSwitch"](decision.reason ?? 'Execution stopped by kill switch');
    return true;
}
