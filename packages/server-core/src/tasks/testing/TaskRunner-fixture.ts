import { Buffer } from "node:buffer";
import type { StoredAttachment, TokenUsage } from "@craft-agent/core/types";
import type { CreateSessionOptions, FileAttachment, SendMessageOptions } from "@craft-agent/shared/protocol";
import { type SignedExecutionProof } from "@craft-agent/shared/governance";
import { parseTaskSpec, type TaskSpec } from "@craft-agent/shared/tasks";
import type { SessionCompletionEvent } from "../../sessions/SessionManager";
import { type ConductorSessionHost } from "../TaskRunner";



// Flush pending microtasks so the runner's async dispatch (create → column → send) settles.
export const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export const inactiveKillSwitch = () => ({ global: false, workspaceIds: [], missionIds: [] });


export async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}


export function tu(inputTokens: number, outputTokens: number, costUsd = 0): TokenUsage {
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, contextTokens: 0, costUsd };
}


export function specOf(raw: unknown): TaskSpec {
  const r = parseTaskSpec(raw);
  if (!r.success) throw new Error('bad fixture: ' + JSON.stringify(r.error.issues));
  return r.data;
}


/** Mock host: records calls; the test drives completions via complete(). */
export class MockHost implements ConductorSessionHost {
  // A Set, mirroring SessionManager — the Conductor keeps its main subscription AND a one-shot
  // independent-reviewer listener attached at the same time while a run is `verifying`.
  private readonly listeners = new Set<(evt: SessionCompletionEvent) => void>();
  readonly created: { id: string; options: CreateSessionOptions }[] = [];
  readonly sent: { sessionId: string; message: string; options?: SendMessageOptions }[] = [];
  readonly statuses: { sessionId: string; status: string }[] = [];
  readonly statusById = new Map<string, string>();
  readonly columns: { sessionId: string; column: string | null }[] = [];
  readonly nodeCounts: { sessionId: string; count: number }[] = [];
  readonly cancelled: string[] = [];
  readonly finalTextById = new Map<string, string>();
  readonly processing = new Set<string>();
  readonly tokenUsageById = new Map<string, TokenUsage>();

  async createSession(_workspaceId: string, options: CreateSessionOptions): Promise<{ id: string }> {
    const id = `sess-${options.name}`;
    this.created.push({ id, options });
    return { id };
  }
  async sendMessage(
    sessionId: string,
    message: string,
    _attachments?: FileAttachment[],
    _storedAttachments?: StoredAttachment[],
    options?: SendMessageOptions,
  ): Promise<void> {
    this.sent.push({ sessionId, message, options });
    this.processing.add(sessionId);
  }
  async setSessionStatus(sessionId: string, status: string): Promise<void> {
    this.statuses.push({ sessionId, status });
    this.statusById.set(sessionId, status);
  }
  async setKanbanColumn(sessionId: string, column: string | null): Promise<void> {
    this.columns.push({ sessionId, column });
  }
  async setTaskNodeCount(sessionId: string, count: number): Promise<void> {
    this.nodeCounts.push({ sessionId, count });
  }
  async cancelProcessing(sessionId: string, _silent?: boolean): Promise<void> {
    this.cancelled.push(sessionId);
    this.processing.delete(sessionId);
  }
  async cancelProcessingAndWait(sessionId: string): Promise<SessionCompletionEvent> {
    await this.cancelProcessing(sessionId, true);
    return {
      sessionId,
      workspaceId: 'ws',
      reason: 'interrupted',
      finalText: this.finalTextById.get(sessionId),
      tokenUsage: this.tokenUsageById.get(sessionId),
    };
  }
  listTaskReviewerSessions(
    _workspaceId: string,
    taskSlug: string,
    taskRunId: string,
    parentSessionId: string,
  ) {
    return this.created
      .filter(entry => entry.options.taskSlug === taskSlug
        && entry.options.taskRunId === taskRunId
        && entry.options.taskNodeId === '__verdict__'
        && entry.options.missionRole === 'reviewer'
        && entry.options.parentSessionId === parentSessionId
        && (this.statusById.get(entry.id) ?? entry.options.sessionStatus) === 'in-progress')
      .map(entry => ({
        id: entry.id,
        isProcessing: this.processing.has(entry.id),
        tokenUsage: this.tokenUsageById.get(entry.id),
        finalText: this.finalTextById.get(entry.id),
      }));
  }
  listTaskWorkerSessions(_workspaceId: string, taskSlug: string, taskRunId: string) {
    return this.created
      .filter(entry => entry.options.taskSlug === taskSlug
        && entry.options.taskRunId === taskRunId
        && !!entry.options.taskNodeId
        && entry.options.taskNodeId !== '__verdict__'
        && ((this.statusById.get(entry.id) ?? entry.options.sessionStatus) === 'in-progress'
          || this.processing.has(entry.id)))
      .map(entry => ({
        id: entry.id,
        isProcessing: this.processing.has(entry.id),
        tokenUsage: this.tokenUsageById.get(entry.id),
        finalText: this.finalTextById.get(entry.id),
      }));
  }
  onSessionComplete(listener: (evt: SessionCompletionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  getSessionFinalText(sessionId: string): string | undefined {
    return this.finalTextById.get(sessionId);
  }
  workingDirById = new Map<string, string>();
  getSessionWorkingDirectory(sessionId: string): string | undefined {
    return this.workingDirById.get(sessionId);
  }

  // --- test helpers (sessionId is derived from the node title, which defaults to the node id) ---
  sessionIdFor(nodeId: string): string {
    return `sess-${nodeId}`;
  }
  promptFor(nodeId: string): string | undefined {
    return this.sent.find((s) => s.sessionId === this.sessionIdFor(nodeId))?.message;
  }
  dispatchedNames(): string[] {
    return this.created.map((c) => c.options.name!).filter(Boolean);
  }
  reviewerSessionId(): string {
    const reviewer = this.created
      .filter((entry) => entry.options.taskRunId && entry.options.missionRole === 'reviewer'
        && entry.options.taskNodeId === '__verdict__')
      .at(-1);
    if (!reviewer) throw new Error('reviewer session was not created');
    return reviewer.id;
  }
  completeReview(
    result: 'pass' | 'fail',
    reason = result === 'pass' ? 'Acceptance criteria verified.' : 'Acceptance criteria not met.',
    nodes: string[] = [],
    tokenUsage?: TokenUsage,
  ): void {
    const reviewerSessionId = this.reviewerSessionId();
    const prompt = this.sent
      .filter(entry => entry.sessionId === reviewerSessionId)
      .map(entry => entry.message)
      .filter(message => message.includes('<host_parent_review_contract>'))
      .at(-1);
    const contractText = prompt?.match(
      /<host_parent_review_contract>([^<]+)<\/host_parent_review_contract>/,
    )?.[1];
    if (!contractText) throw new Error('reviewer host contract was not sent');
    const contract = JSON.parse(contractText) as {
      objectiveId: string;
      acceptanceSha256: string;
      criteria: string[];
    };
    const encodedContext = prompt?.match(
      /<host_parent_review_context_base64url>([^<]+)<\/host_parent_review_context_base64url>/,
    )?.[1];
    const reviewContext = encodedContext
      ? Buffer.from(encodedContext, 'base64url').toString('utf8')
      : '';
    const mappingText = reviewContext.match(/The receipt criterion mapping is (\[[^\n]+\])\./)?.[1];
    const mapping = mappingText
      ? JSON.parse(mappingText) as Array<{ criterionId: string; nodeId: string }>
      : [];
    const failedNodeCriteria = new Set(mapping
      .filter(entry => nodes.includes(entry.nodeId))
      .map(entry => entry.criterionId));
    const criteria = contract.criteria.map(id => ({
      id,
      passed: result === 'pass'
        || (nodes.length > 0 ? !failedNodeCriteria.has(id) : id !== 'task-outcome'),
    }));
    this.completeSession(this.reviewerSessionId(), {
      finalText: JSON.stringify({
        objectiveId: contract.objectiveId,
        acceptanceSha256: contract.acceptanceSha256,
        verdict: result === 'pass' ? 'PASS' : 'FAIL',
        criteria,
        findings: result === 'pass' ? [] : [reason],
      }),
      tokenUsage,
    });
  }
  completeRawReview(finalText: string): void {
    this.completeSession(this.reviewerSessionId(), { finalText });
  }
  complete(nodeId: string, opts: {
    reason?: SessionCompletionEvent['reason'];
    finalText?: string;
    tokenUsage?: TokenUsage;
    executionProof?: SignedExecutionProof;
  } = {}): void {
    this.completeSession(this.sessionIdFor(nodeId), opts);
  }
  /** Fire a completion for an arbitrary session id (e.g. the orchestrator's verification verdict). */
  completeSession(sessionId: string, opts: {
    reason?: SessionCompletionEvent['reason'];
    finalText?: string;
    tokenUsage?: TokenUsage;
    executionProof?: SignedExecutionProof;
  } = {}): void {
    this.processing.delete(sessionId);
    if (opts.finalText !== undefined) this.finalTextById.set(sessionId, opts.finalText);
    if (opts.tokenUsage) this.tokenUsageById.set(sessionId, opts.tokenUsage);
    const evt: SessionCompletionEvent = {
      sessionId,
      workspaceId: 'ws',
      reason: opts.reason ?? 'complete',
      finalText: opts.finalText,
      tokenUsage: opts.tokenUsage,
      executionProof: opts.executionProof,
    };
    // SessionManager iterates its listener Set live. Tests deliberately mirror
    // that behavior so a listener added by a callback cannot consume the same
    // completion event as a second generation.
    for (const listener of this.listeners) listener(evt);
  }
}


export class UniqueSessionHost extends MockHost {
  private sequence = 0;

  override async createSession(_workspaceId: string, options: CreateSessionOptions): Promise<{ id: string }> {
    this.sequence += 1;
    const id = `sess-${options.name}-${this.sequence}`;
    this.created.push({ id, options });
    return { id };
  }
}


export class PrefixedSessionHost extends MockHost {
  private sequence = 0;

  constructor(private readonly prefix: string) {
    super();
  }

  override async createSession(_workspaceId: string, options: CreateSessionOptions): Promise<{ id: string }> {
    this.sequence += 1;
    const id = `${this.prefix}-${options.name}-${this.sequence}`;
    this.created.push({ id, options });
    return { id };
  }
}
