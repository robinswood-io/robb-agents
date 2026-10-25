import type { SessionOperationContext } from '../operation-context.ts';
import { join } from 'path';
import { randomUUID } from 'node:crypto';
import type { AgentEventUsage } from '@craft-agent/core/types';
import { LocalJsonlTelemetrySink, OtlpHttpTelemetrySink, parseCompactionInputTokens, resolveOtlpTelemetryConfig } from '@craft-agent/shared/telemetry';
import type { GenerationTerminalName, RobbExecutionTelemetryEvent } from '@craft-agent/shared/telemetry';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog, sessionRuntimeHooks } from '../runtime-platform.ts';

/**
 * Centralized setter for session processing state.
 * Automatically notifies the power manager on transitions (true→false, false→true)
 * so callers don't need to remember to call onSessionStarted/onSessionStopped.
 */
function sessionOpSetProcessing(sessionOperationContext: SessionOperationContext, managed: ManagedSession, processing: boolean): void {
    const was = managed.isProcessing;
    managed.isProcessing = processing;
    // Actual dispatch supersedes an older deferred marker, including human Retry/new objectives.
    if (processing)
        sessionOperationContext.state.deferredAutomaticSessions?.delete(managed.id);
    managed.runtimeLastActiveAt = Date.now();
    if (!processing) {
        sessionOperationContext.state.automaticAdmissionReservations?.delete(managed.id);
    }
    if (!was && processing) {
        sessionRuntimeHooks.onSessionStarted();
    }
    else if (was && !processing) {
        sessionRuntimeHooks.onSessionStopped();
    }
    if (was !== processing) {
        // Automatic/queued continuations can start before a window subscribes or
        // without a new visible message. Publish runtime truth independently of
        // message ACKs so Stop and provider controls follow the actual agent.
        sessionOperationContext.owner["sendEvent"]({ type: 'session_metadata_changed', sessionId: managed.id,
            changes: { isProcessing: processing } }, managed.workspace.id);
    }
}

function sessionOpEmitExecutionTelemetry(sessionOperationContext: SessionOperationContext, managed: ManagedSession, event: RobbExecutionTelemetryEvent): void {
    const workspaceId = managed.workspace.id;
    let localSink = sessionOperationContext.state.localTelemetrySinks.get(workspaceId);
    if (!localSink) {
        localSink = new LocalJsonlTelemetrySink(join(managed.workspace.rootPath, 'telemetry', 'execution-quality.jsonl'), undefined, managed.workspace.rootPath);
        sessionOperationContext.state.localTelemetrySinks.set(workspaceId, localSink);
    }
    void localSink.emit(event).catch(error => {
        sessionLog.warn('Local execution telemetry write failed', {
            workspaceId,
            eventName: event.name,
            message: error instanceof Error ? error.message : String(error),
        });
    });
    const config = resolveOtlpTelemetryConfig(process.env, workspaceId);
    if (!config.enabled)
        return;
    let sink = sessionOperationContext.state.telemetrySinks.get(workspaceId);
    if (!sink) {
        sink = new OtlpHttpTelemetrySink(config);
        sessionOperationContext.state.telemetrySinks.set(workspaceId, sink);
    }
    void sink.emit(event).catch(error => {
        sessionLog.warn('OTLP telemetry export failed', {
            workspaceId,
            eventName: event.name,
            message: error instanceof Error ? error.message : String(error),
        });
    });
}

function sessionOpStartGenerationTelemetry(sessionOperationContext: SessionOperationContext, managed: ManagedSession, processingGeneration: number, input: {
    turnId: string;
    connectionSlug?: string;
    providerType?: string;
    model?: string;
    inputTokens?: number;
    recordRoutingOutcome?: boolean;
}): void { const generationId = randomUUID(); const event = sessionOperationContext.state.generationTelemetryLifecycle.start({ eventId: randomUUID(), timestamp: Date.now(), correlation: { workspaceId: managed.workspace.id, sessionId: managed.id, turnId: input.turnId, generationId }, providerType: input.providerType, model: input.model, inputTokens: input.inputTokens }); const generations = managed.executionTelemetryGenerations ?? new Map(); generations.set(processingGeneration, { generationId, turnId: input.turnId }); managed.executionTelemetryGenerations = generations; sessionOperationContext.owner["emitExecutionTelemetry"](managed, event); }

function sessionOpFinishGenerationTelemetry(sessionOperationContext: SessionOperationContext, managed: ManagedSession, processingGeneration: number, name: GenerationTerminalName, input?: {
    usage?: AgentEventUsage;
    errorCode?: string;
}): undefined { const reference = managed.executionTelemetryGenerations?.get(processingGeneration); if (!reference)
    return; const usage = input?.usage; const event = sessionOperationContext.state.generationTelemetryLifecycle.finish(reference.generationId, { eventId: randomUUID(), timestamp: Date.now(), name, inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens, cachedInputTokens: usage?.cacheReadTokens, cacheWriteTokens: usage?.cacheCreationTokens, cacheHit: typeof usage?.cacheReadTokens === 'number' ? usage.cacheReadTokens > 0 : undefined, errorCode: input?.errorCode }); managed.executionTelemetryGenerations?.delete(processingGeneration); if (managed.executionTelemetryGenerations?.size === 0)
    managed.executionTelemetryGenerations = undefined; if (event)
    sessionOperationContext.owner["emitExecutionTelemetry"](managed, event); }

function sessionOpFinishAllGenerationTelemetry(sessionOperationContext: SessionOperationContext, managed: ManagedSession, errorCode: string): void {
    for (const processingGeneration of managed.executionTelemetryGenerations?.keys() ?? []) {
        sessionOperationContext.owner["finishGenerationTelemetry"](managed, processingGeneration, 'generation.cancelled', { errorCode });
    }
}

function sessionOpRecordRetryTelemetry(sessionOperationContext: SessionOperationContext, managed: ManagedSession, input: {
    component: 'generation' | 'provider';
    attempt: number;
    reasonCode: string;
    processingGeneration?: number;
    turnId?: string;
    exhausted?: boolean;
}): void {
    const generation = input.processingGeneration === undefined
        ? undefined
        : managed.executionTelemetryGenerations?.get(input.processingGeneration);
    sessionOperationContext.owner["emitExecutionTelemetry"](managed, {
        schemaVersion: 1,
        eventId: randomUUID(),
        timestamp: Date.now(),
        name: 'retry.recorded',
        correlation: {
            workspaceId: managed.workspace.id,
            sessionId: managed.id,
            ...(input.turnId ?? generation?.turnId
                ? { turnId: input.turnId ?? generation?.turnId }
                : {}),
            ...(generation ? { generationId: generation.generationId } : {}),
        },
        component: input.component,
        attempt: input.attempt,
        reasonCode: input.reasonCode,
        exhausted: input.exhausted,
    });
}

function sessionOpFinishCompactionTelemetry(sessionOperationContext: SessionOperationContext, managed: ManagedSession, processingGeneration: number, completionMessage: string): void {
    const active = managed.executionTelemetryCompactions?.get(processingGeneration);
    if (!active)
        return;
    managed.executionTelemetryCompactions?.delete(processingGeneration);
    if (managed.executionTelemetryCompactions?.size === 0) {
        managed.executionTelemetryCompactions = undefined;
    }
    const reportedInputTokens = parseCompactionInputTokens(completionMessage);
    const inputTokens = reportedInputTokens ?? active.inputTokens;
    const currentInputTokens = managed.tokenUsage?.inputTokens;
    const outputTokens = typeof inputTokens === 'number'
        && typeof currentInputTokens === 'number'
        && currentInputTokens < inputTokens
        ? currentInputTokens
        : undefined;
    sessionOperationContext.owner["emitExecutionTelemetry"](managed, {
        schemaVersion: 1,
        eventId: randomUUID(),
        timestamp: Date.now(),
        name: 'compaction.recorded',
        correlation: {
            workspaceId: managed.workspace.id,
            sessionId: managed.id,
            ...(active.turnId ? { turnId: active.turnId } : {}),
            ...(active.generationId ? { generationId: active.generationId } : {}),
        },
        inputTokens,
        outputTokens,
        ...(typeof inputTokens === 'number' && typeof outputTokens === 'number'
            ? { reclaimedTokens: Math.max(0, inputTokens - outputTokens) }
            : {}),
        durationMs: Math.max(0, Date.now() - active.startedAt),
        strategy: 'provider-auto',
    });
}

export { sessionOpSetProcessing as setProcessing };
export { sessionOpEmitExecutionTelemetry as emitExecutionTelemetry };
export { sessionOpStartGenerationTelemetry as startGenerationTelemetry };
export { sessionOpFinishGenerationTelemetry as finishGenerationTelemetry };
export { sessionOpFinishAllGenerationTelemetry as finishAllGenerationTelemetry };
export { sessionOpRecordRetryTelemetry as recordRetryTelemetry };
export { sessionOpFinishCompactionTelemetry as finishCompactionTelemetry };
