import { omitUndefined } from '@craft-agent/shared/utils/json';
import { type TaskNode, type NodeOutput, nodeTitle, writeNodeOutput } from "@craft-agent/shared/tasks";
import type { PendingTaskApproval } from "../shared.ts";
import type { ActiveRun } from '../active-run.ts';

// --- scheduling ---
export function scheduleReady(transportOwner: ActiveRun): void {
    if (transportOwner["runStatus"] !== 'running' || transportOwner["terminalIntent"] || transportOwner["terminalDrain"])
        return;
    if (transportOwner["deadlineExpired"]()) {
        transportOwner["failForDeadline"]();
        return;
    }
    const killSwitch = transportOwner["currentKillSwitch"]();
    if (!killSwitch.allowed) {
        transportOwner["stopForKillSwitch"](killSwitch.reason ?? 'Execution stopped by kill switch');
        return;
    }
    for (const node of transportOwner["spec"].nodes) {
        if (transportOwner["inFlight"] >= transportOwner.maxParallel)
            break;
        if (!transportOwner["isReady"](node))
            continue;
        const budget = transportOwner.schedulingBudgetBreach();
        if (budget) {
            transportOwner.failForBudget(budget.metric, budget.value, budget.limit);
            return;
        }
        if (transportOwner.requiresApproval(node) && !transportOwner.approvedNodes.has(node.id)) {
            transportOwner.requestApproval(node);
            return;
        }
        if (node.kind === 'approval') {
            transportOwner.completeApprovalNode(node);
            continue;
        }
        transportOwner.markRunning(node);
        void transportOwner.dispatch(node).catch((error: unknown) => {
            transportOwner["failForUnexpectedAsyncError"](`dispatch ${node.id}`, error);
        });
    }
    transportOwner.maybeFinish();
}

export function isReady(transportOwner: ActiveRun, node: TaskNode): boolean {
    const st = transportOwner["state"].get(node.id)!;
    if (st.state !== 'pending')
        return false;
    if (st.retryAtMs !== undefined) {
        if (st.retryAtMs > transportOwner["currentTimeMs"]()) {
            transportOwner["armRetry"](node.id, st.retryAtMs);
            return false;
        }
        delete st.retryAtMs;
        transportOwner.clearRetryTimeout(node.id);
    }
    for (const dep of transportOwner.edges.get(node.id) ?? []) {
        if (transportOwner["state"].get(dep)?.state !== 'done')
            return false;
    }
    return true;
}

export function markRunning(transportOwner: ActiveRun, node: TaskNode): void {
    const st = transportOwner["state"].get(node.id)!;
    st.state = 'running';
    delete st.retryAtMs;
    transportOwner.clearRetryTimeout(node.id);
    st.attempt += 1;
    transportOwner["inFlight"] += 1;
    transportOwner["log"]({ kind: 'node-scheduled', nodeId: node.id });
    transportOwner["log"]({
        kind: 'node-checkpoint',
        nodeId: node.id,
        idempotencyKey: transportOwner["idempotencyKey"](node.id),
        status: 'prepared',
    });
}

export function requiresApproval(_transportOwner: ActiveRun, node: TaskNode): boolean {
    return node.kind === 'approval' || node.approval === true;
}

export function requestApproval(transportOwner: ActiveRun, node: TaskNode): void {
    const requestId = `${transportOwner["runId"]}:${node.id}:approval-${transportOwner["state"].get(node.id)!.attempt + 1}`;
    if (transportOwner.pendingApprovals.has(requestId))
        return;
    const impact = transportOwner["spec"].mission?.policy.impact_level ?? (node.effect === 'external-mutation' ? 'high' : 'medium');
    const request: PendingTaskApproval = omitUndefined<PendingTaskApproval>({
        requestId,
        slug: transportOwner["slug"],
        missionId: transportOwner["spec"].id,
        runId: transportOwner["runId"],
        nodeId: node.id,
        reason: node.prompt?.trim() || `Approve mission step "${nodeTitle(node)}"`,
        impact,
        ...((transportOwner["spec"].mission?.policy.validator ?? transportOwner["spec"].mission?.policy.owner)
            ? { owner: transportOwner["spec"].mission?.policy.validator ?? transportOwner["spec"].mission?.policy.owner }
            : {}),
    });
    transportOwner["state"].get(node.id)!.state = 'waiting-approval';
    transportOwner.pendingApprovals.set(requestId, request);
    transportOwner["runStatus"] = 'waiting-approval';
    transportOwner["log"]({
        kind: 'approval-requested',
        requestId,
        nodeId: node.id,
        reason: request.reason,
        impact,
        ...(request.owner ? { owner: request.owner } : {}),
    });
}

export function completeApprovalNode(transportOwner: ActiveRun, node: TaskNode): void {
    const st = transportOwner["state"].get(node.id)!;
    st.state = 'done';
    st.attempt += 1;
    const output: NodeOutput = { text: `Approved mission gate: ${nodeTitle(node)}` };
    transportOwner["outputs"][node.id] = output;
    writeNodeOutput(transportOwner["deps"].workspaceRoot, transportOwner["slug"], transportOwner["runId"], node.id, output);
    transportOwner["log"]({ kind: 'node-finished', nodeId: node.id, sessionId: '', state: 'done' });
}

export function pendingApprovalList(transportOwner: ActiveRun): PendingTaskApproval[] {
    return [...transportOwner.pendingApprovals.values()];
}

export function resolveApproval(transportOwner: ActiveRun, requestId: string, decision: 'approved' | 'rejected', actor: string, comment?: string): void {
    const request = transportOwner.pendingApprovals.get(requestId);
    if (!request)
        throw new Error(`Approval request "${requestId}" is not pending`);
    const node = transportOwner["spec"].nodes.find((candidate) => candidate.id === request.nodeId);
    if (!node)
        throw new Error(`Approval node "${request.nodeId}" no longer exists`);
    transportOwner.pendingApprovals.delete(requestId);
    transportOwner["log"]({
        kind: 'approval-resolved',
        requestId,
        nodeId: node.id,
        decision,
        actor,
        ...(comment ? { comment } : {}),
    });
    const st = transportOwner["state"].get(node.id)!;
    if (decision === 'rejected') {
        st.state = 'failed';
        st.lastFailure = comment || 'High-impact action rejected by validator.';
        transportOwner["log"]({ kind: 'node-finished', nodeId: node.id, sessionId: '', state: 'failed', reason: st.lastFailure });
    }
    else {
        transportOwner.approvedNodes.add(node.id);
        st.state = 'pending';
    }
    if (transportOwner.pendingApprovals.size > 0)
        return;
    transportOwner["runStatus"] = 'running';
    transportOwner["scheduleReady"]();
}
