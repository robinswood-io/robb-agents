import { randomUUID } from 'node:crypto';
import {
  listMissionIds,
  type AgentProfile,
  type MissionAttemptTelemetry,
  type MissionExecutionBinding,
  type MissionSnapshot,
  type MissionWorkItem,
  type StructuredMissionVerdict,
  type WorkSubmission,
} from '@craft-agent/shared/missions';
import { MissionController } from './MissionController.ts';

export interface MissionExecutionInput {
  mission: MissionSnapshot['spec'];
  item: MissionWorkItem;
  profile: AgentProfile;
  dispatchId: string;
  upstream: Array<{
    workItemId: string;
    title: string;
    submission?: WorkSubmission;
  }>;
}

type MissionExecutionOutcome =
  | { status: 'submission'; submission: WorkSubmission }
  | { status: 'verdict'; verdict: StructuredMissionVerdict }
  | {
      status: 'approval-required';
      approvalId: string;
      requestHash: string;
      expiresAt: string;
      operationId: string;
    }
  | {
      status: 'failed';
      reason: string;
      retryable: boolean;
      ambiguousMutation?: boolean;
    };

export type MissionExecutionResult = MissionExecutionOutcome & {
  /** Host-observed metrics. Agent-authored values must never be placed here. */
  telemetry?: MissionAttemptTelemetry;
};

/**
 * Provider/host adapter contract.
 *
 * `prepare` MUST be side-effect free. `execute` MUST be idempotent for one
 * binding and recover an already-started execution instead of starting a
 * duplicate. This makes the durable reservation the write-ahead record.
 */
export interface MissionWorkExecutor {
  prepare(input: MissionExecutionInput): Promise<MissionExecutionBinding>;
  execute(
    input: MissionExecutionInput,
    binding: MissionExecutionBinding,
    lifecycle?: MissionExecutionLifecycle,
  ): Promise<MissionExecutionResult>;
}

export interface MissionExecutionLifecycle {
  bindExternalExecution(executionId: string): void;
  recordTurnAccepted(executionId: string, messageId: string): void;
}

export interface MissionRuntimeOptions {
  workspaceRoot: string;
  controller: MissionController;
  executor: MissionWorkExecutor;
  genDispatchId?: (missionId: string, workItemId: string, attempt: number) => string;
  onSnapshot?: (snapshot: MissionSnapshot) => void;
  onError?: (context: { missionId: string; workItemId?: string; error: Error }) => void;
  /** Host-owned admission/continuation policy, evaluated before and between attempts. */
  evaluateRunPolicy?: (
    snapshot: MissionSnapshot,
    pendingTelemetry?: MissionAttemptTelemetry,
    completedAttempt?: boolean,
  ) => MissionRuntimePolicyDecision | null;
  /** Stops live executor sessions after a policy decision becomes terminal. */
  onPolicyHalt?: (before: MissionSnapshot, after: MissionSnapshot) => Promise<void> | void;
  nowMs?: () => number;
}

export interface MissionRuntimePolicyDecision {
  status: 'failed' | 'cancelled';
  reason: string;
}

const TERMINAL_OR_WAITING = new Set(['paused', 'blocked', 'waiting-approval', 'completed', 'failed', 'cancelled']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function isReview(item: MissionWorkItem): boolean {
  return item.kind === 'objective-review' || item.kind === 'final-review';
}

/** Durable scheduler loop. Models propose results; MissionController owns every transition. */
export class MissionRuntime {
  private readonly loops = new Map<string, Promise<MissionSnapshot>>();
  private readonly work = new Map<string, Promise<void>>();
  private readonly deadlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly policyHalts = new Map<string, Promise<void>>();
  private readonly genDispatchId: NonNullable<MissionRuntimeOptions['genDispatchId']>;

  constructor(private readonly options: MissionRuntimeOptions) {
    this.genDispatchId = options.genDispatchId ?? ((missionId, workItemId, attempt) =>
      `${missionId}-${workItemId}-${attempt}-${randomUUID()}`);
  }

  startMission(missionId: string): MissionSnapshot {
    let snapshot = this.options.controller.getMission(missionId);
    const policyHalt = this.applyRunPolicy(snapshot);
    if (policyHalt) return policyHalt;
    if (snapshot.status === 'draft' || snapshot.status === 'paused') {
      snapshot = this.options.controller.startMission(missionId);
      this.emit(snapshot);
    }
    this.ensureLoop(missionId);
    return snapshot;
  }

  async runUntilSettled(missionId: string): Promise<MissionSnapshot> {
    const started = this.startMission(missionId);
    return this.loops.get(missionId) ?? started;
  }

  recoverNonTerminalMissions(): string[] {
    const recovered: string[] = [];
    for (const missionId of listMissionIds(this.options.workspaceRoot)) {
      const snapshot = this.options.controller.getMission(missionId);
      if (snapshot.status !== 'draft' && !TERMINAL.has(snapshot.status)) this.armDeadline(missionId);
      if (snapshot.status === 'draft' || TERMINAL_OR_WAITING.has(snapshot.status)) continue;
      this.ensureLoop(missionId);
      recovered.push(missionId);
    }
    return recovered;
  }

  private ensureLoop(missionId: string): void {
    if (this.loops.has(missionId)) return;
    this.armDeadline(missionId);
    const loop = this.pump(missionId)
      .catch((error: unknown) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.options.onError?.({ missionId, error: normalized });
        return this.options.controller.getMission(missionId);
      })
      .finally(() => {
        this.loops.delete(missionId);
        const snapshot = this.options.controller.getMission(missionId);
        if (TERMINAL.has(snapshot.status)) this.clearDeadline(missionId);
        else this.armDeadline(missionId);
      });
    this.loops.set(missionId, loop);
  }

  private async pump(missionId: string): Promise<MissionSnapshot> {
    while (true) {
      let snapshot = this.options.controller.getMission(missionId);
      if (TERMINAL_OR_WAITING.has(snapshot.status)) return snapshot;
      snapshot = this.applyRunPolicy(snapshot) ?? snapshot;
      if (TERMINAL_OR_WAITING.has(snapshot.status)) return snapshot;

      const candidates = new Map<string, MissionWorkItem>();
      for (const ready of this.options.controller.listReadyWork(missionId)) {
        candidates.set(ready.item.id, ready.item);
      }
      for (const runtime of Object.values(snapshot.workItems)) {
        if (runtime.status === 'reserved' || runtime.status === 'running') {
          candidates.set(runtime.definition.id, runtime.definition);
        }
      }
      if (candidates.size === 0) return snapshot;

      await Promise.all([...candidates.values()].map((item) => this.ensureWork(missionId, item.id)));
    }
  }

  private ensureWork(missionId: string, workItemId: string): Promise<void> {
    const key = `${missionId}:${workItemId}`;
    const existing = this.work.get(key);
    if (existing) return existing;
    const running = this.driveWork(missionId, workItemId)
      .catch((error: unknown) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.options.onError?.({ missionId, workItemId, error: normalized });
        this.failConservatively(missionId, workItemId, normalized);
      })
      .finally(() => this.work.delete(key));
    this.work.set(key, running);
    return running;
  }

  private async driveWork(missionId: string, workItemId: string): Promise<void> {
    let snapshot = this.options.controller.getMission(missionId);
    if (this.applyRunPolicy(snapshot)) return;
    let runtime = snapshot.workItems[workItemId];
    if (!runtime) throw new Error(`Unknown mission work item "${workItemId}"`);

    let input = this.buildInput(snapshot, runtime.definition, runtime.dispatchId ?? 'preparing');
    if (runtime.status === 'pending') {
      const dispatchId = this.genDispatchId(missionId, workItemId, runtime.attempt + 1);
      input = this.buildInput(snapshot, runtime.definition, dispatchId);
      const binding = await this.options.executor.prepare(input);
      snapshot = this.options.controller.reserveWorkItem(missionId, workItemId, { dispatchId, binding });
      this.emit(snapshot);
      runtime = snapshot.workItems[workItemId]!;
    }

    if (runtime.status === 'reserved') {
      if (this.applyRunPolicy(snapshot)) return;
      snapshot = this.options.controller.confirmWorkItemDispatch(missionId, workItemId, runtime.dispatchId!);
      this.emit(snapshot);
      runtime = snapshot.workItems[workItemId]!;
    }
    if (runtime.status !== 'running' || !runtime.dispatchId || !runtime.executionBinding) return;

    input = this.buildInput(snapshot, runtime.definition, runtime.dispatchId);
    const result = await this.options.executor.execute(input, runtime.executionBinding, {
      bindExternalExecution: (executionId) => {
        const bound = this.options.controller.bindWorkItemSession(
          missionId, workItemId, runtime.dispatchId!, executionId,
        );
        this.emit(bound);
      },
      recordTurnAccepted: (executionId, messageId) => {
        const accepted = this.options.controller.recordWorkItemTurnAccepted(
          missionId, workItemId, runtime.dispatchId!, executionId, messageId,
        );
        this.emit(accepted);
      },
    });
    const afterExecution = this.options.controller.getMission(missionId);
    if (TERMINAL_OR_WAITING.has(afterExecution.status)) return;
    const policyHalt = this.applyRunPolicy(
      afterExecution,
      result.telemetry,
      { workItemId, dispatchId: runtime.dispatchId },
    );
    if (policyHalt) return;
    if (result.status === 'approval-required') {
      snapshot = this.options.controller.waitForWorkItemApproval(
        missionId,
        workItemId,
        runtime.dispatchId,
        `Connector approval ${result.approvalId} is required for ${result.operationId}`,
      );
    } else if (result.status === 'failed') {
      snapshot = this.options.controller.failWorkItemAttempt(missionId, workItemId, runtime.dispatchId, result);
    } else if (isReview(runtime.definition)) {
      if (result.status !== 'verdict') throw new Error(`Review "${workItemId}" returned a worker submission`);
      snapshot = this.options.controller.recordVerdict(
        missionId,
        workItemId,
        runtime.executionBinding.executionId,
        result.verdict,
        result.telemetry,
      );
    } else {
      if (result.status !== 'submission') throw new Error(`Worker "${workItemId}" returned a review verdict`);
      snapshot = this.options.controller.submitWorkItem(
        missionId,
        workItemId,
        runtime.executionBinding.executionId,
        result.submission,
        result.telemetry,
      );
    }
    this.emit(snapshot);
  }

  private buildInput(snapshot: MissionSnapshot, item: MissionWorkItem, dispatchId: string): MissionExecutionInput {
    const profileId = item.agentProfileId ??
      (item.kind === 'objective-review'
        ? snapshot.spec.reviewerProfileId
        : item.kind === 'final-review'
          ? snapshot.spec.supervisorProfileId
          : snapshot.spec.defaultWorkerProfileId);
    const profile = snapshot.spec.agentProfiles.find((candidate) => candidate.id === profileId);
    if (!profile) throw new Error(`Unknown mission agent profile "${profileId}"`);
    return {
      mission: snapshot.spec,
      item,
      profile,
      dispatchId,
      upstream: (item.kind === 'final-review'
        ? Object.values(snapshot.workItems)
            .filter((candidate) => candidate.submission && candidate.status !== 'superseded')
            .map((candidate) => candidate.definition.id)
        : item.dependsOn).map((dependencyId) => {
        const dependency = snapshot.workItems[dependencyId];
        if (!dependency) throw new Error(`Unknown mission dependency "${dependencyId}"`);
        return {
          workItemId: dependencyId,
          title: dependency.definition.title,
          ...(dependency.submission ? { submission: dependency.submission } : {}),
        };
      }),
    };
  }

  private failConservatively(missionId: string, workItemId: string, error: Error): void {
    try {
      let snapshot = this.options.controller.getMission(missionId);
      let runtime = snapshot.workItems[workItemId];
      if (runtime?.status === 'pending') {
        const dispatchId = this.genDispatchId(missionId, workItemId, runtime.attempt + 1);
        snapshot = this.options.controller.reserveWorkItem(missionId, workItemId, {
          dispatchId,
          binding: { executorKind: 'runtime-error', executionId: `${dispatchId}-prepare-failed` },
        });
        snapshot = this.options.controller.confirmWorkItemDispatch(missionId, workItemId, dispatchId);
        runtime = snapshot.workItems[workItemId];
      }
      if (!runtime?.dispatchId || (runtime.status !== 'reserved' && runtime.status !== 'running')) return;
      const failed = this.options.controller.failWorkItemAttempt(missionId, workItemId, runtime.dispatchId, {
        reason: error.message,
        retryable: runtime.definition.effect === 'read',
        ambiguousMutation: runtime.definition.effect !== 'read',
      });
      this.emit(failed);
    } catch (failureError) {
      this.options.onError?.({
        missionId,
        workItemId,
        error: failureError instanceof Error ? failureError : new Error(String(failureError)),
      });
    }
  }

  private emit(snapshot: MissionSnapshot): void {
    this.options.onSnapshot?.(snapshot);
  }

  /** Re-evaluate live host policy immediately (used by emergency-control changes). */
  async enforceRunPolicy(missionId: string): Promise<MissionSnapshot> {
    const before = this.options.controller.getMission(missionId);
    const after = this.applyRunPolicy(before) ?? before;
    const halt = this.policyHalts.get(missionId);
    if (halt) await halt;
    return after;
  }

  private applyRunPolicy(
    snapshot: MissionSnapshot,
    pendingTelemetry?: MissionAttemptTelemetry,
    attempt?: { workItemId: string; dispatchId: string },
  ): MissionSnapshot | null {
    if (TERMINAL.has(snapshot.status)) return null;
    const decision = this.options.evaluateRunPolicy?.(snapshot, pendingTelemetry, attempt !== undefined);
    if (!decision) return null;
    const after = decision.status === 'cancelled'
      ? this.options.controller.cancelMission(snapshot.spec.id, decision.reason)
      : this.options.controller.failMissionForRuntimeLimit(
          snapshot.spec.id,
          decision.reason,
          pendingTelemetry && attempt
            ? { ...attempt, telemetry: pendingTelemetry }
            : undefined,
        );
    this.emit(after);
    this.clearDeadline(snapshot.spec.id);
    const halt = (async () => {
      try {
        await this.options.onPolicyHalt?.(snapshot, after);
      } catch (error: unknown) {
        this.options.onError?.({
          missionId: snapshot.spec.id,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    });
    const pendingHalt = halt();
    this.policyHalts.set(snapshot.spec.id, pendingHalt);
    void pendingHalt.then(() => {
      if (this.policyHalts.get(snapshot.spec.id) === pendingHalt) {
        this.policyHalts.delete(snapshot.spec.id);
      }
    });
    return after;
  }

  private armDeadline(missionId: string): void {
    this.clearDeadline(missionId);
    const snapshot = this.options.controller.getMission(missionId);
    const deadline = snapshot.spec.policy.deadline;
    if (!deadline || TERMINAL.has(snapshot.status) || snapshot.status === 'draft') return;
    const remaining = Date.parse(deadline) - (this.options.nowMs?.() ?? Date.now());
    const delay = Math.max(0, Math.min(remaining, 2_147_000_000));
    const timer = setTimeout(() => {
      this.deadlineTimers.delete(missionId);
      if (remaining > delay) {
        this.armDeadline(missionId);
        return;
      }
      void this.enforceRunPolicy(missionId);
    }, delay);
    timer.unref?.();
    this.deadlineTimers.set(missionId, timer);
  }

  private clearDeadline(missionId: string): void {
    const timer = this.deadlineTimers.get(missionId);
    if (timer) clearTimeout(timer);
    this.deadlineTimers.delete(missionId);
  }
}
