/**
 * The Conductor — an in-process DAG runner for Tasks.
 *
 * A `task.yaml` (parsed + validated in @craft-agent/shared/tasks) describes a
 * graph of nodes; each node is a child session. The Conductor:
 *   1. schedules ready nodes (deps satisfied) honoring `max_parallel`,
 *   2. dispatches each as a child session (create + sendMessage), interpolating
 *      `${nodes.<id>.output}` / `${params.<name>}` / `${inputs.<name>}` into the prompt,
 *   3. subscribes to SessionManager's in-process `onSessionComplete` seam,
 *   4. on completion reads the child's final assistant text as the node output,
 *      feeds it to dependents, and reschedules,
 *   5. drives child `sessionStatus` + `kanbanColumn` so the board renders the live DAG,
 *   6. persists an append-only run-log under `tasks/<slug>/runs/<runId>/`.
 *
 * v1 executes `kind: 'session'` nodes wired by `depends_on` + `inputs`. Control-flow
 * kinds (route/loop/approval/…) parse but are not yet executed (P4).
 *
 * The runner depends on a minimal `ConductorSessionHost` interface (which
 * SessionManager structurally satisfies) so it is unit-testable with a mock.
 */
import type { CreateSessionOptions } from '@craft-agent/shared/protocol';
import { createHash } from 'node:crypto';
import type { SessionCompletionEvent } from '../sessions/SessionManager';
import {
  type TaskSpec,
  type TaskNode,
  type NodeOutput,
  type RunLogEntry,
  type NodeRunState,
  nodeTitle,
  interpolateRefs,
  materializeDeps,
  appendRunLog,
  writeNodeOutput,
  readNodeOutput,
  readRunLog,
  readRunContextSnapshot,
  readRunSpecSnapshot,
  loadTaskSpec,
  listRunIds,
  listTaskRunSlugs,
  listTaskSlugs,
  writeRunContextSnapshot,
  writeRunSpecSnapshot,
  DEFAULT_REPAIR_ATTEMPTS,
  MAX_REPAIR_ATTEMPTS_CAP,
  authorizeWorkspacePath,
  evaluateKillSwitch,
  validateExecutionIsolationPolicy,
  type ExecutionIsolationPolicy,
  type GuardDecision,
  type KillSwitchSnapshot,
} from '@craft-agent/shared/tasks';

// ---------------------------------------------------------------------------
// Host interface (SessionManager satisfies this structurally)
// ---------------------------------------------------------------------------

export interface ConductorSessionHost {
  /** Creates the child session AND announces it to the renderer (createSession emits
   *  session_created by default), so the subtask appears on the board with its real title. */
  createSession(workspaceId: string, options: CreateSessionOptions): Promise<{ id: string }>;
  sendMessage(sessionId: string, message: string): Promise<void>;
  setSessionStatus(sessionId: string, status: string): Promise<void>;
  setKanbanColumn(sessionId: string, column: string | null): Promise<void>;
  /** Records the total DAG node count on the orchestrator session for a stable board progress denominator. */
  setTaskNodeCount(sessionId: string, count: number): Promise<void>;
  cancelProcessing(sessionId: string, silent?: boolean): Promise<void>;
  onSessionComplete(listener: (evt: SessionCompletionEvent) => void): () => void;
  getSessionFinalText(sessionId: string): string | undefined;
  /** Resolved working directory of a session, so children inherit the orchestrator's cwd. */
  getSessionWorkingDirectory(sessionId: string): string | undefined;
}

export interface TaskRunnerDeps {
  host: ConductorSessionHost;
  workspaceId: string;
  workspaceRoot: string;
  /** Optional output summarizer (call_llm/Haiku). When absent, summarize-flagged inputs pass through. */
  summarize?: (text: string) => Promise<string>;
  /** Default `max_parallel` when the spec omits it. */
  defaultMaxParallel?: number;
  /** Injectable clock (run-log timestamps) + run-id generator, for determinism in tests. */
  now?: () => string;
  /** Injectable wall clock for deadlines and retry scheduling. */
  nowMs?: () => number;
  genRunId?: () => string;
  /** Live kill-switch state. Evaluated before every scheduling pass. */
  getKillSwitch?: () => KillSwitchSnapshot;
  /**
   * Host-side admission hook for connector/sandbox enforcement. The prompt
   * receives the same policy, but this hook is the authoritative boundary.
   */
  executionGuard?: (context: TaskExecutionGuardContext) => GuardDecision | Promise<GuardDecision>;
}

export interface TaskExecutionGuardContext {
  workspaceId: string;
  missionId: string;
  runId: string;
  nodeId: string;
  idempotencyKey: string;
  workingDirectory?: string;
  policy: ExecutionIsolationPolicy;
  /** Strongest side effect declared by the node. */
  effect: TaskNode['effect'];
  /** Effective child permission mode after node/task/default resolution. */
  permissionMode: 'safe' | 'ask' | 'allow-all';
  /** True when the spec explicitly requested host CPU or memory isolation. */
  resourceLimitsExplicit: boolean;
}

export interface RunOptions {
  /** The task's persistent parent/orchestrator session (author + final verifier). */
  orchestratorSessionId?: string;
  /** Resolved task param values (merged over the spec's declared defaults). */
  params?: Record<string, unknown>;
  /** Explicit run id (otherwise generated). */
  runId?: string;
  /** When the run completes, message the orchestrator to verify the result. Default true. */
  verifyOnComplete?: boolean;
}

export type RunStatus = 'running' | 'paused' | 'waiting-approval' | 'verifying' | 'stopped' | 'completed' | 'failed';

export interface NodeRunStatus {
  id: string;
  state: NodeRunState;
  sessionId?: string;
  attempt: number;
}

export interface RunSnapshot {
  slug: string;
  runId: string;
  taskId: string;
  status: RunStatus;
  orchestratorSessionId?: string;
  nodes: NodeRunStatus[];
  /** Sum of each child's (input + output) tokens observed at completion. */
  tokensUsed: number;
  /** Sum of each child's measured cumulative USD cost observed at completion. */
  costUsed: number;
}

export interface PendingTaskApproval {
  requestId: string;
  missionId: string;
  runId: string;
  nodeId: string;
  reason: string;
  impact: 'low' | 'medium' | 'high' | 'critical';
  owner?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_PARALLEL = 4;
// Explicit fail-closed default for a subtask's permission mode when neither the node nor the task
// defaults set one. Mutating autonomy must be an intentional, reviewable opt-in in task.yaml.
const AUTONOMOUS_DEFAULT_MODE = 'safe' as const;
const RUNNING_STATUS = 'in-progress';
const DONE_STATUS = 'done';
// There is no 'failed' session status (the fixed set is todo|in-progress|needs-review|done|cancelled).
// We flag a failed child as 'needs-review' (amber, attention needed); the board's 'failed' run-state
// is derived from the run-log, not from a session status.
const FAILED_STATUS = 'needs-review';

// A malformed verdict (no parseable VERDICT line) is re-asked this many times before we give up and
// fail the run. These re-asks are format-only — they do NOT consume the repair (max_iterations) budget.
const MAX_UNPARSED_REASKS = 2;

const INPUTS_REF_RE = /\$\{\s*inputs\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}/g;

/** Distributive Omit so the run-log discriminated union keeps its per-variant fields. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type RunLogEntryInput = DistributiveOmit<RunLogEntry, 't'>;

interface NodeStateEntry {
  state: NodeRunState;
  sessionId?: string;
  attempt: number;
  /** Durable not-before timestamp for the next retry attempt. */
  retryAtMs?: number;
  /** Reason the previous attempt failed, fed back into the retry prompt (failure-aware retry). */
  lastFailure?: string;
}

// ---------------------------------------------------------------------------
// ActiveRun — a single run's state machine
// ---------------------------------------------------------------------------

class ActiveRun {
  private readonly state = new Map<string, NodeStateEntry>();
  private readonly sessionToNode = new Map<string, string>();
  private readonly outputs: Record<string, NodeOutput> = {};
  private readonly edges: Map<string, Set<string>>;
  private readonly maxParallel: number;
  private inFlight = 0;
  private tokensUsed = 0;
  private costUsed = 0;
  /** Last observed cumulative (input+output) tokens per child session — for delta accounting. */
  private readonly sessionTokens = new Map<string, number>();
  /** Last observed cumulative USD cost per child session — for delta accounting. */
  private readonly sessionCosts = new Map<string, number>();
  private readonly nodeTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private deadlineTimeout?: ReturnType<typeof setTimeout>;
  private readonly approvedNodes = new Set<string>();
  private readonly pendingApprovals = new Map<string, PendingTaskApproval>();
  private runStatus: RunStatus = 'running';
  private unsubscribe?: () => void;
  /** Detaches the one-shot orchestrator-verdict listener while a run is `verifying`. */
  private verdictOff?: () => void;
  /** FAIL verdicts that have triggered a repair pass (bounded by `maxRepairs`). */
  private repairsUsed = 0;
  /** Malformed-verdict re-asks issued (bounded by MAX_UNPARSED_REASKS); not a repair. */
  private unparsedReAsks = 0;
  /** Resolved repair cap = min(spec.max_iterations ?? DEFAULT, CAP). */
  private readonly maxRepairs: number;
  /** Inverted edges: node id → set of nodes that (directly) depend on it. Built lazily for the frontier. */
  private dependents?: Map<string, Set<string>>;
  private settled = false;
  private settleResolvers: ((s: RunSnapshot) => void)[] = [];

  constructor(
    private readonly spec: TaskSpec,
    private readonly slug: string,
    private readonly runId: string,
    private readonly opts: Required<Pick<RunOptions, 'verifyOnComplete'>> & RunOptions,
    private readonly deps: TaskRunnerDeps,
  ) {
    this.edges = materializeDeps(spec);
    this.maxParallel = spec.max_parallel ?? deps.defaultMaxParallel ?? DEFAULT_MAX_PARALLEL;
    // Runner-side clamp (belt-and-suspenders: the schema already caps `max_iterations` at the same
    // bound, so a parsed spec can't exceed it — but a programmatically built spec might).
    this.maxRepairs = Math.min(spec.max_iterations ?? DEFAULT_REPAIR_ATTEMPTS, MAX_REPAIR_ATTEMPTS_CAP);
    for (const node of spec.nodes) this.state.set(node.id, { state: 'pending', attempt: 0 });
  }

  // --- lifecycle ---

  start(): void {
    // The immutable run snapshot is part of the durability contract. Starting
    // without it would make recovery depend on a later-edited task.yaml.
    writeRunSpecSnapshot(this.deps.workspaceRoot, this.slug, this.runId, this.spec);
    writeRunContextSnapshot(this.deps.workspaceRoot, this.slug, this.runId, {
      params: this.opts.params ?? {},
      verifyOnComplete: this.opts.verifyOnComplete,
    });
    this.unsubscribe = this.deps.host.onSessionComplete((evt) => this.onSessionComplete(evt));
    this.log({ kind: 'run-started', taskId: this.spec.id, runId: this.runId, orchestratorSessionId: this.opts.orchestratorSessionId });
    this.runStatus = 'running';
    // Move the task tile to the in-progress column for the duration of the run.
    if (this.opts.orchestratorSessionId) {
      void this.deps.host.setKanbanColumn(this.opts.orchestratorSessionId, 'in-progress');
      void this.deps.host.setSessionStatus(this.opts.orchestratorSessionId, RUNNING_STATUS);
      // Publish the full node count up front so the board's subtask progress denominator is stable,
      // rather than growing as children are spawned lazily at dispatch.
      void this.deps.host.setTaskNodeCount(this.opts.orchestratorSessionId, this.spec.nodes.length);
    }
    if (this.deadlineExpired()) {
      this.failForDeadline();
      return;
    }
    this.armDeadline();
    this.scheduleReady();
  }

  pause(): void {
    if (this.runStatus !== 'running') return;
    this.runStatus = 'paused';
    this.log({ kind: 'run-paused' });
    // In-flight children keep running; their completions still record output but won't schedule.
  }

  resume(): void {
    if (this.runStatus !== 'paused') return;
    // Cancelled nodes return to pending so they re-dispatch. Nodes that exhausted their `retry`
    // budget stay 'failed' — automatic retry happens in failNode within the run, not on resume.
    for (const [, st] of this.state) if (st.state === 'cancelled') st.state = 'pending';
    this.runStatus = 'running';
    this.log({ kind: 'run-resumed' });
    if (this.deadlineExpired()) {
      this.failForDeadline();
      return;
    }
    this.armDeadline();
    this.scheduleReady();
  }

  /**
   * Rebuild run state from a persisted run-log (cross-restart resume). Done nodes reuse their
   * recorded output and are NOT re-run; in-flight/cancelled nodes fall back to pending so they
   * re-dispatch. A done node whose output file is missing also falls back to pending.
   */
  hydrate(log: RunLogEntry[], loadOutput: (nodeId: string) => NodeOutput | null): void {
    const ambiguousNodes = new Set<string>();
    const unresolvedApprovals = new Map<string, PendingTaskApproval>();
    let persistedStatus: RunStatus = 'running';
    for (const e of log) {
      if (e.kind === 'node-spawned') {
        const st = this.state.get(e.nodeId);
        if (st) {
          st.sessionId = e.sessionId;
          this.sessionToNode.set(e.sessionId, e.nodeId);
        }
      } else if (e.kind === 'node-scheduled') {
        const st = this.state.get(e.nodeId);
        if (st) {
          st.attempt += 1;
          st.state = 'running';
          st.retryAtMs = undefined;
        }
      } else if (e.kind === 'node-finished') {
        const st = this.state.get(e.nodeId);
        if (st) st.state = e.state;
      } else if (e.kind === 'node-retry') {
        const st = this.state.get(e.nodeId);
        if (st) {
          st.state = 'pending';
          st.lastFailure = `Previous attempt failed: ${e.reason}. Address the cause before retrying.`;
          st.retryAtMs = e.retryAt ? Date.parse(e.retryAt) : undefined;
        }
      } else if (e.kind === 'node-checkpoint') {
        if (e.status === 'executing') ambiguousNodes.add(e.nodeId);
        else if (e.status === 'confirmed') ambiguousNodes.delete(e.nodeId);
      } else if (e.kind === 'approval-requested') {
        unresolvedApprovals.set(e.requestId, {
          requestId: e.requestId,
          missionId: this.spec.id,
          runId: this.runId,
          nodeId: e.nodeId,
          reason: e.reason,
          impact: e.impact,
          owner: e.owner,
        });
      } else if (e.kind === 'approval-resolved') {
        unresolvedApprovals.delete(e.requestId);
        if (e.decision === 'approved') this.approvedNodes.add(e.nodeId);
      } else if (e.kind === 'verdict') {
        // Reconstruct the durable repair counters so a cross-restart resume honors the cap rather
        // than restarting the budget from zero (the in-memory counters reset on a fresh process).
        if (e.result === 'fail') this.repairsUsed += 1;
        else if (e.result === 'unparsed') this.unparsedReAsks += 1;
        else if (e.result === 'pass') this.unparsedReAsks = 0;
      } else if (e.kind === 'usage-updated') {
        this.tokensUsed = e.tokensUsed;
        this.costUsed = e.costUsed ?? this.costUsed;
      } else if (e.kind === 'run-paused') {
        persistedStatus = 'paused';
      } else if (e.kind === 'run-resumed' || e.kind === 'run-started') {
        persistedStatus = 'running';
      } else if (e.kind === 'run-verifying') {
        persistedStatus = 'verifying';
      } else if (e.kind === 'run-completed') {
        persistedStatus = 'completed';
      } else if (e.kind === 'run-failed') {
        persistedStatus = 'failed';
      } else if (e.kind === 'run-stopped' || e.kind === 'kill-switch') {
        persistedStatus = 'stopped';
      }
    }
    for (const [nodeId, st] of this.state) {
      if (st.state === 'done') {
        const out = loadOutput(nodeId);
        if (out) this.outputs[nodeId] = out;
        else st.state = 'pending'; // recorded output missing → must re-run
      } else if (st.state === 'running' || st.state === 'cancelled') {
        if (ambiguousNodes.has(nodeId)) {
          // A child may have completed an external side effect before the
          // process stopped. Replaying it blindly could duplicate a mutation.
          st.state = 'failed';
          st.lastFailure = 'Interrupted after execution began; inspect provider state and approve a replay.';
        } else {
          st.state = 'pending';
        }
      }
    }
    for (const approval of unresolvedApprovals.values()) {
      const st = this.state.get(approval.nodeId);
      if (!st || st.state === 'done' || st.state === 'failed') continue;
      st.state = 'waiting-approval';
      this.pendingApprovals.set(approval.requestId, approval);
    }
    this.runStatus = this.pendingApprovals.size > 0 ? 'waiting-approval' : persistedStatus;
    this.inFlight = 0;
  }

  /**
   * Activate a hydrated run. Paused runs can be registered without scheduling,
   * while previously-running/verifying runs resume after process restart.
   */
  activateHydrated(shouldResume: boolean): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.host.onSessionComplete((evt) => this.onSessionComplete(evt));
    if (this.pendingApprovals.size > 0) {
      this.runStatus = 'waiting-approval';
      return;
    }
    if (!shouldResume) return;
    if (this.deadlineExpired()) {
      this.failForDeadline();
      return;
    }
    this.armDeadline();
    if (this.runStatus === 'verifying') {
      this.log({ kind: 'run-resumed' });
      this.enterVerifying();
      return;
    }
    this.runStatus = 'running';
    this.log({ kind: 'run-resumed' });
    this.scheduleReady();
  }

  async stop(): Promise<void> {
    if (this.isTerminal()) return;
    this.runStatus = 'stopped';
    this.log({ kind: 'run-stopped' });
    for (const [nodeId, st] of this.state) {
      if (st.state === 'waiting-approval') {
        st.state = 'cancelled';
        this.log({ kind: 'node-finished', nodeId, sessionId: '', state: 'cancelled', reason: 'stopped before approval' });
      } else if (st.state === 'running') {
        this.clearNodeTimeout(nodeId);
        st.state = 'cancelled';
        this.log({ kind: 'node-finished', nodeId, sessionId: st.sessionId ?? '', state: 'cancelled', reason: 'stopped' });
        if (st.sessionId) {
          void this.deps.host.cancelProcessing(st.sessionId, true);
          void this.deps.host.setKanbanColumn(st.sessionId, 'todo');
        }
      }
    }
    this.inFlight = 0;
    this.finalize();
  }

  waitUntilSettled(): Promise<RunSnapshot> {
    if (this.settled) return Promise.resolve(this.snapshot());
    return new Promise((resolve) => this.settleResolvers.push(resolve));
  }

  snapshot(): RunSnapshot {
    return {
      slug: this.slug,
      runId: this.runId,
      taskId: this.spec.id,
      status: this.runStatus,
      orchestratorSessionId: this.opts.orchestratorSessionId,
      tokensUsed: this.tokensUsed,
      costUsed: this.costUsed,
      nodes: this.spec.nodes.map((n) => {
        const st = this.state.get(n.id)!;
        return { id: n.id, state: st.state, sessionId: st.sessionId, attempt: st.attempt };
      }),
    };
  }

  /** Apply a newly published kill switch immediately to this active run. */
  enforceKillSwitch(): boolean {
    if (this.isTerminal()) return false;
    const decision = this.currentKillSwitch();
    if (decision.allowed) return false;
    this.stopForKillSwitch(decision.reason ?? 'Execution stopped by kill switch');
    return true;
  }

  // --- scheduling ---

  private scheduleReady(): void {
    if (this.runStatus !== 'running') return;
    if (this.deadlineExpired()) {
      this.failForDeadline();
      return;
    }
    const killSwitch = this.currentKillSwitch();
    if (!killSwitch.allowed) {
      this.stopForKillSwitch(killSwitch.reason ?? 'Execution stopped by kill switch');
      return;
    }
    for (const node of this.spec.nodes) {
      if (this.inFlight >= this.maxParallel) break;
      if (!this.isReady(node)) continue;
      const budget = this.schedulingBudgetBreach();
      if (budget) {
        this.failForBudget(budget.metric, budget.value, budget.limit);
        return;
      }
      if (this.requiresApproval(node) && !this.approvedNodes.has(node.id)) {
        this.requestApproval(node);
        return;
      }
      if (node.kind === 'approval') {
        this.completeApprovalNode(node);
        continue;
      }
      this.markRunning(node);
      void this.dispatch(node);
    }
    this.maybeFinish();
  }

  private isReady(node: TaskNode): boolean {
    const st = this.state.get(node.id)!;
    if (st.state !== 'pending') return false;
    if (st.retryAtMs !== undefined) {
      if (st.retryAtMs > this.currentTimeMs()) {
        this.armRetry(node.id, st.retryAtMs);
        return false;
      }
      st.retryAtMs = undefined;
      this.clearRetryTimeout(node.id);
    }
    for (const dep of this.edges.get(node.id) ?? []) {
      if (this.state.get(dep)?.state !== 'done') return false;
    }
    return true;
  }

  private markRunning(node: TaskNode): void {
    const st = this.state.get(node.id)!;
    st.state = 'running';
    st.retryAtMs = undefined;
    this.clearRetryTimeout(node.id);
    st.attempt += 1;
    this.inFlight += 1;
    this.log({ kind: 'node-scheduled', nodeId: node.id });
    this.log({
      kind: 'node-checkpoint',
      nodeId: node.id,
      idempotencyKey: this.idempotencyKey(node.id),
      status: 'prepared',
    });
  }

  private requiresApproval(node: TaskNode): boolean {
    return node.kind === 'approval' || node.approval === true;
  }

  private requestApproval(node: TaskNode): void {
    const requestId = `${this.runId}:${node.id}:approval-${this.state.get(node.id)!.attempt + 1}`;
    if (this.pendingApprovals.has(requestId)) return;
    const impact = this.spec.mission?.policy.impact_level ?? (node.effect === 'external-mutation' ? 'high' : 'medium');
    const request: PendingTaskApproval = {
      requestId,
      missionId: this.spec.id,
      runId: this.runId,
      nodeId: node.id,
      reason: node.prompt?.trim() || `Approve mission step "${nodeTitle(node)}"`,
      impact,
      ...((this.spec.mission?.policy.validator ?? this.spec.mission?.policy.owner)
        ? { owner: this.spec.mission?.policy.validator ?? this.spec.mission?.policy.owner }
        : {}),
    };
    this.state.get(node.id)!.state = 'waiting-approval';
    this.pendingApprovals.set(requestId, request);
    this.runStatus = 'waiting-approval';
    this.log({
      kind: 'approval-requested',
      requestId,
      nodeId: node.id,
      reason: request.reason,
      impact,
      ...(request.owner ? { owner: request.owner } : {}),
    });
  }

  private completeApprovalNode(node: TaskNode): void {
    const st = this.state.get(node.id)!;
    st.state = 'done';
    st.attempt += 1;
    const output: NodeOutput = { text: `Approved mission gate: ${nodeTitle(node)}` };
    this.outputs[node.id] = output;
    writeNodeOutput(this.deps.workspaceRoot, this.slug, this.runId, node.id, output);
    this.log({ kind: 'node-finished', nodeId: node.id, sessionId: '', state: 'done' });
  }

  pendingApprovalList(): PendingTaskApproval[] {
    return [...this.pendingApprovals.values()];
  }

  resolveApproval(requestId: string, decision: 'approved' | 'rejected', actor: string, comment?: string): void {
    const request = this.pendingApprovals.get(requestId);
    if (!request) throw new Error(`Approval request "${requestId}" is not pending`);
    const node = this.spec.nodes.find((candidate) => candidate.id === request.nodeId);
    if (!node) throw new Error(`Approval node "${request.nodeId}" no longer exists`);
    this.pendingApprovals.delete(requestId);
    this.log({
      kind: 'approval-resolved',
      requestId,
      nodeId: node.id,
      decision,
      actor,
      ...(comment ? { comment } : {}),
    });
    const st = this.state.get(node.id)!;
    if (decision === 'rejected') {
      st.state = 'failed';
      st.lastFailure = comment || 'High-impact action rejected by validator.';
      this.log({ kind: 'node-finished', nodeId: node.id, sessionId: '', state: 'failed', reason: st.lastFailure });
    } else {
      this.approvedNodes.add(node.id);
      st.state = 'pending';
    }
    if (this.pendingApprovals.size > 0) return;
    this.runStatus = 'running';
    this.scheduleReady();
  }

  private async dispatch(node: TaskNode): Promise<void> {
    try {
      // Task-level skills ride as [skill:slug] mentions on every child prompt — the agent
      // pipeline resolves each SKILL.md and blocks tools until it is read (skills-as-context).
      const st = this.state.get(node.id)!;
      const idempotencyKey = this.idempotencyKey(node.id);
      // Children run where the parent runs: inherit the orchestrator's resolved working directory,
      // falling back to the spec's declared `cwd`. Without this they default to the workspace cwd
      // rather than the parent session's (project) directory.
      const cwd =
        (this.opts.orchestratorSessionId
          ? this.deps.host.getSessionWorkingDirectory(this.opts.orchestratorSessionId)
          : undefined) ?? this.spec.cwd;
      const policy = resolveIsolationPolicy(this.spec, cwd ?? this.deps.workspaceRoot);
      const isolationDecision = validateExecutionIsolationPolicy(policy, this.deps.workspaceRoot);
      if (!isolationDecision.allowed) {
        throw new Error(`execution isolation rejected node: ${isolationDecision.reason ?? 'blocked'}`);
      }
      if (cwd) {
        const cwdDecision = authorizeWorkspacePath(policy.workspaceRoot, cwd, ['.']);
        if (!cwdDecision.allowed) {
          throw new Error(`working directory rejected: ${cwdDecision.reason}`);
        }
      }
      const permissionMode =
        node.permissionMode ?? this.spec.defaults?.permissionMode ?? AUTONOMOUS_DEFAULT_MODE;
      const guardDecision = await this.deps.executionGuard?.({
        workspaceId: this.deps.workspaceId,
        missionId: this.spec.id,
        runId: this.runId,
        nodeId: node.id,
        idempotencyKey,
        workingDirectory: cwd,
        policy,
        effect: node.effect,
        permissionMode,
        resourceLimitsExplicit:
          this.spec.execution?.max_cpu_percent !== undefined ||
          this.spec.execution?.max_memory_mb !== undefined,
      });
      if (guardDecision && !guardDecision.allowed) {
        throw new Error(`execution guard rejected node: ${guardDecision.reason ?? 'blocked'}`);
      }
      const prompt =
        skillsPreamble(this.spec.skills) +
        executionPreamble(policy, idempotencyKey) +
        (await this.buildPrompt(node));
      const options: CreateSessionOptions = {
        parentSessionId: this.opts.orchestratorSessionId,
        // Link the child back to the task / run / node so the manual subtask composer can
        // tell Conductor-owned children apart from hand-authored subtasks (it skips the former).
        taskSlug: this.slug,
        taskRunId: this.runId,
        taskNodeId: node.id,
        name: nodeTitle(node),
        model: node.model ?? this.spec.defaults?.model,
        // Required for non-default (e.g. pi/*) models to resolve a backend — without it the
        // child session completes instantly with no output.
        llmConnection: node.llmConnection ?? this.spec.defaults?.llmConnection,
        // Node override → task default (persisted by the editor, visible to the user) → explicit
        // unattended-safe fallback. Never the workspace default (which could be `ask` → hang).
        permissionMode,
        labels: node.labels,
        // Inherit the orchestrator's task number (task::N) so the whole run filters as one task.
        applyTaskLabel: true,
        // Task-level sources become the child's enabled-sources set (spec omitted → workspace default).
        ...(this.spec.sources?.length ? { enabledSourceSlugs: this.spec.sources } : {}),
        projectId: this.spec.project,
        ...(cwd ? { workingDirectory: cwd } : {}),
        sessionStatus: RUNNING_STATUS,
      };
      // createSession announces the child to the renderer by default, so it nests under the task
      // tile with its real title instead of a fabricated "New Chat" (or never appearing).
      const child = await this.deps.host.createSession(this.deps.workspaceId, options);
      st.sessionId = child.id;
      this.sessionToNode.set(child.id, node.id);
      this.log({ kind: 'node-spawned', nodeId: node.id, sessionId: child.id });
      await this.deps.host.setKanbanColumn(child.id, 'in-progress');
      this.log({ kind: 'node-checkpoint', nodeId: node.id, idempotencyKey, status: 'executing' });
      await this.deps.host.sendMessage(child.id, prompt);
      this.armNodeTimeout(node.id, child.id, node.timeout ?? policy.timeoutMs);
    } catch (err) {
      this.failNode(node.id, `dispatch failed: ${(err as Error).message}`);
    }
  }

  /** Resolve a node's prompt: declared inputs (+ optional summarize) then ${…} interpolation. */
  private async buildPrompt(node: TaskNode): Promise<string> {
    const inputValues: Record<string, unknown> = {};
    for (const [name, ref] of Object.entries(node.inputs ?? {})) {
      const fromExpr = typeof ref === 'string' ? ref : ref.from;
      const summarize = typeof ref === 'string' ? false : !!ref.summarize;
      let resolved = interpolateRefs(fromExpr, { nodeOutputs: this.outputs, params: this.opts.params });
      if (summarize && this.deps.summarize) resolved = await this.deps.summarize(resolved);
      inputValues[name] = resolved;
    }
    let text = interpolateRefs(node.prompt ?? '', { nodeOutputs: this.outputs, params: this.opts.params });
    text = text.replace(INPUTS_REF_RE, (raw, name: string) => (name in inputValues ? String(inputValues[name]) : raw));

    // Failure-aware retry: prepend the prior failure so a retried session knows what went wrong
    // instead of blindly repeating a deterministic failure.
    const st = this.state.get(node.id)!;
    if (st.attempt > 1 && st.lastFailure) {
      text = `${st.lastFailure}\n\n${text}`;
    }
    return text;
  }

  // --- completion ---

  private onSessionComplete(evt: SessionCompletionEvent): void {
    const nodeId = this.sessionToNode.get(evt.sessionId);
    if (!nodeId) return; // not one of our child nodes
    const st = this.state.get(nodeId);
    if (!st || st.state !== 'running') return; // already settled/cancelled
    this.clearNodeTimeout(nodeId);

    if (evt.tokenUsage) {
      // `tokenUsage` is cumulative-per-session; add only the delta since this session's last
      // observed total so a node that ever runs >1 turn (future retry/loop) can't double-count.
      const cumulative = (evt.tokenUsage.inputTokens ?? 0) + (evt.tokenUsage.outputTokens ?? 0);
      const prev = this.sessionTokens.get(evt.sessionId) ?? 0;
      this.tokensUsed += Math.max(0, cumulative - prev);
      this.sessionTokens.set(evt.sessionId, cumulative);
      const cumulativeCost = Math.max(0, evt.tokenUsage.costUsd ?? 0);
      const previousCost = this.sessionCosts.get(evt.sessionId) ?? 0;
      this.costUsed += Math.max(0, cumulativeCost - previousCost);
      this.sessionCosts.set(evt.sessionId, cumulativeCost);
      this.log({
        kind: 'usage-updated',
        tokensUsed: this.tokensUsed,
        costUsed: this.costUsed,
        currency: 'USD',
      });

      const measuredBreach = this.measuredBudgetBreach();
      if (measuredBreach && this.runStatus === 'running') {
        this.failForBudget(measuredBreach.metric, measuredBreach.value, measuredBreach.limit);
        return;
      }
    }

    if (evt.reason === 'complete') {
      const text = evt.finalText ?? this.deps.host.getSessionFinalText(evt.sessionId) ?? '';

      // A clean turn-completion is not proof of success: a node that declared `outputs` but
      // produced no text delivered nothing. Treat that as a failure (retry/needs-review) instead
      // of silently marking it done. Nodes with no declared outputs keep the lenient behavior.
      const node = this.spec.nodes.find((n) => n.id === nodeId);
      if ((node?.outputs?.length ?? 0) > 0 && text.trim() === '') {
        this.failNode(nodeId, 'completed without producing declared output', evt.sessionId);
        return;
      }

      const output: NodeOutput = { text };
      this.outputs[nodeId] = output;
      st.state = 'done';
      this.inFlight = Math.max(0, this.inFlight - 1);
      writeNodeOutput(this.deps.workspaceRoot, this.slug, this.runId, nodeId, output);
      this.log({
        kind: 'node-checkpoint',
        nodeId,
        idempotencyKey: this.idempotencyKey(nodeId),
        status: 'confirmed',
        proofHash: createHash('sha256').update(text, 'utf8').digest('hex'),
      });
      this.log({ kind: 'node-finished', nodeId, sessionId: evt.sessionId, state: 'done' });
      void this.deps.host.setSessionStatus(evt.sessionId, DONE_STATUS);
      void this.deps.host.setKanbanColumn(evt.sessionId, 'done');
      this.scheduleReady();
    } else if (evt.reason === 'interrupted') {
      // Externally aborted while running → cancelled (re-dispatched on resume). We do not
      // auto-retry here to avoid a stop/retry loop.
      st.state = 'cancelled';
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.log({ kind: 'node-finished', nodeId, sessionId: evt.sessionId, state: 'cancelled', reason: 'interrupted' });
      void this.deps.host.setKanbanColumn(evt.sessionId, 'todo');
      this.scheduleReady();
    } else {
      // 'error' | 'timeout'
      this.failNode(nodeId, evt.reason, evt.sessionId);
    }
  }

  private failNode(nodeId: string, reason: string, sessionId?: string): void {
    this.clearNodeTimeout(nodeId);
    const st = this.state.get(nodeId)!;
    const wasRunning = st.state === 'running';
    if (wasRunning) this.inFlight = Math.max(0, this.inFlight - 1);

    // Bounded, failure-aware retry: re-dispatch the node when its `retry` policy still
    // has budget and matches this failure class. error/timeout/dispatch failures all map
    // to the `error` retry trigger (empty/invalid detection is deferred).
    const node = this.spec.nodes.find((n) => n.id === nodeId);
    const retry = node?.retry;
    if (retry && st.attempt <= retry.limit && retryMatches(retry.when, 'error')) {
      st.lastFailure = `Previous attempt failed: ${reason}. Address the cause before retrying.`;
      st.state = 'pending';
      const sid = sessionId ?? st.sessionId;
      if (sid) void this.deps.host.setKanbanColumn(sid, 'todo');
      const delayMs = retryDelayMs(retry.backoff, st.attempt);
      if (delayMs > 0) {
        st.retryAtMs = this.currentTimeMs() + delayMs;
        this.log({
          kind: 'node-retry',
          nodeId,
          attempt: st.attempt,
          reason,
          delayMs,
          retryAt: new Date(st.retryAtMs).toISOString(),
        });
        this.armRetry(nodeId, st.retryAtMs);
      } else {
        this.log({ kind: 'node-retry', nodeId, attempt: st.attempt, reason, delayMs: 0 });
        this.scheduleReady();
      }
      return;
    }

    st.state = 'failed';
    const sid = sessionId ?? st.sessionId;
    this.log({ kind: 'node-finished', nodeId, sessionId: sid ?? '', state: 'failed', reason });
    if (sid) void this.deps.host.setSessionStatus(sid, FAILED_STATUS);
    this.scheduleReady();
  }

  private maybeFinish(): void {
    if (this.runStatus !== 'running') return;
    if (this.inFlight > 0) return;
    if (this.spec.nodes.some((n) => this.isReady(n))) return; // more to dispatch
    if (this.hasDeferredRetry()) return;
    const allGood = this.spec.nodes.every((n) => {
      const s = this.state.get(n.id)!.state;
      return s === 'done' || s === 'skipped';
    });
    if (!allGood) {
      this.finish('failed');
      return;
    }
    // All nodes succeeded. Gate the terminal status on the orchestrator's verdict when there is one
    // to ask; with no orchestrator there is nothing to verify against, so complete directly.
    if (this.opts.verifyOnComplete && this.opts.orchestratorSessionId) {
      this.enterVerifying();
    } else {
      this.finish('completed');
    }
  }

  /** Enter the non-terminal `verifying` state and ask the orchestrator for a verdict. Does NOT finalize. */
  private enterVerifying(): void {
    this.runStatus = 'verifying';
    this.log({ kind: 'run-verifying' });
    void this.sendVerification();
  }

  private finish(status: RunStatus): void {
    this.runStatus = status;
    this.log({ kind: status === 'completed' ? 'run-completed' : 'run-failed' });
    // Settle the task tile: completed → done, failed → needs-review (the fixed status set has no
    // 'failed'). The in-progress column was set at start().
    const orchestrator = this.opts.orchestratorSessionId;
    if (orchestrator) {
      if (status === 'completed') {
        void this.deps.host.setKanbanColumn(orchestrator, 'done');
        void this.deps.host.setSessionStatus(orchestrator, DONE_STATUS);
      } else {
        void this.deps.host.setSessionStatus(orchestrator, FAILED_STATUS);
      }
    }
    this.finalize();
  }

  private finalize(): void {
    for (const timeout of this.nodeTimeouts.values()) clearTimeout(timeout);
    this.nodeTimeouts.clear();
    for (const timeout of this.retryTimeouts.values()) clearTimeout(timeout);
    this.retryTimeouts.clear();
    if (this.deadlineTimeout) clearTimeout(this.deadlineTimeout);
    this.deadlineTimeout = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.verdictOff?.();
    this.verdictOff = undefined;
    if (this.settled) return;
    this.settled = true;
    const snap = this.snapshot();
    for (const resolve of this.settleResolvers) resolve(snap);
    this.settleResolvers = [];
  }

  private async sendVerification(): Promise<void> {
    const orchestrator = this.opts.orchestratorSessionId;
    if (!orchestrator) {
      this.finish('completed');
      return;
    }
    this.attachVerdictListener(orchestrator);
    const sections = this.spec.nodes.map((n) => {
      const out = this.outputs[n.id];
      return `### ${nodeTitle(n)} (${n.id})\n${out ? out.text : '(no output)'}`;
    });
    const rubric = this.spec.acceptance_criteria
      ? `Acceptance criteria:\n${this.spec.acceptance_criteria}`
      : `Goal: ${this.spec.goal}`;
    const message = [
      `The task "${this.spec.title}" has finished running.`,
      '',
      rubric,
      '',
      'Node outputs:',
      ...sections,
      '',
      'Verify the final result against the criteria above and summarize the outcome.',
      'End your reply with a verdict line, on its own line, in exactly one of these forms:',
      'VERDICT: PASS',
      'VERDICT: FAIL — <one-line reason>',
      'If only some subtasks need redoing, name them so only those (and their dependents) re-run:',
      'VERDICT: FAIL — nodes=<id>,<id> — <one-line reason>',
    ].join('\n');
    await this.sendToOrchestrator(orchestrator, message);
  }

  /**
   * Attach the one-shot orchestrator-verdict listener (separate from the run's main subscription).
   * It catches the orchestrator's next completion, detaches itself, and routes the text to handleVerdict.
   */
  private attachVerdictListener(orchestrator: string): void {
    this.verdictOff?.();
    this.verdictOff = this.deps.host.onSessionComplete((evt) => {
      if (evt.sessionId !== orchestrator) return;
      this.verdictOff?.();
      this.verdictOff = undefined;
      const text = evt.finalText ?? this.deps.host.getSessionFinalText(orchestrator) ?? '';
      this.handleVerdict(text);
    });
  }

  /** Send to the orchestrator, failing the run (rather than hanging in `verifying`) if the send rejects. */
  private async sendToOrchestrator(orchestrator: string, message: string): Promise<void> {
    try {
      await this.deps.host.sendMessage(orchestrator, message);
    } catch {
      // The verdict will never arrive — detach the listener and settle as failed instead of hanging.
      this.verdictOff?.();
      this.verdictOff = undefined;
      this.finish('failed');
    }
  }

  /**
   * Apply the orchestrator's parsed verdict:
   *   PASS      → completed.
   *   unparsed  → re-ask for a well-formed verdict (bounded; not a repair); exhausted → failed.
   *   FAIL      → repair the frontier if budget remains, else failed (iterations/token budget breach).
   */
  private handleVerdict(text: string): void {
    if (this.runStatus !== 'verifying') return; // stopped/finalized while awaiting the verdict
    writeNodeOutput(this.deps.workspaceRoot, this.slug, this.runId, '__verdict__', { text });
    const verdict = parseVerdict(text);
    this.log({ kind: 'verdict', result: verdict.result, reason: verdict.reason, nodes: verdict.nodes });

    if (verdict.result === 'pass') {
      this.unparsedReAsks = 0;
      this.finish('completed');
      return;
    }

    if (verdict.result === 'unparsed') {
      if (this.unparsedReAsks < MAX_UNPARSED_REASKS) {
        this.unparsedReAsks += 1;
        void this.reAskVerdict();
        return;
      }
      // Repeatedly malformed → don't hang the run forever.
      this.finish('failed');
      return;
    }

    // FAIL — repair the frontier if there is budget for it.
    if (this.repairsUsed >= this.maxRepairs) {
      this.log({ kind: 'budget-breach', metric: 'iterations', value: this.repairsUsed, limit: this.maxRepairs });
      this.finish('failed');
      return;
    }
    const budget = this.schedulingBudgetBreach();
    if (budget) {
      this.failForBudget(budget.metric, budget.value, budget.limit);
      return;
    }
    this.repairsUsed += 1;
    this.repairForVerdict(verdict.reason, verdict.nodes);
  }

  /** Re-ask the orchestrator for a parseable verdict line (format-only; does not consume repair budget). */
  private async reAskVerdict(): Promise<void> {
    const orchestrator = this.opts.orchestratorSessionId;
    if (!orchestrator) {
      this.finish('completed');
      return;
    }
    this.attachVerdictListener(orchestrator);
    const message = [
      'Your previous reply did not include a parseable verdict line.',
      'Reply with the verdict line only, on its own line, in exactly one of these forms:',
      'VERDICT: PASS',
      'VERDICT: FAIL — <one-line reason>',
      'VERDICT: FAIL — nodes=<id>,<id> — <one-line reason>',
    ].join('\n');
    await this.sendToOrchestrator(orchestrator, message);
  }

  /**
   * On a FAIL verdict, re-run the repair frontier with the rejection reason as failure context.
   * The frontier is the orchestrator-named nodes ∪ their transitive dependents (so a re-run upstream
   * node forces everything that consumes its output to re-run too). With no usable names it is the
   * whole DAG. Only `done` nodes are reset; scheduleReady re-dispatches from the satisfied sources.
   */
  private repairForVerdict(reason: string | undefined, named?: string[]): void {
    const detail = reason ?? 'the result did not meet the acceptance criteria';
    let reset = 0;
    for (const id of this.computeFrontier(named)) {
      const st = this.state.get(id);
      if (!st || st.state !== 'done') continue;
      st.state = 'pending';
      st.lastFailure = `The previous result was rejected on verification: ${detail}. Revise your output to meet the acceptance criteria.`;
      this.log({ kind: 'node-retry', nodeId: id, attempt: st.attempt, reason: `verdict-fail: ${detail}` });
      reset += 1;
    }
    if (reset === 0) {
      // No `done` node in the frontier to re-run → don't hang the run.
      this.finish('failed');
      return;
    }
    this.runStatus = 'running';
    this.scheduleReady();
  }

  /**
   * The set of nodes a repair pass re-runs: the orchestrator-named nodes plus everything that
   * (transitively) depends on them. Unknown/empty names degrade to the whole DAG.
   */
  private computeFrontier(named?: string[]): Set<string> {
    const valid = (named ?? []).filter((id) => this.state.has(id));
    if (valid.length === 0) return new Set(this.spec.nodes.map((n) => n.id));
    const dependents = this.dependentsMap();
    const frontier = new Set<string>();
    const queue = [...valid];
    while (queue.length) {
      const id = queue.shift()!;
      if (frontier.has(id)) continue;
      frontier.add(id);
      for (const d of dependents.get(id) ?? []) if (!frontier.has(d)) queue.push(d);
    }
    return frontier;
  }

  /** Inverted `edges`: node id → set of nodes that directly depend on it (memoized). */
  private dependentsMap(): Map<string, Set<string>> {
    if (this.dependents) return this.dependents;
    const map = new Map<string, Set<string>>();
    for (const n of this.spec.nodes) map.set(n.id, new Set());
    for (const [node, upstreams] of this.edges) {
      for (const u of upstreams) map.get(u)?.add(node);
    }
    this.dependents = map;
    return map;
  }

  // --- hard limits ---

  private tokenBudgetLimit(): number | undefined {
    const candidates = [
      this.spec.token_budget,
      this.spec.mission?.budget?.max_tokens,
    ].filter((value): value is number => value !== undefined);
    return candidates.length > 0 ? Math.min(...candidates) : undefined;
  }

  private costBudgetLimit(): number | undefined {
    return this.spec.mission?.budget?.max_cost;
  }

  /** A limit reached before a new dispatch is fail-closed: no unbudgeted work starts. */
  private schedulingBudgetBreach(): { metric: 'tokens' | 'cost'; value: number; limit: number } | null {
    const tokenLimit = this.tokenBudgetLimit();
    if (tokenLimit !== undefined && this.tokensUsed >= tokenLimit) {
      return { metric: 'tokens', value: this.tokensUsed, limit: tokenLimit };
    }
    const costLimit = this.costBudgetLimit();
    if (costLimit !== undefined && this.costUsed >= costLimit) {
      return { metric: 'cost', value: this.costUsed, limit: costLimit };
    }
    return null;
  }

  /** Measured usage may overshoot between provider reports; overshoot immediately fails the run. */
  private measuredBudgetBreach(): { metric: 'tokens' | 'cost'; value: number; limit: number } | null {
    const tokenLimit = this.tokenBudgetLimit();
    if (tokenLimit !== undefined && this.tokensUsed > tokenLimit) {
      return { metric: 'tokens', value: this.tokensUsed, limit: tokenLimit };
    }
    const costLimit = this.costBudgetLimit();
    if (costLimit !== undefined && this.costUsed > costLimit) {
      return { metric: 'cost', value: this.costUsed, limit: costLimit };
    }
    return null;
  }

  private failForBudget(metric: 'tokens' | 'cost', value: number, limit: number): void {
    if (this.isTerminal()) return;
    this.log({ kind: 'budget-breach', metric, value, limit });
    this.cancelRunningNodes(`hard ${metric} budget breached`);
    this.finish('failed');
  }

  private deadlineExpired(): boolean {
    const deadline = this.spec.mission?.deadline;
    return deadline !== undefined && this.currentTimeMs() >= Date.parse(deadline);
  }

  private armDeadline(): void {
    const deadline = this.spec.mission?.deadline;
    if (!deadline || this.isTerminal()) return;
    if (this.deadlineTimeout) clearTimeout(this.deadlineTimeout);
    const remainingMs = Date.parse(deadline) - this.currentTimeMs();
    if (remainingMs <= 0) {
      this.failForDeadline();
      return;
    }
    // Node timers cap at a signed 32-bit delay. Re-arm long deadlines safely.
    this.deadlineTimeout = setTimeout(
      () => {
        this.deadlineTimeout = undefined;
        if (this.deadlineExpired()) this.failForDeadline();
        else this.armDeadline();
      },
      Math.min(remainingMs, 2_147_483_647),
    );
  }

  private failForDeadline(): void {
    if (this.isTerminal()) return;
    const deadline = this.spec.mission?.deadline;
    if (!deadline) return;
    this.log({ kind: 'deadline-breach', deadline });
    this.cancelRunningNodes('mission deadline breached');
    this.finish('failed');
  }

  private cancelRunningNodes(reason: string): void {
    for (const [nodeId, st] of this.state) {
      if (st.state !== 'running') continue;
      this.clearNodeTimeout(nodeId);
      st.state = 'cancelled';
      this.log({
        kind: 'node-finished',
        nodeId,
        sessionId: st.sessionId ?? '',
        state: 'cancelled',
        reason,
      });
      if (st.sessionId) void this.deps.host.cancelProcessing(st.sessionId, true);
    }
    this.inFlight = 0;
  }

  private hasDeferredRetry(): boolean {
    for (const st of this.state.values()) {
      if (st.state === 'pending' && st.retryAtMs !== undefined && st.retryAtMs > this.currentTimeMs()) {
        return true;
      }
    }
    return false;
  }

  // --- helpers ---

  private isTerminal(): boolean {
    return this.runStatus === 'completed' || this.runStatus === 'failed' || this.runStatus === 'stopped';
  }

  private currentTimeMs(): number {
    if (this.deps.nowMs) return this.deps.nowMs();
    return Date.now();
  }

  private idempotencyKey(nodeId: string): string {
    return `${this.deps.workspaceId}:${this.spec.id}:${this.runId}:${nodeId}`;
  }

  private currentKillSwitch(): GuardDecision {
    const snapshot = this.deps.getKillSwitch?.();
    return snapshot
      ? evaluateKillSwitch(snapshot, this.deps.workspaceId, this.spec.id)
      : { allowed: true };
  }

  private stopForKillSwitch(reason: string): void {
    const scope = reason.startsWith('Global')
      ? 'global'
      : reason.startsWith('Workspace')
        ? 'workspace'
        : 'mission';
    this.log({ kind: 'kill-switch', scope, reason });
    this.runStatus = 'stopped';
    for (const [nodeId, st] of this.state) {
      if (st.state !== 'running') continue;
      this.clearNodeTimeout(nodeId);
      st.state = 'cancelled';
      if (st.sessionId) void this.deps.host.cancelProcessing(st.sessionId, true);
    }
    this.finalize();
  }

  private armNodeTimeout(nodeId: string, sessionId: string, timeoutMs: number): void {
    this.clearNodeTimeout(nodeId);
    const timer = setTimeout(() => {
      const st = this.state.get(nodeId);
      if (!st || st.state !== 'running') return;
      void this.deps.host.cancelProcessing(sessionId, true);
      this.failNode(nodeId, `execution timeout after ${timeoutMs}ms`, sessionId);
    }, timeoutMs);
    this.nodeTimeouts.set(nodeId, timer);
  }

  private clearNodeTimeout(nodeId: string): void {
    const timeout = this.nodeTimeouts.get(nodeId);
    if (timeout) clearTimeout(timeout);
    this.nodeTimeouts.delete(nodeId);
  }

  private armRetry(nodeId: string, retryAtMs: number): void {
    if (this.retryTimeouts.has(nodeId)) return;
    const delayMs = Math.max(0, retryAtMs - this.currentTimeMs());
    const timer = setTimeout(() => {
      this.retryTimeouts.delete(nodeId);
      const st = this.state.get(nodeId);
      if (!st || st.state !== 'pending') return;
      if (st.retryAtMs !== undefined && st.retryAtMs > this.currentTimeMs()) {
        this.armRetry(nodeId, st.retryAtMs);
        return;
      }
      st.retryAtMs = undefined;
      this.scheduleReady();
    }, Math.min(delayMs, 2_147_483_647));
    this.retryTimeouts.set(nodeId, timer);
  }

  private clearRetryTimeout(nodeId: string): void {
    const timeout = this.retryTimeouts.get(nodeId);
    if (timeout) clearTimeout(timeout);
    this.retryTimeouts.delete(nodeId);
  }

  private log(entry: RunLogEntryInput): void {
    const t = this.deps.now ? this.deps.now() : new Date().toISOString();
    appendRunLog(this.deps.workspaceRoot, this.slug, this.runId, { ...entry, t } as RunLogEntry);
  }
}

// ---------------------------------------------------------------------------
// TaskRunner — registry/service over active runs
// ---------------------------------------------------------------------------

/**
 * Prefix for dispatched child prompts carrying the task's skill list as [skill:slug]
 * mentions. The agent pipeline (base-agent) parses these from any message, resolves each
 * skill's SKILL.md, and blocks tool use until the files are read — so task-level skills
 * act as mandatory context for every subtask. Empty/absent skills → empty prefix.
 */
function skillsPreamble(skills: string[] | undefined): string {
  if (!skills?.length) return '';
  return `Apply these skills: ${skills.map((s) => `[skill:${s}]`).join(' ')}\n\n`;
}

function resolveIsolationPolicy(spec: TaskSpec, defaultRoot: string): ExecutionIsolationPolicy {
  const configured = spec.execution;
  return {
    workspaceRoot: configured?.root_path ?? defaultRoot,
    allowedReadPaths: configured?.allowed_read_paths ?? ['.'],
    allowedWritePaths: configured?.allowed_write_paths ?? [],
    networkAccess: configured?.network_access ?? 'disabled',
    allowedHosts: configured?.allowed_hosts ?? [],
    maxCpuPercent: configured?.max_cpu_percent ?? 100,
    maxMemoryMb: configured?.max_memory_mb ?? 1024,
    timeoutMs: configured?.timeout_ms ?? 30 * 60 * 1000,
  };
}

function executionPreamble(policy: ExecutionIsolationPolicy, idempotencyKey: string): string {
  return [
    '[Execution policy]',
    `Idempotency key: ${idempotencyKey}`,
    `Read paths: ${policy.allowedReadPaths.join(', ') || '(none)'}`,
    `Write paths: ${policy.allowedWritePaths.join(', ') || '(none)'}`,
    `Network: ${policy.networkAccess}${policy.allowedHosts.length ? ` (${policy.allowedHosts.join(', ')})` : ''}`,
    `Resource envelope: CPU ${policy.maxCpuPercent}%, memory ${policy.maxMemoryMb} MiB, timeout ${policy.timeoutMs} ms`,
    'Reuse the idempotency key for every external mutation. Never persist secret values in output, logs, or checkpoints.',
    '',
    '',
  ].join('\n');
}

/**
 * Whether a node's `retry.when` trigger covers a given failure class. An absent `when`
 * defaults to retrying on `error` (the common "transient failure" case); `empty`/`invalid`
 * triggers are opt-in and not yet produced by the runner, so they never match here.
 */
function retryMatches(when: 'error' | 'empty' | 'invalid' | undefined, failure: 'error'): boolean {
  return (when ?? 'error') === failure;
}

/** Resolve exponential retry delay in milliseconds; an omitted backoff keeps legacy immediate retry. */
function retryDelayMs(
  backoff: { base?: number; factor?: number; max?: number } | undefined,
  failedAttempt: number,
): number {
  if (!backoff) return 0;
  const base = backoff.base ?? 1_000;
  const factor = backoff.factor ?? 2;
  const maximum = backoff.max ?? 30_000;
  return Math.min(maximum, base * factor ** Math.max(0, failedAttempt - 1));
}

/**
 * Parse the orchestrator's machine-readable verdict line. Tolerant of surrounding prose: the last
 * `VERDICT: PASS|FAIL [— [nodes=a,b — ]reason]` occurrence wins. A missing/garbled line is `unparsed`
 * — the caller re-asks (bounded) rather than hanging the run on a malformed reply.
 *
 * The optional `nodes=<id>,<id>` prefix names the subtasks to re-run on a FAIL (scoped repair). Node
 * ids are slugs (may contain single hyphens), so the prefix is split from the reason on an em-dash or
 * colon only — never on the hyphen that legitimately appears inside a slug.
 */
function parseVerdict(text: string): { result: 'pass' | 'fail' | 'unparsed'; reason?: string; nodes?: string[] } {
  const matches = [...text.matchAll(/VERDICT:\s*(PASS|FAIL)\b[ \t]*(?:[—:-]+[ \t]*([^\n]*))?/gi)];
  const last = matches.at(-1);
  if (!last) return { result: 'unparsed' };
  const result = last[1]!.toUpperCase() === 'PASS' ? 'pass' : 'fail';
  let rest = last[2]?.trim() || undefined;
  let nodes: string[] | undefined;
  if (rest) {
    const m = rest.match(/^nodes=([a-z0-9,\- ]+?)\s*(?:[—:]+\s*(.*))?$/i);
    if (m) {
      nodes = m[1]!.split(',').map((s) => s.trim()).filter(Boolean);
      rest = m[2]?.trim() || undefined;
    }
  }
  const out: { result: 'pass' | 'fail' | 'unparsed'; reason?: string; nodes?: string[] } = { result };
  if (rest) out.reason = rest;
  if (nodes && nodes.length) out.nodes = nodes;
  return out;
}

/** A run is terminal (no further work) once completed/failed/stopped. running/paused/verifying are active. */
function isTerminalRunStatus(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped';
}

function persistedRunStatus(log: RunLogEntry[]): RunStatus {
  let status: RunStatus = 'running';
  for (const entry of log) {
    if (entry.kind === 'run-paused') status = 'paused';
    else if (entry.kind === 'run-resumed' || entry.kind === 'run-started') status = 'running';
    else if (entry.kind === 'run-verifying') status = 'verifying';
    else if (entry.kind === 'approval-requested') status = 'waiting-approval';
    else if (entry.kind === 'approval-resolved') status = 'running';
    else if (entry.kind === 'run-completed') status = 'completed';
    else if (entry.kind === 'run-failed') status = 'failed';
    else if (entry.kind === 'run-stopped' || entry.kind === 'kill-switch') status = 'stopped';
  }
  return status;
}

function resolveParams(spec: TaskSpec, provided?: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of spec.params ?? []) if (p.default !== undefined) out[p.name] = p.default;
  return { ...out, ...(provided ?? {}) };
}

export class TaskRunner {
  private readonly runs = new Map<string, ActiveRun>();

  constructor(private readonly deps: TaskRunnerDeps) {}

  private key(slug: string, runId: string): string {
    return `${slug}:${runId}`;
  }

  /** Load + validate a task's yaml and start a run. Throws if the task is missing or invalid. */
  run(slug: string, opts: RunOptions = {}): RunSnapshot {
    const loaded = loadTaskSpec(this.deps.workspaceRoot, slug);
    if (!loaded?.spec) throw new Error(`Task "${slug}" not found or has no valid task.yaml`);
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
          throw new Error(
            `Task "${slug}" already has an active run (${snap.runId}) on this orchestrator; stop it before starting another.`,
          );
        }
      }
    }
    const runId = opts.runId ?? (this.deps.genRunId ? this.deps.genRunId() : `run-${Date.now()}`);
    const run = new ActiveRun(
      loaded.spec,
      slug,
      runId,
      { ...opts, params: resolveParams(loaded.spec, opts.params), verifyOnComplete: opts.verifyOnComplete ?? true },
      this.deps,
    );
    this.runs.set(this.key(slug, runId), run);
    try {
      run.start();
    } catch (error) {
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
    if (log.length === 0) throw new Error(`Cannot resume "${slug}:${runId}": no run-log found`);
    const snapshottedSpec = readRunSpecSnapshot(this.deps.workspaceRoot, slug, runId);
    const loaded = snapshottedSpec ? null : loadTaskSpec(this.deps.workspaceRoot, slug);
    const spec = snapshottedSpec ?? loaded?.spec;
    if (!spec || (loaded !== null && !loaded.valid)) {
      throw new Error(`Cannot resume "${slug}:${runId}": immutable run snapshot and valid task.yaml are both unavailable`);
    }
    this.assertSpecAdmissible(spec, slug);
    const persistedStatus = persistedRunStatus(log);
    if (isTerminalRunStatus(persistedStatus)) {
      throw new Error(`Cannot resume terminal run "${slug}:${runId}" (${persistedStatus})`);
    }
    const started = log.find((e) => e.kind === 'run-started');
    const orchestratorSessionId = started && started.kind === 'run-started' ? started.orchestratorSessionId : undefined;
    const context = readRunContextSnapshot(this.deps.workspaceRoot, slug, runId);
    const run = new ActiveRun(
      spec,
      slug,
      runId,
      {
        orchestratorSessionId,
        params: context?.params ?? resolveParams(spec),
        verifyOnComplete: context?.verifyOnComplete ?? true,
      },
      this.deps,
    );
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
        if (this.runs.has(this.key(slug, runId))) continue;
        const log = readRunLog(this.deps.workspaceRoot, slug, runId);
        if (log.length === 0) continue;
        const status = persistedRunStatus(log);
        if (isTerminalRunStatus(status)) continue;
        recovered.push(this.rehydrate(slug, runId, status !== 'paused'));
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
      if (run.enforceKillSwitch()) stopped += 1;
    }
    return stopped;
  }

  listPendingApprovals(slug?: string, runId?: string): PendingTaskApproval[] {
    const approvals: PendingTaskApproval[] = [];
    for (const run of this.runs.values()) {
      const snapshot = run.snapshot();
      if (slug && snapshot.slug !== slug) continue;
      if (runId && snapshot.runId !== runId) continue;
      approvals.push(...run.pendingApprovalList());
    }
    return approvals.sort((a, b) => a.requestId.localeCompare(b.requestId));
  }

  resolveApproval(
    slug: string,
    runId: string,
    requestId: string,
    decision: 'approved' | 'rejected',
    actor: string,
    comment?: string,
  ): RunSnapshot {
    let run = this.runs.get(this.key(slug, runId));
    if (!run) {
      this.rehydrate(slug, runId, false);
      run = this.runs.get(this.key(slug, runId));
    }
    if (!run) throw new Error(`No mission run ${slug}:${runId}`);
    run.resolveApproval(requestId, decision, actor, comment);
    return run.snapshot();
  }

  getRunState(slug: string, runId: string): RunSnapshot | null {
    return this.runs.get(this.key(slug, runId))?.snapshot() ?? null;
  }

  /** Await a run reaching a terminal state (completed/failed/stopped). */
  waitUntilSettled(slug: string, runId: string): Promise<RunSnapshot> {
    const run = this.runs.get(this.key(slug, runId));
    if (!run) return Promise.reject(new Error(`No active run ${slug}:${runId}`));
    return run.waitUntilSettled();
  }

  private assertSpecAdmissible(spec: TaskSpec, slug: string): void {
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
      throw new Error(
        `Refusing to run task "${slug}": hard cost budgets require USD provider measurements; ${spec.mission.budget.currency} conversion is unavailable`,
      );
    }
    const killSwitch = this.deps.getKillSwitch?.();
    if (killSwitch) {
      const decision = evaluateKillSwitch(killSwitch, this.deps.workspaceId, spec.id);
      if (!decision.allowed) {
        throw new Error(`Refusing to run task "${slug}": ${decision.reason}`);
      }
    }
  }
}
