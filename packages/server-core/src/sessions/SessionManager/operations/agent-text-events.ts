import type { SessionOperationContext } from '../operation-context.ts';
import { persistenceRootFor, rehydrateObjectiveEvidence } from '../policy.ts';
import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '@craft-agent/shared/agent';
import { getLlmConnection } from '@craft-agent/shared/config';
import { isWorkspaceAutomaticToolFallbackEnabled, loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import { getSessionPath as getSessionStoragePath } from '@craft-agent/shared/sessions';
import { generateMessageId } from '@craft-agent/shared/protocol';
import type { Message } from '@craft-agent/core/types';
import { getPlatformSessionAppProvenance, toRoutingMetaAppProvenance } from '../../session-app-provenance';
import { extractObjectiveOutcome } from '../../objective-outcome';
import { isAutonomyBrowserFallbackPrompt, isAutonomyStructuredFallbackPrompt, parseAutonomyFallbackIntent } from '../../autonomy-browser-fallback';
import type { ManagedSession } from '../managed-session.ts';
import { _platform, sessionLog } from '../runtime-platform.ts';
import { PI_SDK_MESSAGE_ID_CACHE_LIMIT } from '../source-activation.ts';
import { isClaudeMessageUuid, saveClaudeTurnAnchor, savePiTurnAnchor } from '../turn-anchors.ts';
import { queueDelta as sessionOpQueueDelta, flushDelta as sessionOpFlushDelta } from './redirect-automatic-tool-fallback.ts';
import { monotonic as sessionOpMonotonic } from './runtime-host.ts';
import { assertPersistenceSessionPath as sessionOpAssertPersistenceSessionPath } from './claim-automatic-admission.ts';

export function handleAgentTextDelta(sessionOperationContext: SessionOperationContext, managed: ManagedSession, event: Extract<AgentEvent, { type: 'text_delta' }>, sessionId: string, workspaceId: string): void {
    managed.streamingText += event.text;
    managed.streamingTurnId = event.turnId;
    // Queue delta for batched sending (performance: reduces IPC from 50+/sec to ~20/sec)
    sessionOpQueueDelta(sessionOperationContext, sessionId, workspaceId, event.text, event.turnId);
    return;
}

export function handleAgentTextDiscard(sessionOperationContext: SessionOperationContext, managed: ManagedSession, event: Extract<AgentEvent, { type: 'text_discard' }>, sessionId: string, workspaceId: string): void {
    {
        const pending = sessionOperationContext.state.pendingDeltas.get(sessionId);
        if (pending?.turnId === event.turnId) {
            const timer = sessionOperationContext.state.deltaFlushTimers.get(sessionId);
            if (timer)
                clearTimeout(timer);
            sessionOperationContext.state.deltaFlushTimers.delete(sessionId);
            sessionOperationContext.state.pendingDeltas.delete(sessionId);
        }
        if (managed.streamingTurnId === event.turnId) {
            managed.streamingText = '';
            managed.streamingTurnId = undefined;
        }
        sessionOperationContext.owner["sendEvent"]({ type: 'text_discard', sessionId, turnId: event.turnId }, workspaceId);
        return;
    }
}

export async function handleAgentTextComplete(sessionOperationContext: SessionOperationContext, managed: ManagedSession, event: Extract<AgentEvent, { type: 'text_complete' }>, sessionId: string, workspaceId: string): Promise<void> {
    {
        // Flush any pending deltas before sending complete (ensures renderer has all content)
        sessionOpFlushDelta(sessionOperationContext, sessionId, workspaceId);
        const extractedOutcome = event.isIntermediate
            ? { visibleContent: event.text }
            : extractObjectiveOutcome(event.text);
        const routingConnection = managed.llmConnection ? getLlmConnection(managed.llmConnection) : undefined;
        const modelProvenance = event.modelProvenance;
        const responseAppProvenance = toRoutingMetaAppProvenance(getPlatformSessionAppProvenance(_platform));
        const assistantMessage: Message = {
            id: generateMessageId(),
            role: 'assistant',
            content: extractedOutcome.visibleContent,
            ...('declaration' in extractedOutcome && extractedOutcome.declaration ? { objectiveOutcome: extractedOutcome.declaration } : {}),
            ...('error' in extractedOutcome && extractedOutcome.error ? { objectiveOutcomeError: extractedOutcome.error } : {}),
            timestamp: sessionOpMonotonic(sessionOperationContext),
            isIntermediate: event.isIntermediate,
            turnId: event.turnId,
            parentToolUseId: event.parentToolUseId,
            routingMeta: {
                ...managed.pendingRoutingMeta,
                ...responseAppProvenance,
                connectionSlug: managed.llmConnection,
                providerType: routingConnection?.providerType,
                // Pi can resolve aliases/dynamic routes (for example OpenRouter
                // `auto`) to a different model than the configured request. Prefer
                // the identity reported by the completed provider message.
                model: modelProvenance?.model ?? managed.agent?.getModel() ?? managed.model,
                ...(modelProvenance?.requestedModel
                    ? { requestedModel: modelProvenance.requestedModel }
                    : {}),
                ...(modelProvenance?.provider ? { provider: modelProvenance.provider } : {}),
                ...(modelProvenance?.api ? { api: modelProvenance.api } : {}),
                ...(modelProvenance?.contextWindow !== undefined
                    ? { contextWindow: modelProvenance.contextWindow }
                    : {}),
                reason: managed.pendingRoutingReason ?? managed.pendingRoutingMeta?.reason ?? 'session-connection',
            },
        };
        managed.messages.push(assistantMessage);
        managed.streamingText = '';
        managed.streamingTurnId = undefined;
        // Update lastMessageRole and lastFinalMessageId for badge/unread display (only for final messages)
        if (!event.isIntermediate) {
            managed.lastMessageRole = 'assistant';
            managed.lastFinalMessageId = assistantMessage.id;
            const sessionPath = getSessionStoragePath(persistenceRootFor(managed), sessionId);
            // Claude branch-cutoff support: persist message UUID + SDK session lineage in sidecar.
            // Used to guard resumeSessionAt so we only send anchors valid for the parent SDK session.
            if (event.turnId && managed.sdkSessionId && isClaudeMessageUuid(event.turnId)) {
                try {
                    await saveClaudeTurnAnchor(sessionPath, assistantMessage.id, managed.sdkSessionId, event.turnId, () => sessionOpAssertPersistenceSessionPath(sessionOperationContext, managed, sessionPath));
                }
                catch (error) {
                    sessionLog.warn(`Failed to persist Claude turn anchor for session ${sessionId}:`, error);
                }
            }
            // Pi branch-cutoff support: remember the SDK message id → Craft
            // assistant message id mapping. The actual anchor arrives as a
            // separate `pi_turn_anchor` event one microtask later — the SDK
            // updates its leaf only AFTER firing message_end (see #782).
            if (managed.pendingRoutingReason || managed.pendingRoutingMeta
                || managed.pendingRoutingFallbackConnectionSlugs || managed.pendingRoutingDecision) {
                managed.pendingRoutingReason = undefined;
                managed.pendingRoutingMeta = undefined;
                managed.pendingRoutingFallbackConnectionSlugs = undefined;
                managed.pendingRoutingDecision = undefined;
            }
            managed.routingFallbackAttempts = undefined;
            managed.routingAttemptedConnectionSlugs = undefined;
            if (managed.llmConnection) {
                { }
            }
            if (event.sdkMessageId) {
                let cache = managed.piSdkMessageToCraftMessage;
                if (!cache) {
                    cache = new Map();
                    managed.piSdkMessageToCraftMessage = cache;
                }
                cache.set(event.sdkMessageId, assistantMessage.id);
                // Prune oldest entries when over the cap. Map preserves insertion
                // order, so the first key is the oldest.
                if (cache.size > PI_SDK_MESSAGE_ID_CACHE_LIMIT) {
                    const oldest = cache.keys().next().value;
                    if (oldest !== undefined)
                        cache.delete(oldest);
                }
            }
        }
        if (!event.isIntermediate) {
            const routingMeta = assistantMessage.routingMeta;
            sessionOperationContext.owner["emitExecutionTelemetry"](managed, {
                schemaVersion: 1,
                eventId: randomUUID(),
                timestamp: assistantMessage.timestamp,
                name: routingMeta?.fallbackFromConnectionSlug
                    ? 'routing.fallback'
                    : 'routing.selected',
                correlation: {
                    workspaceId,
                    sessionId,
                    ...(event.turnId ? { turnId: event.turnId } : {}),
                },
                connectionSlug: routingMeta?.connectionSlug,
                providerType: routingMeta?.providerType,
                model: routingMeta?.model,
                sensitivity: routingMeta?.sensitivity,
                policyRuleIds: routingMeta?.policyRuleIds,
                fallbackReason: routingMeta?.fallbackReason,
            });
        }
        sessionOperationContext.owner["sendEvent"]({ type: 'text_complete', sessionId, text: assistantMessage.content, isIntermediate: event.isIntermediate, turnId: event.turnId, parentToolUseId: event.parentToolUseId, timestamp: assistantMessage.timestamp, messageId: assistantMessage.id, routingMeta: assistantMessage.routingMeta, objectiveOutcome: assistantMessage.objectiveOutcome ?? null, objectiveOutcomeError: assistantMessage.objectiveOutcomeError ?? null }, workspaceId);
        // Persist session after complete message to prevent data loss on quit
        sessionOperationContext.owner["persistSession"](managed);
        return;
    }
}

export async function handleAgentPiTurnAnchor(sessionOperationContext: SessionOperationContext, managed: ManagedSession, event: Extract<AgentEvent, { type: 'pi_turn_anchor' }>, sessionId: string): Promise<void> {
    {
        // Follow-up to a `text_complete` from the Pi backend, carrying the
        // correct leaf id captured AFTER the SDK appended its assistant entry
        // (the synchronous `message_end` listener could not see it — #782).
        // Look up the Craft assistant message id by SDK message id and
        // persist the anchor to the sidecar.
        const cache = managed.piSdkMessageToCraftMessage;
        const craftMessageId = cache?.get(event.sdkMessageId);
        if (!craftMessageId) {
            sessionLog.debug(`pi_turn_anchor for unknown sdkMessageId=${event.sdkMessageId}; ignoring`);
            return;
        }
        const sessionPath = getSessionStoragePath(persistenceRootFor(managed), sessionId);
        try {
            await savePiTurnAnchor(sessionPath, craftMessageId, event.sdkTurnAnchor, () => sessionOpAssertPersistenceSessionPath(sessionOperationContext, managed, sessionPath));
        }
        catch (error) {
            sessionLog.warn(`Failed to persist Pi turn anchor for session ${sessionId}:`, error);
        }
        return;
    }
}

export async function handleAgentSteerUndelivered(sessionOperationContext: SessionOperationContext, managed: ManagedSession, event: Extract<AgentEvent, { type: 'steer_undelivered' }>, sessionId: string): Promise<void> {
    {
        // Steer message was not delivered (no PreToolUse fired before turn ended).
        // Re-queue it so it's sent as a normal message on the next turn.
        sessionLog.info(`Steer message undelivered, re-queuing for session ${sessionId}`);
        const correlated = managed.pendingUserSteers?.get(event.message);
        if (correlated) {
            const queuedMessage = managed.messages.find(message => message.id === correlated.queued.messageId);
            if (queuedMessage)
                queuedMessage.isQueued = true;
            if (!managed.messageQueue.some(item => item.messageId === correlated.queued.messageId)) {
                managed.messageQueue.push(correlated.queued);
            }
            if (managed.pendingTurnRecovery?.userMessageId === correlated.queued.messageId) {
                managed.activeObjective = correlated.objectiveBefore;
                managed.pendingTurnRecovery = correlated.recoveryBefore;
                rehydrateObjectiveEvidence(managed);
            }
        }
        else if (isAutonomyBrowserFallbackPrompt(event.message) || isAutonomyStructuredFallbackPrompt(event.message)) {
            const parsedFallbackIntent = parseAutonomyFallbackIntent(event.message);
            if (parsedFallbackIntent) {
                const fallbackIntent = isWorkspaceAutomaticToolFallbackEnabled(loadWorkspaceConfig(managed.workspace.rootPath)) ? parsedFallbackIntent : undefined;
                await sessionOperationContext.owner["enqueueAutomaticTurnRecovery"](managed, 'runtime_error', undefined, undefined, undefined, fallbackIntent);
            }
        }
        else {
            managed.messageQueue.push({ message: event.message });
        }
        managed.wasInterrupted = true;
        sessionOperationContext.owner["persistSession"](managed);
        return;
    }
}


