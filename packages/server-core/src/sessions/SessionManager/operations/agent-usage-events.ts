import type { SessionOperationContext } from '../operation-context.ts';
import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '@craft-agent/shared/agent';
import { buildRoutingCostMeta, applyRoutingCostMetaToLatestAssistantMessage, resolveRoutingCostOptions } from '@craft-agent/shared/audit';
import type { ManagedSession } from '../managed-session.ts';
import { emitOperationsEvent } from '../../operations-events.ts';
import { captureCompactionProviderBaseline as sessionOpCaptureCompactionProviderBaseline } from './persist-tool-result-after-permission-expiry.ts';

export async function handleAgentComplete(sessionOperationContext: SessionOperationContext, managed: ManagedSession, event: Extract<AgentEvent, { type: 'complete' }>, sessionId: string, workspaceId: string, generationKey: number): Promise<void> {
    // Complete event from CraftAgent - accumulate usage from this turn
    // Actual 'complete' sent to renderer comes from the finally block in sendMessage
    if (event.usage) {
        // Initialize tokenUsage if not set
        if (!managed.tokenUsage) {
            managed.tokenUsage = {
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
                contextTokens: 0,
                costUsd: 0,
            };
        }
        // inputTokens remains the backend's billed turn input. Pi may aggregate
        // several model calls around tools; contextTokens is the latest call only.
        managed.tokenUsage.inputTokens = event.usage.inputTokens;
        managed.tokenUsage.contextTokens = event.usage.contextTokens ?? event.usage.inputTokens;
        // outputTokens and costUsd are accumulated across all turns (total session usage)
        managed.tokenUsage.outputTokens += event.usage.outputTokens;
        managed.tokenUsage.totalTokens = managed.tokenUsage.inputTokens + managed.tokenUsage.outputTokens;
        managed.tokenUsage.costUsd += event.usage.costUsd ?? 0;
        // Cache tokens reflect current state, not accumulated
        managed.tokenUsage.cacheReadTokens = event.usage.cacheReadTokens ?? 0;
        managed.tokenUsage.cacheCreationTokens = event.usage.cacheCreationTokens ?? 0;
        // Update context window (use latest value - may change if model switches)
        if (event.usage.contextWindow) {
            managed.tokenUsage.contextWindow = event.usage.contextWindow;
        }
        await sessionOpCaptureCompactionProviderBaseline(sessionOperationContext, managed, event.usage.contextTokens ?? event.usage.inputTokens);
        const costMeta = buildRoutingCostMeta(event.usage, resolveRoutingCostOptions(process.env));
        const updatedMessage = applyRoutingCostMetaToLatestAssistantMessage(managed.messages, costMeta);
        emitOperationsEvent({
            kind: 'cost.recorded', at: new Date().toISOString(), workspaceId, sessionId,
            missionId: managed.missionId, workItemId: managed.missionWorkItemId,
            turnId: updatedMessage?.turnId,
            source: costMeta.costProvenance?.source ?? costMeta.tokenUsageSource ?? 'unavailable',
            estimatedCostUsd: costMeta.estimatedCostUsd,
            actualCostUsd: costMeta.actualCostUsd,
            pricingCatalogVersion: costMeta.costProvenance?.pricingCatalogVersion,
        });
        sessionOperationContext.owner["emitExecutionTelemetry"](managed, {
            schemaVersion: 1,
            eventId: randomUUID(),
            timestamp: Date.now(),
            name: 'cost.recorded',
            correlation: {
                workspaceId,
                sessionId,
                ...(updatedMessage?.turnId ? { turnId: updatedMessage.turnId } : {}),
            },
            source: costMeta.costProvenance?.source ?? costMeta.tokenUsageSource ?? 'unavailable',
            estimatedCostUsd: costMeta.estimatedCostUsd,
            actualCostUsd: costMeta.actualCostUsd,
            estimatedCostEur: costMeta.estimatedCostEur,
            actualCostEur: costMeta.actualCostEur,
            pricingCatalogVersion: costMeta.costProvenance?.pricingCatalogVersion,
            exchangeRateAsOf: costMeta.costProvenance?.exchangeRateAsOf,
            exchangeRateSource: costMeta.costProvenance?.exchangeRateSource,
        });
        if (updatedMessage?.routingMeta) {
            sessionOperationContext.owner["sendEvent"]({
                type: 'text_complete',
                sessionId,
                text: updatedMessage.content,
                isIntermediate: updatedMessage.isIntermediate,
                turnId: updatedMessage.turnId,
                parentToolUseId: updatedMessage.parentToolUseId,
                timestamp: updatedMessage.timestamp,
                messageId: updatedMessage.id,
                routingMeta: updatedMessage.routingMeta,
                objectiveOutcome: updatedMessage.objectiveOutcome ?? null,
                objectiveOutcomeError: updatedMessage.objectiveOutcomeError ?? null,
            }, workspaceId);
        }
    }
    sessionOperationContext.owner["finishGenerationTelemetry"](managed, generationKey, 'generation.completed', { usage: event.usage });
    return;
}

export async function handleAgentUsageUpdate(sessionOperationContext: SessionOperationContext, managed: ManagedSession, event: Extract<AgentEvent, { type: 'usage_update' }>, workspaceId: string): Promise<void> {
    // Real-time usage update for context display during processing
    // Update managed session's tokenUsage with latest context size
    if (event.usage) {
        if (!managed.tokenUsage) {
            managed.tokenUsage = {
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
                contextTokens: 0,
                costUsd: 0,
            };
        }
        // Keep both display and routing context counters on the latest provider measurement.
        // Other fields still accumulate only on complete.
        managed.tokenUsage.inputTokens = event.usage.inputTokens;
        managed.tokenUsage.contextTokens = event.usage.inputTokens;
        if (event.usage.contextWindow) {
            managed.tokenUsage.contextWindow = event.usage.contextWindow;
        }
        await sessionOpCaptureCompactionProviderBaseline(sessionOperationContext, managed, event.usage.inputTokens);
        // Send to renderer for immediate UI update
        sessionOperationContext.owner["sendEvent"]({
            type: 'usage_update',
            sessionId: managed.id,
            tokenUsage: {
                inputTokens: event.usage.inputTokens,
                contextWindow: event.usage.contextWindow,
            },
        }, workspaceId);
    }
    return;
}


