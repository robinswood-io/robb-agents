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
 * v1 executes `kind: 'session'`, `kind: 'judge'`, and `kind: 'verify'` nodes
 * wired by `depends_on` + `inputs`; read-only review nodes stay Safe and
 * isolated. Remaining control-flow kinds (route/loop/…) parse but are not yet
 * executed (P4).
 *
 * The runner depends on a minimal `ConductorSessionHost` interface (which
 * SessionManager structurally satisfies) so it is unit-testable with a mock.
 */
import type { CreateSessionOptions, FileAttachment, SendMessageOptions } from "@craft-agent/shared/protocol";
import type { StoredAttachment, TokenUsage } from "@craft-agent/core/types";
import { createLogger } from "@craft-agent/shared/utils";
import { type ExecutionProofVerificationDecision, type SignedExecutionProof, type TaskExecutionProofBinding } from "@craft-agent/shared/governance";
import type { SessionCompletionEvent } from "../../sessions/SessionManager";
import { type SubagentAutonomyContext } from "../../subagents/autonomy-inheritance.ts";
import { type TaskNodeExecutionRoute, type TaskNodeRouteContext, type TaskModelSettings } from "../task-node-execution";
import { type TaskSpec, type TaskNode, type RunLogEntry, type NodeRunState, type ExecutionIsolationPolicy, type GuardDecision, type KillSwitchSnapshot } from "@craft-agent/shared/tasks";

export const taskRunnerLog = createLogger('task-runner');

// ---------------------------------------------------------------------------
// Host interface (SessionManager satisfies this structurally)
// ---------------------------------------------------------------------------
export interface ConductorSessionHost {
    /** Creates the child session AND announces it to the renderer (createSession emits
     *  session_created by default), so the subtask appears on the board with its real title. */
    createSession(workspaceId: string, options: CreateSessionOptions): Promise<{
        id: string;
    }>;
    sendMessage(sessionId: string, message: string, attachments?: FileAttachment[], storedAttachments?: StoredAttachment[], options?: SendMessageOptions): Promise<void>;
    setSessionStatus(sessionId: string, status: string): Promise<void>;
    setKanbanColumn(sessionId: string, column: string | null): Promise<void>;
    /** Records the total DAG node count on the orchestrator session for a stable board progress denominator. */
    setTaskNodeCount(sessionId: string, count: number): Promise<void>;
    cancelProcessing(sessionId: string, silent?: boolean): Promise<void>;
    /** Stop a session and resolve only once the host has published it idle. */
    cancelProcessingAndWait(sessionId: string, timeoutMs: number): Promise<SessionCompletionEvent>;
    /** Discover durable reviewer envelopes, including one created just before a process crash. */
    listTaskReviewerSessions(workspaceId: string, taskSlug: string, taskRunId: string, parentSessionId: string): Array<{
        id: string;
        isProcessing: boolean;
        tokenUsage?: TokenUsage;
        finalText?: string;
    }>;
    /** Discover host-persisted worker envelopes, including a child created just
     * before the runner could append node-spawned. */
    listTaskWorkerSessions(workspaceId: string, taskSlug: string, taskRunId: string): Array<{
        id: string;
        isProcessing: boolean;
        tokenUsage?: TokenUsage;
        finalText?: string;
    }>;
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
    /** Live kill-switch state. Evaluated before every scheduling pass and required fail-closed. */
    getKillSwitch: () => KillSwitchSnapshot;
    /** Reports one corrupt/unrecoverable durable run without aborting recovery of the others. */
    onRecoveryError?: (context: {
        slug: string;
        runId: string;
        error: Error;
    }) => void;
    /**
     * Host-side admission hook for connector/sandbox enforcement. The prompt
     * receives the same policy, but this hook is the authoritative boundary.
     */
    executionGuard?: (context: TaskExecutionGuardContext) => GuardDecision | Promise<GuardDecision>;
    /** Read only the explicit parent/workspace model settings; retries reuse their saved values. */
    getModelDefaults?: (parentSessionId?: string, selectedConnectionSlug?: string) => TaskModelSettings | Promise<TaskModelSettings>;
    /** Private policy-aware adaptive route. Explicit node/task settings remain authoritative. */
    resolveNodeRoute?: (context: TaskNodeRouteContext) => TaskNodeExecutionRoute | Promise<TaskNodeExecutionRoute>;
    /** Bounded fallback retry used when neither the node nor task defaults declare one. */
    defaultRetry?: TaskRetryPolicy;
    /** Authoritative verification seam for provider-reconciled external mutations. */
    verifyExecutionProof?: (proof: SignedExecutionProof, binding: TaskExecutionProofBinding) => ExecutionProofVerificationDecision;
    /**
     * Live parent/workspace autonomy authority. Production resolves this from
     * the orchestrator session plus workspace config; omission fails closed.
     */
    resolveSubagentAutonomyContext?: (parentSessionId?: string) => SubagentAutonomyContext;
}

export type TaskFailureClass = 'error' | 'empty' | 'invalid';

export interface TaskRetryPolicy {
    limit: number;
    backoff?: {
        base?: number;
        factor?: number;
        max?: number;
    };
    when?: TaskFailureClass | TaskFailureClass[];
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
    /** Deliberate Execute + allow-in-execute inheritance; never inferred from the task spec alone. */
    fullAutonomyInherited: boolean;
    /** Host-authenticated judge/verifier role whose read effect must remain Safe and isolated. */
    reviewOnly: boolean;
    /** True when the spec explicitly requested host CPU or memory isolation. */
    resourceLimitsExplicit: boolean;
}

export interface RunOptions {
    /** The task's persistent parent/orchestrator session (reviewers are separate children). */
    orchestratorSessionId?: string | undefined;
    /** Resolved task param values (merged over the spec's declared defaults). */
    params?: Record<string, unknown> | undefined;
    /** Explicit run id (otherwise generated). */
    runId?: string | undefined;
    /** When the run completes, launch an independent reviewer child. Default true. */
    verifyOnComplete?: boolean | undefined;
    /** Confirmed outputs copied from an earlier run before scheduling a targeted repair. */
    replay?: {
        sourceRunId: string;
        externalMutationsApproved: boolean;
        reusedNodes: Array<{
            nodeId: string;
            proofHash?: string;
        }>;
    } | undefined;
}

export type RunStatus = 'running' | 'paused' | 'waiting-approval' | 'verifying' | 'stopped' | 'completed' | 'failed';

export interface TerminalIntent {
    target: 'failed' | 'stopped';
    cause: 'budget' | 'deadline' | 'kill-switch' | 'operator' | 'timeout' | 'recovery' | 'reviewer';
    sessionIds: string[];
    reviewerSessionIds: string[];
    reason?: string;
    scope?: 'global' | 'workspace' | 'mission';
}

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
    /** Durable task folder identifier required to resolve from a global inbox. */
    slug: string;
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
export const DEFAULT_MAX_PARALLEL = 4;

/** Production default: two fresh attempts after a transient error or empty declared output. */
export const DEFAULT_AUTONOMOUS_RETRY_POLICY: TaskRetryPolicy = {
    limit: 2,
    backoff: { base: 250, factor: 2, max: 2000 },
    when: ['error', 'empty'],
};

export const RUNNING_STATUS = 'in-progress';

export const DONE_STATUS = 'done';

// There is no 'failed' session status (the fixed set is todo|in-progress|needs-review|done|cancelled).
// We flag a failed child as 'needs-review' (amber, attention needed); the board's 'failed' run-state
// is derived from the run-log, not from a session status.
export const FAILED_STATUS = 'needs-review';

export const MAX_TIMER_DELAY_MS = 2147483647;

export const PAUSE_RETIRE_RETRY_BASE_MS = 100;

export const PAUSE_RETIRE_RETRY_MAX_MS = 5000;

export const TERMINAL_RETIRE_RETRY_BASE_MS = 100;

export const TERMINAL_RETIRE_RETRY_MAX_MS = 5000;

/** Distributive Omit so the run-log discriminated union keeps its per-variant fields. */
export type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export type RunLogEntryInput = DistributiveOmit<RunLogEntry, 't'>;

export interface NodeStateEntry {
    state: NodeRunState;
    sessionId?: string;
    attempt: number;
    /** Durable not-before timestamp for the next retry attempt. */
    retryAtMs?: number;
    /** Reason the previous attempt failed, fed back into the retry prompt (failure-aware retry). */
    lastFailure?: string;
    /** Last explicit settings, preserved across retries and process restarts. */
    lastRoute?: TaskModelSettings;
}

export type UsageIssue = {
    metric: 'tokens' | 'cost';
    value: number;
    limit: number;
} | {
    metric: 'invalid';
    reason: string;
};

// ---------------------------------------------------------------------------
// TaskRunner — registry/service over active runs
// ---------------------------------------------------------------------------
/**
 * Prefix for dispatched child prompts carrying the task's skill list as [skill:slug]
 * mentions. The agent pipeline (base-agent) parses these from any message, resolves each
 * skill's SKILL.md, and blocks tool use until the files are read — so task-level skills
 * act as mandatory context for every subtask. Empty/absent skills → empty prefix.
 */
export function skillsPreamble(skills: string[] | undefined): string {
    if (!skills?.length)
        return '';
    return `Apply these skills: ${skills.map((s) => `[skill:${s}]`).join(' ')}\n\n`;
}

export function resolveIsolationPolicy(spec: TaskSpec, defaultRoot: string): ExecutionIsolationPolicy {
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

export function executionPreamble(policy: ExecutionIsolationPolicy, idempotencyKey: string): string {
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

export function inheritedAutonomyPreamble(idempotencyKey: string): string {
    return [
        '[Inherited execution policy]',
        `Idempotency key: ${idempotencyKey}`,
        'The parent is in Execute mode and this workspace explicitly allows external actions in Execute.',
        'Use the ordinary session tools, active sources, browser, shell, and network needed to complete the assignment.',
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
export function retryMatches(when: TaskFailureClass | TaskFailureClass[] | undefined, failure: TaskFailureClass): boolean {
    const configured = when ?? 'error';
    return Array.isArray(configured) ? configured.includes(failure) : configured === failure;
}

/** Resolve exponential retry delay in milliseconds; an omitted backoff keeps legacy immediate retry. */
export function retryDelayMs(backoff: {
    base?: number | undefined;
    factor?: number | undefined;
    max?: number | undefined;
} | undefined, failedAttempt: number): number {
    if (!backoff)
        return 0;
    const base = backoff.base ?? 1000;
    const factor = backoff.factor ?? 2;
    const maximum = backoff.max ?? 30000;
    return Math.min(maximum, base * factor ** Math.max(0, failedAttempt - 1));
}

/** A run is terminal (no further work) once completed/failed/stopped. running/paused/verifying are active. */
export function isTerminalRunStatus(status: RunStatus): boolean {
    return status === 'completed' || status === 'failed' || status === 'stopped';
}

export function persistedRunStatus(log: RunLogEntry[]): RunStatus {
    let status: RunStatus = 'running';
    for (const entry of log) {
        if (entry.kind === 'run-paused')
            status = 'paused';
        else if (entry.kind === 'run-resumed' || entry.kind === 'run-started')
            status = 'running';
        else if (entry.kind === 'run-verifying')
            status = 'verifying';
        else if (entry.kind === 'approval-requested')
            status = 'waiting-approval';
        else if (entry.kind === 'approval-resolved')
            status = 'running';
        else if (entry.kind === 'run-completed')
            status = 'completed';
        else if (entry.kind === 'run-failed')
            status = 'failed';
        else if (entry.kind === 'run-stopped' || entry.kind === 'kill-switch')
            status = 'stopped';
    }
    return status;
}

export function resolveParams(spec: TaskSpec, provided?: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const p of spec.params ?? [])
        if (p.default !== undefined)
            out[p.name] = p.default;
    return { ...out, ...(provided ?? {}) };
}
