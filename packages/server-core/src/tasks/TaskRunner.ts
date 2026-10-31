import { omitUndefined } from '@craft-agent/shared/utils/json';
import '@craft-agent/shared/utils';
import 'node:crypto';
import 'node:path';
import '@craft-agent/shared/governance';
import '../subagents/autonomy-inheritance.ts';
import './task-node-execution';
import '@craft-agent/shared/tasks';
import '../sessions/delegated-review-outcome.ts';
import { type TaskSpec, readNodeOutput, readRunLog, readRunContextSnapshot, readRunSpecSnapshot, loadTaskSpec, listRunIds, listTaskRunSlugs, listTaskSlugs, authorizeWorkspacePath, evaluateKillSwitch, validateExecutionIsolationPolicy, planMissionReplay, type KillSwitchSnapshot } from "@craft-agent/shared/tasks";
import { resolveIsolationPolicy, isTerminalRunStatus, persistedRunStatus, resolveParams } from './task-runner/shared.ts';
import type { TaskRunnerDeps, RunOptions, RunSnapshot, PendingTaskApproval } from './task-runner/shared.ts';
import { ActiveRun } from './task-runner/active-run.ts';
export type { ConductorSessionHost, TaskRunnerDeps, TaskFailureClass, TaskRetryPolicy, TaskExecutionGuardContext, RunOptions, RunStatus, NodeRunStatus, RunSnapshot, PendingTaskApproval } from './task-runner/shared.ts';
export { DEFAULT_AUTONOMOUS_RETRY_POLICY } from './task-runner/shared.ts';

export class TaskRunner {
    private readonly runs = new Map<string, ActiveRun>();
    constructor(private readonly deps: TaskRunnerDeps) { }
    private key(slug: string, runId: string): string {
        return `${slug}:${runId}`;
    }
    /** Load + validate a task's yaml and start a run. Throws if the task is missing or invalid. */
    run(slug: string, opts: RunOptions = {}): RunSnapshot {
        const loaded = loadTaskSpec(this.deps.workspaceRoot, slug);
        if (!loaded?.spec)
            throw new Error(`Task "${slug}" not found or has no valid task.yaml`);
        if (!loaded.valid) {
            throw new Error(`Refusing to run invalid task "${slug}": ${loaded.errors.map((e) => e.message).join('; ')}`);
        }
        this.assertSpecAdmissible(loaded.spec, slug);
        // One active run per orchestrator: a second concurrent run would race the same parent session's
        // verdict listener (two runs attaching onSessionComplete on the same orchestrator would cross
        // their verifications). Block it. NOTE: this does not guard against a human typing into the
        // orchestrator mid-`verifying` — that race is a known, bounded v1 limitation.
        const orchestrator = opts.orchestratorSessionId;
        if (orchestrator) {
            for (const existing of this.runs.values()) {
                const snap = existing.snapshot();
                if (snap.orchestratorSessionId === orchestrator && !isTerminalRunStatus(snap.status)) {
                    throw new Error(`Task "${slug}" already has an active run (${snap.runId}) on this orchestrator; stop it before starting another.`);
                }
            }
        }
        const runId = opts.runId ?? (this.deps.genRunId ? this.deps.genRunId() : `run-${Date.now()}`);
        if (listRunIds(this.deps.workspaceRoot, slug).includes(runId)) {
            throw new Error(`Run id "${slug}:${runId}" already exists`);
        }
        const run = new ActiveRun(loaded.spec, slug, runId, { ...opts, params: resolveParams(loaded.spec, opts.params), verifyOnComplete: opts.verifyOnComplete ?? true }, this.deps);
        this.runs.set(this.key(slug, runId), run);
        try {
            run.start();
        }
        catch (error) {
            this.runs.delete(this.key(slug, runId));
            throw error;
        }
        return run.snapshot();
    }
    /**
     * Start a new run that reuses confirmed outputs outside the requested repair
     * frontier. External mutations remain blocked unless the operator explicitly
     * approves them and every reused mutation carries a valid reconciled proof.
     */
    repair(slug: string, sourceRunId: string, nodeIds: string[], opts: Omit<RunOptions, 'replay'> & {
        approveExternalMutations?: boolean;
    } = {}): RunSnapshot {
        if (nodeIds.length === 0)
            throw new Error('Targeted repair requires at least one node id');
        const sourceLog = readRunLog(this.deps.workspaceRoot, slug, sourceRunId);
        if (sourceLog.length === 0)
            throw new Error(`Repair source run "${slug}:${sourceRunId}" was not found`);
        const sourceStatus = persistedRunStatus(sourceLog);
        if (!isTerminalRunStatus(sourceStatus)) {
            throw new Error(`Cannot repair non-terminal run "${slug}:${sourceRunId}" (${sourceStatus}); stop or settle it first`);
        }
        const sourceSpec = readRunSpecSnapshot(this.deps.workspaceRoot, slug, sourceRunId);
        if (!sourceSpec) {
            throw new Error(`Repair source spec for "${slug}:${sourceRunId}" is unavailable; refusing to repair against a mutable live spec`);
        }
        this.assertSpecAdmissible(sourceSpec, slug);
        const validIds = new Set(sourceSpec.nodes.map((node) => node.id));
        const unknown = nodeIds.filter((nodeId) => !validIds.has(nodeId));
        if (unknown.length > 0)
            throw new Error(`Unknown repair node(s): ${unknown.join(', ')}`);
        const dependents = new Map<string, Set<string>>(sourceSpec.nodes.map((node) => [node.id, new Set()]));
        for (const node of sourceSpec.nodes) {
            for (const dependency of node.depends_on ?? [])
                dependents.get(dependency)?.add(node.id);
        }
        const frontier = new Set<string>();
        const queue = [...nodeIds];
        while (queue.length > 0) {
            const nodeId = queue.shift()!;
            if (frontier.has(nodeId))
                continue;
            frontier.add(nodeId);
            for (const dependent of dependents.get(nodeId) ?? [])
                queue.push(dependent);
        }
        const { approveExternalMutations = false, ...runOptions } = opts;
        const orchestrator = runOptions.orchestratorSessionId;
        if (orchestrator) {
            for (const existing of this.runs.values()) {
                const snap = existing.snapshot();
                if (snap.orchestratorSessionId === orchestrator && !isTerminalRunStatus(snap.status)) {
                    throw new Error(`Task "${slug}" already has an active run (${snap.runId}) on this orchestrator; stop it before repairing.`);
                }
            }
        }
        const externalInFrontier = sourceSpec.nodes
            .filter((node) => frontier.has(node.id) && node.effect === 'external-mutation')
            .map((node) => node.id);
        if (externalInFrontier.length > 0 && !approveExternalMutations) {
            throw new Error(`Repair requires explicit approval for external mutation node(s): ${externalInFrontier.join(', ')}`);
        }
        const plan = planMissionReplay(sourceSpec, sourceRunId, sourceLog, (nodeId) => readNodeOutput(this.deps.workspaceRoot, slug, sourceRunId, nodeId), omitUndefined({
            approveExternalMutations,
            workspaceId: this.deps.workspaceId,
            verifyExecutionProof: this.deps.verifyExecutionProof,
        }));
        const blocked = plan.nodes.filter((node) => node.action === 'block');
        if (blocked.length > 0) {
            throw new Error(`Repair is blocked pending reconciliation: ${blocked.map((node) => `${node.nodeId} (${node.reason})`).join('; ')}`);
        }
        const proofByNode = new Map<string, string | undefined>();
        for (const entry of sourceLog) {
            if (entry.kind === 'node-checkpoint' && entry.status === 'confirmed') {
                proofByNode.set(entry.nodeId, entry.proofHash);
            }
        }
        const reusedNodes = plan.nodes
            .filter((node) => node.action === 'reuse' && !frontier.has(node.nodeId))
            .map((node) => {
                const proofHash = proofByNode.get(node.nodeId);
                return { nodeId: node.nodeId, ...(proofHash !== undefined ? { proofHash } : {}) };
            });
        const runId = runOptions.runId ?? (this.deps.genRunId ? this.deps.genRunId() : `run-${Date.now()}`);
        if (runId === sourceRunId || listRunIds(this.deps.workspaceRoot, slug).includes(runId)) {
            throw new Error(`Repair run id "${slug}:${runId}" already exists; targeted repair must create a new immutable run`);
        }
        const run = new ActiveRun(sourceSpec, slug, runId, {
            ...runOptions,
            runId,
            params: resolveParams(sourceSpec, runOptions.params),
            verifyOnComplete: runOptions.verifyOnComplete ?? true,
            replay: {
                sourceRunId,
                externalMutationsApproved: approveExternalMutations,
                reusedNodes,
            },
        }, this.deps);
        this.runs.set(this.key(slug, runId), run);
        try {
            run.start();
        }
        catch (error) {
            this.runs.delete(this.key(slug, runId));
            throw error;
        }
        return run.snapshot();
    }
    pause(slug: string, runId: string): void {
        this.runs.get(this.key(slug, runId))?.pause();
    }
    resume(slug: string, runId: string): void {
        const existing = this.runs.get(this.key(slug, runId));
        if (existing) {
            existing.resume();
            return;
        }
        // Not in memory (e.g. after an app restart): reconstruct from the persisted run-log.
        this.rehydrate(slug, runId, true);
    }
    /** Reconstruct an in-memory run from its persisted run-log + node outputs, then resume it. */
    private rehydrate(slug: string, runId: string, shouldResume: boolean): RunSnapshot {
        const log = readRunLog(this.deps.workspaceRoot, slug, runId);
        if (log.length === 0)
            throw new Error(`Cannot resume "${slug}:${runId}": no run-log found`);
        const snapshottedSpec = readRunSpecSnapshot(this.deps.workspaceRoot, slug, runId);
        const loaded = snapshottedSpec ? null : loadTaskSpec(this.deps.workspaceRoot, slug);
        const spec = snapshottedSpec ?? loaded?.spec;
        if (!spec || (loaded !== null && !loaded.valid)) {
            throw new Error(`Cannot resume "${slug}:${runId}": immutable run snapshot and valid task.yaml are both unavailable`);
        }
        // Recovery must be able to hydrate a denied mission so it can persist a
        // kill-switch intent and drain already-created children. The live switch
        // is enforced by ActiveRun.activateHydrated before any redispatch.
        this.assertSpecAdmissible(spec, slug, false);
        const persistedStatus = persistedRunStatus(log);
        if (isTerminalRunStatus(persistedStatus)) {
            throw new Error(`Cannot resume terminal run "${slug}:${runId}" (${persistedStatus})`);
        }
        const started = log.find((e) => e.kind === 'run-started');
        const orchestratorSessionId = started && started.kind === 'run-started' ? started.orchestratorSessionId : undefined;
        const context = readRunContextSnapshot(this.deps.workspaceRoot, slug, runId);
        const run = new ActiveRun(spec, slug, runId, {
            ...(orchestratorSessionId !== undefined ? { orchestratorSessionId: orchestratorSessionId } : {}),
            params: context?.params ?? resolveParams(spec),
            verifyOnComplete: context?.verifyOnComplete ?? true,
        }, this.deps);
        run.hydrate(log, (nodeId) => readNodeOutput(this.deps.workspaceRoot, slug, runId, nodeId));
        this.runs.set(this.key(slug, runId), run);
        run.activateHydrated(shouldResume);
        return run.snapshot();
    }
    /**
     * Rebuild every non-terminal persisted run known to this workspace.
     *
     * Paused runs are registered but remain paused. Runs that were actively
     * running/verifying resume automatically; approval-gated runs remain waiting.
     */
    recoverNonTerminalRuns(): RunSnapshot[] {
        const recovered: RunSnapshot[] = [];
        const durableSlugs = new Set([
            ...listTaskSlugs(this.deps.workspaceRoot),
            ...listTaskRunSlugs(this.deps.workspaceRoot),
        ]);
        for (const slug of [...durableSlugs].sort()) {
            for (const runId of listRunIds(this.deps.workspaceRoot, slug)) {
                if (this.runs.has(this.key(slug, runId)))
                    continue;
                try {
                    const log = readRunLog(this.deps.workspaceRoot, slug, runId);
                    if (log.length === 0)
                        continue;
                    const status = persistedRunStatus(log);
                    if (isTerminalRunStatus(status))
                        continue;
                    recovered.push(this.rehydrate(slug, runId, status !== 'paused'));
                }
                catch (error) {
                    this.deps.onRecoveryError?.({
                        slug,
                        runId,
                        error: error instanceof Error ? error : new Error(String(error)),
                    });
                }
            }
        }
        return recovered;
    }
    async stop(slug: string, runId: string): Promise<void> {
        await this.runs.get(this.key(slug, runId))?.stop();
    }
    /** Drain every active run now denied by the current durable switch state. */
    enforceKillSwitches(): number {
        let stopped = 0;
        for (const run of this.runs.values()) {
            if (run.enforceKillSwitch())
                stopped += 1;
        }
        return stopped;
    }
    listPendingApprovals(slug?: string, runId?: string): PendingTaskApproval[] {
        const approvals: PendingTaskApproval[] = [];
        for (const run of this.runs.values()) {
            const snapshot = run.snapshot();
            if (slug && snapshot.slug !== slug)
                continue;
            if (runId && snapshot.runId !== runId)
                continue;
            approvals.push(...run.pendingApprovalList());
        }
        return approvals.sort((a, b) => a.requestId.localeCompare(b.requestId));
    }
    resolveApproval(slug: string, runId: string, requestId: string, decision: 'approved' | 'rejected', actor: string, comment?: string): RunSnapshot {
        let run = this.runs.get(this.key(slug, runId));
        if (!run) {
            this.rehydrate(slug, runId, false);
            run = this.runs.get(this.key(slug, runId));
        }
        if (!run)
            throw new Error(`No mission run ${slug}:${runId}`);
        run.resolveApproval(requestId, decision, actor, comment);
        return run.snapshot();
    }
    getRunState(slug: string, runId: string): RunSnapshot | null {
        return this.runs.get(this.key(slug, runId))?.snapshot() ?? null;
    }
    /** Await a run reaching a terminal state (completed/failed/stopped). */
    waitUntilSettled(slug: string, runId: string): Promise<RunSnapshot> {
        const run = this.runs.get(this.key(slug, runId));
        if (!run)
            return Promise.reject(new Error(`No active run ${slug}:${runId}`));
        return run.waitUntilSettled();
    }
    private assertSpecAdmissible(spec: TaskSpec, slug: string, checkKillSwitch = true): void {
        const unsupported = spec.nodes.filter((node) => node.kind !== 'session'
            && node.kind !== 'orchestrator'
            && node.kind !== 'approval'
            && node.kind !== 'judge'
            && node.kind !== 'verify');
        if (unsupported.length > 0) {
            throw new Error(`Refusing to run task "${slug}": unsupported deferred node kind(s): ` +
                unsupported.map((node) => `${node.id}:${node.kind}`).join(', '));
        }
        const isolationPolicy = resolveIsolationPolicy(spec, spec.cwd ?? this.deps.workspaceRoot);
        const isolationDecision = validateExecutionIsolationPolicy(isolationPolicy, this.deps.workspaceRoot);
        if (!isolationDecision.allowed) {
            throw new Error(`Refusing to run task "${slug}": ${isolationDecision.reason}`);
        }
        if (spec.cwd) {
            const cwdDecision = authorizeWorkspacePath(isolationPolicy.workspaceRoot, spec.cwd, ['.']);
            if (!cwdDecision.allowed) {
                throw new Error(`Refusing to run task "${slug}": ${cwdDecision.reason}`);
            }
        }
        if (spec.mission?.budget?.max_cost !== undefined && spec.mission.budget.currency !== 'USD') {
            throw new Error(`Refusing to run task "${slug}": hard cost budgets require USD provider measurements; ${spec.mission.budget.currency} conversion is unavailable`);
        }
        if (!checkKillSwitch)
            return;
        let killSwitch: KillSwitchSnapshot;
        try {
            killSwitch = this.deps.getKillSwitch();
        }
        catch {
            throw new Error(`Refusing to run task "${slug}": kill-switch state is unavailable`);
        }
        const decision = evaluateKillSwitch(killSwitch, this.deps.workspaceId, spec.id);
        if (!decision.allowed) {
            throw new Error(`Refusing to run task "${slug}": ${decision.reason}`);
        }
    }
}
