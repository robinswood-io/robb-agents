import { type MissionExecutionBinding } from "@craft-agent/shared/missions";
import type { PermissionMode } from "@craft-agent/shared/agent/mode-types";
import { type SessionExecutionIsolation } from "@craft-agent/shared/tasks";
import type { SessionCompletionEvent } from "../sessions/SessionManager.ts";
import { type MissionExecutionInput, type MissionExecutionLifecycle, type MissionExecutionResult, type MissionWorkExecutor } from "./MissionRuntime.ts";
import { DEFAULT_TIMEOUT_MS, withTelemetry } from './session-mission-executor/shared.ts';
import type { SessionMissionExecutorOptions, RequiredReviewInvocation, TerminalReviewSessionBoundary } from './session-mission-executor/shared.ts';
import * as sessionMissionExecutorPreflight from './session-mission-executor/preflight.ts';
import * as sessionMissionExecutorExecution from './session-mission-executor/execution.ts';
export type { SessionMissionHost, MissionToolInvocationPreflightInput, MissionToolInvocationPreflightDecision, SessionMissionExecutorOptions, RequiredReviewInvocation } from './session-mission-executor/shared.ts';
export { buildMissionSessionPrompt } from './session-mission-executor/shared.ts';

/**
 * Executes one Mission v2 work item in an ordinary durable chat session.
 * The MissionController remains the only scheduler; the session is a leaf
 * executor and is recovered by its persisted missionDispatchId.
 */
export class SessionMissionExecutor implements MissionWorkExecutor {
    /** @internal */ public readonly timeoutMs: number;
    constructor(private readonly options: SessionMissionExecutorOptions) {
        this.timeoutMs = options.completionTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    }
    async prepare(input: MissionExecutionInput): Promise<MissionExecutionBinding> {
        return { executorKind: 'session', executionId: input.dispatchId };
    }
    async execute(input: MissionExecutionInput, binding: MissionExecutionBinding, lifecycle?: MissionExecutionLifecycle): Promise<MissionExecutionResult> {
        const startedAt = Date.now();
        const result = await this.executeUnmetered(input, binding, lifecycle, startedAt);
        return result.telemetry ? result : withTelemetry(result, startedAt);
    }
    /** @internal */ public async preflightRequiredReviewInvocations(input: MissionExecutionInput, missionWorkingDirectory: string): Promise<{
        allowed: true;
        effectivePermissionMode: PermissionMode;
        grantsFullToolAndNetworkAccess: boolean;
        enabledSourceSlugs?: string[];
        executionIsolation: SessionExecutionIsolation;
        reviewInvocations: RequiredReviewInvocation[];
    } | {
        allowed: false;
        reason: string;
    }> {
        return sessionMissionExecutorPreflight.preflightRequiredReviewInvocations(this, input, missionWorkingDirectory);
    }
    private async executeUnmetered(input: MissionExecutionInput, binding: MissionExecutionBinding, lifecycle: MissionExecutionLifecycle | undefined, startedAt: number): Promise<MissionExecutionResult> {
        return sessionMissionExecutorExecution.executeUnmetered(this, input, binding, lifecycle, startedAt);
    }
    /** @internal */ public async runOrRecover(input: MissionExecutionInput, sessionId: string, lifecycle?: MissionExecutionLifecycle, startedAt = Date.now(), reviewInvocations: readonly RequiredReviewInvocation[] = [], terminalReviewBoundary?: TerminalReviewSessionBoundary): Promise<MissionExecutionResult> {
        return sessionMissionExecutorExecution.runOrRecover(this, input, sessionId, startedAt, reviewInvocations, lifecycle, terminalReviewBoundary);
    }
    /** @internal */ public waitForCompletion(sessionId: string, timeoutMs: number): {
        promise: Promise<SessionCompletionEvent>;
        cancel: () => void;
    } {
        let unsubscribe = () => { };
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const cleanup = () => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            unsubscribe();
        };
        const promise = new Promise<SessionCompletionEvent>((resolve, reject) => {
            unsubscribe = this.options.host.onSessionComplete((event) => {
                if (event.sessionId !== sessionId)
                    return;
                cleanup();
                resolve(event);
            });
            timer = setTimeout(() => {
                cleanup();
                reject(new Error(`Mission session timed out after ${timeoutMs} ms`));
            }, timeoutMs);
            timer.unref?.();
        });
        return { promise, cancel: cleanup };
    }
}
