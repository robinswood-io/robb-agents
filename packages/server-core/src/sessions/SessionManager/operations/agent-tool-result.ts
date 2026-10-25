import type { SessionOperationContext } from '../operation-context.ts';
import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '@craft-agent/shared/agent';
import { decideAutonomyRecovery, recordObjectiveEvidence, resolveBrowserChannelDirective } from '@craft-agent/shared/agent';
import { getBrowserToolEnabled, isBrowserFallbackEligibleTool } from '@craft-agent/shared/config';
import { isWorkspaceAutomaticToolFallbackEnabled, loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import { loadAllSources } from '@craft-agent/shared/sources';
import { isParentTaskTool } from '@craft-agent/shared/utils/toolNames';
import { generateMessageId } from '@craft-agent/shared/protocol';
import type { Message } from '@craft-agent/core/types';
import { createPendingTurnRecovery } from '../../turn-recovery';
import { buildAutonomyFallbackPrompt, createAutonomyFallbackIntent } from '../../autonomy-browser-fallback';
import { objectiveEvidenceContractSegments, objectiveReviewBinding } from '../../objective-contract';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { resolveToolDisplayMeta } from '../tool-display.ts';
import { recordAutonomyEvent as sessionOpRecordAutonomyEvent } from './persist-tool-result-after-permission-expiry.ts';
import { redirectAutomaticToolFallback as sessionOpRedirectAutomaticToolFallback } from './redirect-automatic-tool-fallback.ts';
import { monotonic as sessionOpMonotonic } from './runtime-host.ts';
import { consumeDelegatedTerminalReceiptsFromWaitResult as sessionOpConsumeDelegatedTerminalReceiptsFromWaitResult } from './quarantine-stale-typed-upward-agent-delivery.ts';

export async function handleAgentToolResult(sessionOperationContext: SessionOperationContext, managed: ManagedSession, event: Extract<AgentEvent, { type: 'tool_result' }>, sessionId: string, workspaceId: string, generationKey: number): Promise<void> {
    {
        // toolName comes directly from CraftAgent (resolved via ToolIndex)
        const toolName = event.toolName || 'unknown';
        // JSON selectors and exact-text criteria must see the actual result.
        // Presentation rewrites can change both target identity and JSON data.
        const rawFormattedResult = event.result ?? '';
        // Safety net: prevent massive tool results from bloating session JSONL (protects all backends)
        const MAX_PERSISTED_RESULT_CHARS = 200000; // ~50K tokens
        const formattedResult = rawFormattedResult.length > MAX_PERSISTED_RESULT_CHARS
            ? rawFormattedResult.slice(0, MAX_PERSISTED_RESULT_CHARS) +
                `\n\n[Truncated for storage: ${rawFormattedResult.length.toLocaleString()} chars total]`
            : rawFormattedResult;
        // A host checkpoint is a successfully delivered result envelope, but
        // it is explicitly not a successful tool execution. Keep it outside
        // both the operational-error and verified-evidence paths.
        const toolWasExecuted = event.executed !== false;
        const activeObjectiveIndex = managed.activeObjective
            ? managed.messages.findIndex(message => message.id === managed.activeObjective?.userMessageId)
            : -1;
        const startedToolIndex = managed.messages.findIndex(message => message.toolUseId === event.toolUseId);
        const starts = sessionOperationContext.state.checkpointToolStarts.get(managed);
        const checkpointOwner = starts?.generation === generationKey
            ? starts.calls.get(event.toolUseId)
            : undefined;
        // Evidence and recovery side effects require the immutable runtime,
        // generation, objective revision and acceptance binding captured at
        // tool_start. A result-only or late pre-amendment event is UI history,
        // never evidence for the current objective.
        const belongsToActiveObjective = !!checkpointOwner
            && starts?.generation === generationKey
            && generationKey === managed.processingGeneration
            && checkpointOwner.objective === managed.activeObjective
            && checkpointOwner.authorityEpoch === (sessionOperationContext.state.objectiveAuthorityEpochs.get(managed) ?? 0)
            && checkpointOwner.acceptanceRevision
                === (managed.activeObjective?.acceptanceRevision ?? managed.activeObjective?.userMessageId)
            && checkpointOwner.acceptanceSha256
                === (managed.activeObjective ? objectiveReviewBinding(managed.activeObjective).acceptanceSha256 : undefined)
            && checkpointOwner.toolName === toolName
            && activeObjectiveIndex >= 0 && startedToolIndex > activeObjectiveIndex;
        // Some backends omit explicit isError but still prefix with [ERROR].
        const inferredError = toolWasExecuted
            && (event.isError === true || /^\s*(\[ERROR\]|Error:|error:)/.test(formattedResult));
        if (toolWasExecuted && belongsToActiveObjective) {
            const sessionIds = managed.messages[startedToolIndex]?.toolInput?.sessionIds;
            recordObjectiveEvidence(managed.id, toolName, formattedResult, inferredError, managed.activeObjective ? {
                ...objectiveReviewBinding(managed.activeObjective),
                ...(Array.isArray(sessionIds) && sessionIds.every(id => typeof id === 'string') ? { sessionIds } : {}),
            } : undefined, managed.messages[startedToolIndex]?.toolInput);
        }
        starts?.calls.delete(event.toolUseId);
        if (event.continuationRequired === true && event.executed === false && event.isError !== true
            && event.checkpoint?.schemaVersion === 1 && event.checkpoint.kind === 'tool-call-budget'
            && !sessionOperationContext.state.shuttingDown && !managed.stopRequested && managed.isProcessing
            && generationKey === managed.processingGeneration && starts?.generation === generationKey
            && managed.activeObjective?.terminalState === 'active'
            && !!checkpointOwner
            && checkpointOwner.objective === managed.activeObjective
            && checkpointOwner.objectiveId === managed.activeObjective.userMessageId
            && checkpointOwner.toolName === toolName
            && activeObjectiveIndex >= 0 && startedToolIndex > activeObjectiveIndex) {
            if (!managed.pendingTurnRecovery) {
                const anchor = managed.messages.slice(activeObjectiveIndex, startedToolIndex).findLast(message => (message.role === 'user' && !message.isQueued && !message.isPending && !message.hidden && !message.internalOrigin));
                const delegated = managed.messages[activeObjectiveIndex];
                const delegatedAnchor = delegated?.role === 'user' && !delegated.hidden && !delegated.isQueued && !delegated.isPending
                    && delegated.internalOrigin?.kind === 'spawned-session'
                    && delegated.internalOrigin.senderSessionId === managed.parentSessionId ? delegated : undefined;
                const owner = anchor ?? delegatedAnchor;
                if (owner) {
                    managed.pendingTurnRecovery = {
                        ...createPendingTurnRecovery(owner.id, owner.timestamp),
                        budgetHistoryUnavailable: true,
                        // Preserve the same fail-closed stop on a bundle rollback.
                        exhaustedAt: Date.now(),
                    };
                }
            }
            if (managed.pendingTurnRecovery) {
                managed.pendingTurnRecovery = { ...managed.pendingTurnRecovery, continuationRequired: true };
                sessionOperationContext.owner["persistSession"](managed);
                sessionLog.warn('Host tool checkpoint requires a continuation pass', { sessionId, toolName, toolUseId: event.toolUseId });
            }
        }
        if (toolWasExecuted && belongsToActiveObjective && !inferredError) {
            sessionOpRecordAutonomyEvent(sessionOperationContext, managed, {
                phase: 'verified', toolName,
                message: `${toolName} completed successfully.`,
            });
        }
        if (!sessionOperationContext.state.shuttingDown && inferredError && belongsToActiveObjective) {
            const evidence = formattedResult.slice(0, 1000);
            const objectiveAuthorizationSegments = managed.activeObjective
                ? objectiveEvidenceContractSegments(managed.messages, managed.activeObjective)
                    .map(segment => segment.text)
                : undefined;
            const browserChannelDirective = resolveBrowserChannelDirective(undefined, objectiveAuthorizationSegments);
            // A handoff/visual-validation allowance is intentionally scoped to
            // that phase. It cannot turn an operational API/connector failure
            // into an automatic browser retry.
            const browserChannelAllowed = browserChannelDirective === 'none'
                || browserChannelDirective === 'browser';
            const automaticToolFallbackEnabled = isWorkspaceAutomaticToolFallbackEnabled(loadWorkspaceConfig(managed.workspace.rootPath));
            const proposedRecoveryDecision = decideAutonomyRecovery({
                toolName,
                result: formattedResult,
                browserEnabled: getBrowserToolEnabled(),
                fallbackAlreadyAttempted: managed.autonomyFallbackAttemptedTools?.has(toolName) ?? false,
                browserFallbackEligible: automaticToolFallbackEnabled
                    && browserChannelAllowed && isBrowserFallbackEligibleTool(toolName, loadWorkspaceConfig(managed.workspace.rootPath)?.costControl),
            });
            const decision = !automaticToolFallbackEnabled
                && (proposedRecoveryDecision.kind === 'fallback_browser'
                    || proposedRecoveryDecision.kind === 'fallback_structured')
                ? { kind: 'none' as const }
                : proposedRecoveryDecision;
            sessionOpRecordAutonomyEvent(sessionOperationContext, managed, {
                phase: 'diagnosis', toolName,
                message: `Diagnosed tool failure in ${toolName}.`, evidence,
            });
            if (decision.kind === 'escalate') {
                sessionOpRecordAutonomyEvent(sessionOperationContext, managed, {
                    phase: 'escalated', toolName,
                    message: decision.reason === 'oauth_or_mfa'
                        ? 'Human authentication or MFA is required.'
                        : decision.reason === 'credential_required'
                            ? 'Human credential input is required.'
                            : 'Access remained unavailable after the safe fallback path.',
                    evidence,
                    escalationReason: decision.reason,
                });
            }
            else if (decision.kind === 'fallback_browser') {
                managed.autonomyFallbackAttemptedTools ??= new Set();
                managed.autonomyFallbackAttemptedTools.add(toolName);
                const fallbackIntent = createAutonomyFallbackIntent('browser_fallback', toolName);
                const fallbackPrompt = buildAutonomyFallbackPrompt(fallbackIntent);
                const deliveredInCurrentTurn = sessionOpRedirectAutomaticToolFallback(sessionOperationContext, managed, generationKey, fallbackIntent, fallbackPrompt);
                const fallbackQueued = !deliveredInCurrentTurn
                    && await sessionOperationContext.owner["enqueueAutomaticTurnRecovery"](managed, 'runtime_error', undefined, undefined, undefined, fallbackIntent);
                sessionOpRecordAutonomyEvent(sessionOperationContext, managed, {
                    phase: 'fallback', toolName,
                    message: deliveredInCurrentTurn
                        ? 'Steered the active agent to the integrated browser as a materially different fallback.'
                        : fallbackQueued
                            ? 'Queued a bounded hidden continuation through the integrated browser.'
                            : 'The integrated-browser fallback was not queued because automatic recovery is unavailable or exhausted.',
                    evidence,
                });
            }
            else if (decision.kind === 'fallback_structured') {
                managed.autonomyFallbackAttemptedTools ??= new Set();
                managed.autonomyFallbackAttemptedTools.add(toolName);
                const fallbackIntent = createAutonomyFallbackIntent('structured_fallback', toolName);
                const fallbackPrompt = buildAutonomyFallbackPrompt(fallbackIntent);
                const deliveredInCurrentTurn = sessionOpRedirectAutomaticToolFallback(sessionOperationContext, managed, generationKey, fallbackIntent, fallbackPrompt);
                const fallbackQueued = !deliveredInCurrentTurn
                    && await sessionOperationContext.owner["enqueueAutomaticTurnRecovery"](managed, 'runtime_error', undefined, undefined, undefined, fallbackIntent);
                sessionOpRecordAutonomyEvent(sessionOperationContext, managed, {
                    phase: 'fallback', toolName,
                    message: deliveredInCurrentTurn
                        ? 'Steered the active agent to native remote, SSH, database or API access after the browser failure.'
                        : fallbackQueued
                            ? 'Queued a bounded continuation through a structured access path.'
                            : 'The structured-access fallback was not queued because automatic recovery is unavailable or exhausted.',
                    evidence,
                });
            }
            else if (decision.kind === 'reconnect_runtime') {
                sessionOpRecordAutonomyEvent(sessionOperationContext, managed, {
                    phase: 'fallback', toolName,
                    message: 'Execution runtime bridge is unavailable; reconnect the runtime before retrying.', evidence,
                });
            }
        }
        // Update existing tool message (created on tool_start) instead of creating new one
        const existingToolMsg = managed.messages.find(m => m.toolUseId === event.toolUseId);
        // Track if already completed to avoid sending duplicate events
        const wasAlreadyComplete = existingToolMsg?.toolStatus === 'completed';
        const previousResult = existingToolMsg?.toolResult;
        const previouslyExecuted = existingToolMsg?.toolExecuted;
        sessionLog.info(`RESULT MATCH: toolUseId=${event.toolUseId}, found=${!!existingToolMsg}, toolName=${existingToolMsg?.toolName || toolName}, wasComplete=${wasAlreadyComplete}, executed=${toolWasExecuted}`);
        // parentToolUseId comes from CraftAgent (SDK-authoritative) or existing message
        const parentToolUseId = existingToolMsg?.parentToolUseId || event.parentToolUseId;
        if (existingToolMsg) {
            // Keep lightweight status text in `content` and store full payload in `toolResult` only.
            existingToolMsg.toolResult = formattedResult;
            existingToolMsg.toolStatus = inferredError ? 'error' : 'completed';
            existingToolMsg.isError = inferredError;
            existingToolMsg.toolExecuted = toolWasExecuted;
            if (event.checkpoint) {
                existingToolMsg.toolCheckpoint = event.checkpoint;
            }
            else if (toolWasExecuted) {
                delete existingToolMsg.toolCheckpoint;
            }
            // If message doesn't have parent set, use event's parentToolUseId
            if (!existingToolMsg.parentToolUseId && event.parentToolUseId) {
                existingToolMsg.parentToolUseId = event.parentToolUseId;
            }
        }
        else {
            // No matching tool_start found — create message from result.
            // This is normal for background subagent child tools where tool_result arrives
            // without a prior tool_start. If tool_start arrives later, findToolMessage will
            // locate this message by toolUseId and update it with input/intent/displayMeta.
            sessionLog.info(`RESULT WITHOUT START: toolUseId=${event.toolUseId}, toolName=${toolName} (creating message from result)`);
            const fallbackWorkspaceRootPath = managed.workspace.rootPath;
            const fallbackSources = loadAllSources(fallbackWorkspaceRootPath);
            const fallbackToolDisplayMeta = await resolveToolDisplayMeta(toolName, undefined, fallbackWorkspaceRootPath, fallbackSources);
            const toolMessage: Message = {
                id: generateMessageId(),
                role: 'tool',
                content: '',
                timestamp: sessionOpMonotonic(sessionOperationContext),
                toolName: toolName,
                toolUseId: event.toolUseId,
                toolResult: formattedResult,
                toolStatus: inferredError ? 'error' : 'completed',
                toolExecuted: toolWasExecuted,
                ...(event.checkpoint ? { toolCheckpoint: event.checkpoint } : {}),
                toolDisplayMeta: fallbackToolDisplayMeta,
                parentToolUseId,
                isError: inferredError,
            };
            managed.messages.push(toolMessage);
        }
        const completedToolMessage = managed.messages.find(message => message.toolUseId === event.toolUseId);
        const consumedWaitTerminalReceipt = toolWasExecuted && !inferredError
            && sessionOpConsumeDelegatedTerminalReceiptsFromWaitResult(sessionOperationContext, managed, completedToolMessage, formattedResult);
        // Send event to renderer if: (a) first completion, or (b) result content changed
        // (e.g., safety net auto-completed with empty result, then real result arrived later)
        const resultChanged = wasAlreadyComplete && (previousResult !== formattedResult || previouslyExecuted !== toolWasExecuted);
        if (!wasAlreadyComplete || resultChanged) {
            // Use existing tool message timestamp, or fallback message timestamp for ordering
            const toolResultTimestamp = existingToolMsg?.timestamp ?? (managed.messages.find(m => m.toolUseId === event.toolUseId)?.timestamp);
            sessionOperationContext.owner["sendEvent"]({
                type: 'tool_result',
                sessionId,
                toolUseId: event.toolUseId,
                toolName: toolName,
                result: formattedResult,
                turnId: event.turnId,
                parentToolUseId,
                isError: inferredError,
                executed: toolWasExecuted,
                ...(event.checkpoint ? { checkpoint: event.checkpoint } : {}),
                timestamp: toolResultTimestamp,
            }, workspaceId);
        }
        if ((!wasAlreadyComplete || previouslyExecuted === false || !previousResult) && toolWasExecuted) {
            const completedAt = Date.now();
            sessionOperationContext.owner["emitExecutionTelemetry"](managed, {
                schemaVersion: 1,
                eventId: randomUUID(),
                timestamp: completedAt,
                name: inferredError ? 'tool.failed' : 'tool.completed',
                correlation: {
                    workspaceId,
                    sessionId,
                    ...(event.turnId ? { turnId: event.turnId } : {}),
                    toolCallId: event.toolUseId,
                },
                toolName,
                outcome: inferredError ? 'failed' : 'success',
                ...(existingToolMsg
                    ? { durationMs: Math.max(0, completedAt - existingToolMsg.timestamp) }
                    : {}),
                ...(inferredError ? { errorCode: 'tool_error' } : {}),
            });
        }
        // Safety net: when a parent Task completes, mark all its still-pending child tools as completed.
        // This handles the case where child tool_result events never arrive (e.g., subagent internal tools
        // whose results aren't surfaced through the parent stream).
        if (toolWasExecuted && (isParentTaskTool(toolName) || toolName === 'TaskOutput')) {
            const pendingChildren = managed.messages.filter(m => m.parentToolUseId === event.toolUseId
                && m.toolStatus !== 'completed'
                && m.toolStatus !== 'error');
            for (const child of pendingChildren) {
                child.toolStatus = 'completed';
                child.toolResult = child.toolResult || '';
                sessionLog.info(`CHILD AUTO-COMPLETED: toolUseId=${child.toolUseId}, toolName=${child.toolName} (parent ${toolName} completed)`);
                sessionOperationContext.owner["sendEvent"]({
                    type: 'tool_result',
                    sessionId,
                    toolUseId: child.toolUseId!,
                    toolName: child.toolName || 'unknown',
                    result: child.toolResult || '',
                    turnId: child.turnId,
                    parentToolUseId: event.toolUseId,
                }, workspaceId);
                sessionOperationContext.owner["emitExecutionTelemetry"](managed, {
                    schemaVersion: 1,
                    eventId: randomUUID(),
                    timestamp: Date.now(),
                    name: 'tool.completed',
                    correlation: {
                        workspaceId,
                        sessionId,
                        ...(child.turnId ? { turnId: child.turnId } : {}),
                        ...(child.toolUseId ? { toolCallId: child.toolUseId } : {}),
                    },
                    toolName: child.toolName || 'unknown',
                    outcome: 'success',
                    durationMs: Math.max(0, Date.now() - child.timestamp),
                });
            }
        }
        // Persist session after tool completes to prevent data loss on quit
        sessionOperationContext.owner["persistSession"](managed);
        if (consumedWaitTerminalReceipt) {
            // The wait result and receipt acknowledgement are one crash-safe
            // transaction. A restart can observe neither or both, never a saved
            // finalText followed by a duplicate raw terminal delivery.
            await sessionOperationContext.owner.flushSession(managed.id);
        }
        return;
    }
}


