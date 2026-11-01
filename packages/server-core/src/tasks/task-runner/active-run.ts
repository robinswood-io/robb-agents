import type { SessionCompletionEvent } from "../../sessions/SessionManager";
import { type TaskSpec, type TaskNode, type NodeOutput, type RunLogEntry, materializeDeps, DEFAULT_REPAIR_ATTEMPTS, MAX_REPAIR_ATTEMPTS_CAP, type GuardDecision } from "@craft-agent/shared/tasks";
import { DEFAULT_MAX_PARALLEL } from "./shared.ts";
import type { TaskRunnerDeps, TaskFailureClass, RunOptions, RunStatus, TerminalIntent, RunSnapshot, PendingTaskApproval, RunLogEntryInput, NodeStateEntry, UsageIssue } from "./shared.ts";
import type { RepairReflection, ReviewerContract } from "./review.ts";
import type { ActiveRunActiveCreations, ActiveRunBuildPromptResult, ActiveRunSchedulingBudgetBreachResult, ActiveRunSetTerminalIntentIntentPayload } from './active-run/protocol.ts';
import * as activeRunLifecycle from './active-run/lifecycle.ts';
import * as activeRunHydration from './active-run/hydration.ts';
import * as activeRunScheduling from './active-run/scheduling.ts';
import * as activeRunDispatch from './active-run/dispatch.ts';
import * as activeRunSettlement from './active-run/settlement.ts';
import * as activeRunVerification from './active-run/verification.ts';
import * as activeRunVerdict from './active-run/verdict.ts';
import * as activeRunReviewerContract from './active-run/reviewer-contract.ts';
import * as activeRunReviewerRetirement from './active-run/reviewer-retirement.ts';
import * as activeRunBudget from './active-run/budget.ts';
import * as activeRunDrainage from './active-run/drainage.ts';
import * as activeRunRuntime from './active-run/runtime.ts';

// ---------------------------------------------------------------------------
// ActiveRun — a single run's state machine
// ---------------------------------------------------------------------------
export class ActiveRun {
    private readonly state = new Map<string, NodeStateEntry>();
    private readonly sessionToNode = new Map<string, string>();
    private readonly outputs: Record<string, NodeOutput> = {};
    /** @internal */ public readonly edges: Map<string, Set<string>>;
    /** @internal */ public readonly maxParallel: number;
    private inFlight = 0;
    private tokensUsed = 0;
    private costUsed = 0;
    /** Last observed cumulative (input+output) tokens per child session — for delta accounting. */
    /** @internal */ public readonly sessionTokens = new Map<string, number>();
    /** Last observed cumulative USD cost per child session — for delta accounting. */
    /** @internal */ public readonly sessionCosts = new Map<string, number>();
    /** @internal */ public readonly invalidUsageSessions = new Set<string>();
    private readonly nodeTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
    /** A timed-out attempt remains a terminality barrier until the host proves
     * that exact child idle or a durable whole-run drain takes ownership. */
    private readonly timeoutRetirements = new Set<string>();
    private readonly retryTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
    /** Session creations are tracked until their returned identity is durably
     * logged, so terminal drainage cannot miss a concurrently-created child. */
    private readonly activeCreations = new Set<Promise<ActiveRunActiveCreations>>();
    private deadlineTimeout?: ReturnType<typeof setTimeout> | undefined;
    /** @internal */ public readonly approvedNodes = new Set<string>();
    /** @internal */ public readonly pendingApprovals = new Map<string, PendingTaskApproval>();
    private runStatus: RunStatus = 'running';
    private unsubscribe?: (() => void) | undefined;
    /** Detaches the one-shot independent-reviewer listener while a run is `verifying`. */
    private verdictOff?: (() => void) | undefined;
    /** Exact reviewer identity is persisted alongside its bounded response. */
    private reviewerSessionId?: string | undefined;
    /** Every discovered reviewer candidate remains durable until strong
     * retirement succeeds. This also covers create-before-output crash windows. */
    private readonly pendingReviewerSessionIds = new Set<string>();
    private reviewerPending = false;
    private reviewerTimeout?: ReturnType<typeof setTimeout> | undefined;
    /** @internal */ public reviewerContract?: ReviewerContract | undefined;
    /** Serializes format-only follow-ups behind the provider turn whose
     * completion callback requested them. SessionManager emits completion before
     * its send transaction promise has fully unwound. */
    /** @internal */ public reviewerSend?: Promise<void> | undefined;
    /** A terminal reviewer failure is not published until the child is proven
     * idle and its final cumulative usage has been accounted. */
    private reviewerFailure?: Promise<void> | undefined;
    /** Durable terminal intent plus the exact worker identities that must be
     * proven idle before a failed/stopped state can be published. */
    private terminalIntent?: TerminalIntent | undefined;
    /** The in-process strong-retirement barrier. A rejected barrier remains
     * retryable from stop() and from crash recovery via terminalIntent. */
    private terminalDrain?: Promise<void> | undefined;
    /** @internal */ public terminalRetirementAttempts = 0;
    private terminalRetryTimeout?: ReturnType<typeof setTimeout> | undefined;
    /** Pause uses the same strong worker fence but remains non-terminal. Resume is
     * deferred until this barrier succeeds, preventing duplicate live attempts. */
    private pauseDrain?: Promise<void> | undefined;
    private pauseDrainRequired = false;
    /** @internal */ public pauseRetirementAttempts = 0;
    private pauseRetryTimeout?: ReturnType<typeof setTimeout> | undefined;
    private hydrationWorkerDrain?: Promise<void> | undefined;
    private pausedSessionIds: string[] = [];
    private resumeRequested = false;
    /** An `invalid` persisted result is a failed/format-only attempt, never a
     * late receipt that recovery may promote to an accepted verdict. */
    /** @internal */ public recoveredReviewerResultReusable = true;
    /** Invalidates async reviewer callbacks after stop, restart, or finalization. */
    private verificationGeneration = 0;
    /** FAIL verdicts that have triggered a repair pass (bounded by `maxRepairs`). */
    /** @internal */ public repairsUsed = 0;
    /** Malformed-verdict re-asks issued (bounded by MAX_UNPARSED_REASKS); not a repair. */
    /** @internal */ public unparsedReAsks = 0;
    /** Resolved repair cap = min(spec.max_iterations ?? DEFAULT, CAP). */
    /** @internal */ public readonly maxRepairs: number;
    /** Bounded, verifier-grounded episodic memory injected into later repair attempts. */
    /** @internal */ public readonly reflectionHistory: RepairReflection[] = [];
    /** Rejected result hashes seen in this run, used to detect fixed points and short cycles. */
    /** @internal */ public readonly rejectedFingerprints = new Set<string>();
    /** Consecutive rejected results that revisit an already-seen result fingerprint. */
    /** @internal */ public stagnantRepeats = 0;
    /** Inverted edges: node id → set of nodes that (directly) depend on it. Built lazily for the frontier. */
    /** @internal */ public dependents?: Map<string, Set<string>> | undefined;
    private settled = false;
    private settleResolvers: ((s: RunSnapshot) => void)[] = [];
    constructor(private readonly spec: TaskSpec, private readonly slug: string, private readonly runId: string, private readonly opts: Omit<RunOptions, 'verifyOnComplete'> & { verifyOnComplete: boolean }, private readonly deps: TaskRunnerDeps) {
        this.edges = materializeDeps(spec);
        this.maxParallel = spec.max_parallel ?? deps.defaultMaxParallel ?? DEFAULT_MAX_PARALLEL;
        // Runner-side clamp (belt-and-suspenders: the schema already caps `max_iterations` at the same
        // bound, so a parsed spec can't exceed it — but a programmatically built spec might).
        this.maxRepairs = Math.min(spec.max_iterations ?? DEFAULT_REPAIR_ATTEMPTS, MAX_REPAIR_ATTEMPTS_CAP);
        for (const node of spec.nodes)
            this.state.set(node.id, { state: 'pending', attempt: 0 });
    }
    start(): void {
        return activeRunLifecycle.start(this);
    }
    pause(): void {
        return activeRunLifecycle.pause(this);
    }
    resume(): void {
        return activeRunLifecycle.resume(this);
    }
    private resumeAfterPauseDrain(): void {
        return activeRunLifecycle.resumeAfterPauseDrain(this);
    }
    hydrate(log: RunLogEntry[], loadOutput: (nodeId: string) => NodeOutput | null): void {
        return activeRunHydration.hydrate(this, log, loadOutput);
    }
    activateHydrated(shouldResume: boolean): void {
        return activeRunHydration.activateHydrated(this, shouldResume);
    }
    /** @internal */ public async resumeAfterRecoveredWorkerDrain(sessionIds: string[]): Promise<void> {
        return activeRunHydration.resumeAfterRecoveredWorkerDrain(this, sessionIds);
    }
    /** @internal */ public continueHydratedResume(): void {
        return activeRunHydration.continueHydratedResume(this);
    }
    async stop(): Promise<void> {
        return activeRunLifecycle.stop(this);
    }
    waitUntilSettled(): Promise<RunSnapshot> {
        return activeRunLifecycle.waitUntilSettled(this);
    }
    snapshot(): RunSnapshot {
        return activeRunLifecycle.snapshot(this);
    }
    enforceKillSwitch(): boolean {
        return activeRunLifecycle.enforceKillSwitch(this);
    }
    private scheduleReady(): void {
        return activeRunScheduling.scheduleReady(this);
    }
    private isReady(node: TaskNode): boolean {
        return activeRunScheduling.isReady(this, node);
    }
    /** @internal */ public markRunning(node: TaskNode): void {
        return activeRunScheduling.markRunning(this, node);
    }
    /** @internal */ public requiresApproval(node: TaskNode): boolean {
        return activeRunScheduling.requiresApproval(this, node);
    }
    /** @internal */ public requestApproval(node: TaskNode): void {
        return activeRunScheduling.requestApproval(this, node);
    }
    /** @internal */ public completeApprovalNode(node: TaskNode): void {
        return activeRunScheduling.completeApprovalNode(this, node);
    }
    pendingApprovalList(): PendingTaskApproval[] {
        return activeRunScheduling.pendingApprovalList(this);
    }
    resolveApproval(requestId: string, decision: 'approved' | 'rejected', actor: string, comment?: string): void {
        return activeRunScheduling.resolveApproval(this, requestId, decision, actor, comment);
    }
    /** @internal */ public async dispatch(node: TaskNode): Promise<void> {
        return activeRunDispatch.dispatch(this, node);
    }
    /** @internal */ public async buildPrompt(node: TaskNode): Promise<ActiveRunBuildPromptResult> {
        return activeRunDispatch.buildPrompt(this, node);
    }
    /** @internal */ public buildReflectionMemory(nodeId: string): string {
        return activeRunDispatch.buildReflectionMemory(this, nodeId);
    }
    private accountSessionUsage(evt: SessionCompletionEvent): UsageIssue | null {
        return activeRunBudget.accountSessionUsage(this, evt);
    }
    private failForUsageIssue(issue: UsageIssue): void {
        return activeRunBudget.failForUsageIssue(this, issue);
    }
    private onSessionComplete(evt: SessionCompletionEvent): void {
        return activeRunSettlement.onSessionComplete(this, evt);
    }
    private failNode(nodeId: string, reason: string, sessionId?: string, allowRetry = true, failureClass: TaskFailureClass = 'error'): void {
        return activeRunSettlement.failNode(this, nodeId, reason, allowRetry, failureClass, sessionId);
    }
    /** @internal */ public maybeFinish(): void {
        return activeRunSettlement.maybeFinish(this);
    }
    private enterVerifying(): void {
        return activeRunSettlement.enterVerifying(this);
    }
    private finish(status: RunStatus): void {
        return activeRunSettlement.finish(this, status);
    }
    private finalize(): void {
        return activeRunSettlement.finalize(this);
    }
    private async sendVerification(generation: number): Promise<void> {
        return activeRunVerification.sendVerification(this, generation);
    }
    /** @internal */ public attachVerdictListener(reviewerSessionId: string, generation: number): void {
        return activeRunVerification.attachVerdictListener(this, reviewerSessionId, generation);
    }
    /** @internal */ public async sendToReviewer(reviewerSessionId: string, message: string, generation: number, timeoutMs: number, authenticatedTaskText?: string): Promise<void> {
        return activeRunVerification.sendToReviewer(this, reviewerSessionId, message, generation, timeoutMs, authenticatedTaskText);
    }
    /** @internal */ public handleVerdict(text: string, reviewerSessionId: string): void {
        return activeRunVerdict.handleVerdict(this, text, reviewerSessionId);
    }
    /** @internal */ public recordRepairReflection(reason: string, named?: string[]): RepairReflection {
        return activeRunVerdict.recordRepairReflection(this, reason, named);
    }
    /** @internal */ public async reAskVerdict(reviewerSessionId: string, parseFailure?: string, previousResponse = ''): Promise<void> {
        return activeRunVerdict.reAskVerdict(this, reviewerSessionId, previousResponse, parseFailure);
    }
    /** @internal */ public createReviewerContract(reviewerSessionId: string): ReviewerContract {
        return activeRunReviewerContract.createReviewerContract(this, reviewerSessionId);
    }
    /** @internal */ public buildReviewerPrompt(contract: ReviewerContract): string {
        return activeRunReviewerContract.buildReviewerPrompt(this, contract);
    }
    private persistReviewerOutput(reviewerSessionId: string | undefined, reviewerState: 'pending' | 'invalid' | 'pass' | 'fail', response: string, parseFailure?: string, pendingEvidence?: string): void {
        return activeRunReviewerContract.persistReviewerOutput(this, reviewerSessionId, reviewerState, response, parseFailure, pendingEvidence);
    }
    private persistReviewerCandidateIds(): void {
        return activeRunReviewerContract.persistReviewerCandidateIds(this);
    }
    private isCurrentVerification(generation: number): boolean {
        return activeRunReviewerRetirement.isCurrentVerification(this, generation);
    }
    private isCurrentReviewer(reviewerSessionId: string, generation: number): boolean {
        return activeRunReviewerRetirement.isCurrentReviewer(this, reviewerSessionId, generation);
    }
    /** @internal */ public settleReviewerSession(reviewerSessionId: string, acceptedResult: boolean): void {
        return activeRunReviewerRetirement.settleReviewerSession(this, reviewerSessionId, acceptedResult);
    }
    private failReviewer(reviewerSessionId: string | undefined, reason: string): void {
        return activeRunReviewerRetirement.failReviewer(this, reviewerSessionId, reason);
    }
    /** @internal */ public async retirePendingReviewer(initialSessionIds: string[] = []): Promise<SessionCompletionEvent | undefined> {
        return activeRunReviewerRetirement.retirePendingReviewer(this, initialSessionIds);
    }
    /** @internal */ public armReviewerTimeout(reviewerSessionId: string, generation: number, timeoutMs: number): void {
        return activeRunReviewerRetirement.armReviewerTimeout(this, reviewerSessionId, generation, timeoutMs);
    }
    private clearReviewerTimeout(): void {
        return activeRunReviewerRetirement.clearReviewerTimeout(this);
    }
    /** @internal */ public repairForVerdict(reason: string | undefined, named?: string[]): void {
        return activeRunVerdict.repairForVerdict(this, reason, named);
    }
    /** @internal */ public computeFrontier(named?: string[]): Set<string> {
        return activeRunRuntime.computeFrontier(this, named);
    }
    /** @internal */ public dependentsMap(): Map<string, Set<string>> {
        return activeRunRuntime.dependentsMap(this);
    }
    /** @internal */ public tokenBudgetLimit(): number | undefined {
        return activeRunBudget.tokenBudgetLimit(this);
    }
    /** @internal */ public costBudgetLimit(): number | undefined {
        return activeRunBudget.costBudgetLimit(this);
    }
    /** @internal */ public schedulingBudgetBreach(): ActiveRunSchedulingBudgetBreachResult | null {
        return activeRunBudget.schedulingBudgetBreach(this);
    }
    /** @internal */ public measuredBudgetBreach(): ActiveRunSchedulingBudgetBreachResult | null {
        return activeRunBudget.measuredBudgetBreach(this);
    }
    /** @internal */ public failForBudget(metric: 'tokens' | 'cost', value: number, limit: number): void {
        return activeRunBudget.failForBudget(this, metric, value, limit);
    }
    private deadlineExpired(): boolean {
        return activeRunBudget.deadlineExpired(this);
    }
    private armDeadline(): void {
        return activeRunBudget.armDeadline(this);
    }
    private failForDeadline(): void {
        return activeRunBudget.failForDeadline(this);
    }
    private markRunningNodesCancelled(reason: string): void {
        return activeRunDrainage.markRunningNodesCancelled(this, reason);
    }
    private terminalSessionIds(): string[] {
        return activeRunDrainage.terminalSessionIds(this);
    }
    private setTerminalIntent(intent: Omit<TerminalIntent, 'sessionIds' | 'reviewerSessionIds'> & ActiveRunSetTerminalIntentIntentPayload): void {
        return activeRunDrainage.setTerminalIntent(this, intent);
    }
    private beginTerminalDrain(): Promise<void> {
        return activeRunDrainage.beginTerminalDrain(this);
    }
    /** @internal */ public scheduleTerminalDrainRetry(): void {
        return activeRunDrainage.scheduleTerminalDrainRetry(this);
    }
    private beginPauseDrain(): Promise<void> {
        return activeRunDrainage.beginPauseDrain(this);
    }
    /** @internal */ public schedulePauseDrainRetry(): void {
        return activeRunDrainage.schedulePauseDrainRetry(this);
    }
    /** @internal */ public async retireWorkerSessions(initialSessionIds: string[]): Promise<Error[]> {
        return activeRunDrainage.retireWorkerSessions(this, initialSessionIds);
    }
    /** @internal */ public async drainTerminalChildren(initialSessionIds: string[], initialReviewerSessionIds: string[]): Promise<void> {
        return activeRunDrainage.drainTerminalChildren(this, initialSessionIds, initialReviewerSessionIds);
    }
    private hasDeferredRetry(): boolean {
        return activeRunRuntime.hasDeferredRetry(this);
    }
    private isTerminal(): boolean {
        return activeRunRuntime.isTerminal(this);
    }
    private currentTimeMs(): number {
        return activeRunRuntime.currentTimeMs(this);
    }
    private idempotencyKey(nodeId: string): string {
        return activeRunRuntime.idempotencyKey(this, nodeId);
    }
    private currentKillSwitch(): GuardDecision {
        return activeRunRuntime.currentKillSwitch(this);
    }
    private stopForKillSwitch(reason: string): void {
        return activeRunRuntime.stopForKillSwitch(this, reason);
    }
    /** @internal */ public armNodeTimeout(nodeId: string, sessionId: string, attempt: number, timeoutMs: number): void {
        return activeRunRuntime.armNodeTimeout(this, nodeId, sessionId, attempt, timeoutMs);
    }
    /** @internal */ public async retireTimedOutNode(nodeId: string, sessionId: string, timeoutMs: number): Promise<void> {
        return activeRunRuntime.retireTimedOutNode(this, nodeId, sessionId, timeoutMs);
    }
    private clearNodeTimeout(nodeId: string): void {
        return activeRunRuntime.clearNodeTimeout(this, nodeId);
    }
    private armRetry(nodeId: string, retryAtMs: number): void {
        return activeRunRuntime.armRetry(this, nodeId, retryAtMs);
    }
    /** @internal */ public clearRetryTimeout(nodeId: string): void {
        return activeRunRuntime.clearRetryTimeout(this, nodeId);
    }
    /** @internal */ public reportAsyncFailure(operation: string, error: unknown, context: Record<string, unknown> = {}): void {
        return activeRunRuntime.reportAsyncFailure(this, operation, error, context);
    }
    private bestEffortHostMetadata(operation: string, sessionId: string, mutation: () => Promise<void>): void {
        return activeRunRuntime.bestEffortHostMetadata(this, operation, sessionId, mutation);
    }
    private failForUnexpectedAsyncError(operation: string, error: unknown): void {
        return activeRunRuntime.failForUnexpectedAsyncError(this, operation, error);
    }
    private log(entry: RunLogEntryInput): void {
        return activeRunRuntime.log(this, entry);
    }
}
