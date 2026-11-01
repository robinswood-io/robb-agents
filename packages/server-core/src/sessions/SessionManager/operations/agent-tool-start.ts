import type { SessionEvent } from '../../../../../shared/src/protocol/dto/session-events.ts';
import { omitUndefined } from '@craft-agent/shared/utils/json';
import type { SessionOperationContext } from '../operation-context.ts';
import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '@craft-agent/shared/agent';
import { MODEL_REGISTRY } from '@craft-agent/shared/config';
import { loadAllSources } from '@craft-agent/shared/sources';
import { generateMessageId } from '@craft-agent/shared/protocol';
import type { Message, ToolDisplayMeta } from '@craft-agent/core/types';
import { objectiveReviewBinding } from '../../objective-contract';
import { shouldActivateBrowserOverlay } from '@craft-agent/server-core/domain';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { resolveToolDisplayMeta } from '../tool-display.ts';
import { recordAutonomyEvent as sessionOpRecordAutonomyEvent } from './persist-tool-result-after-permission-expiry.ts';
import { monotonic as sessionOpMonotonic } from './runtime-host.ts';

export async function handleAgentToolStart(sessionOperationContext: SessionOperationContext, managed: ManagedSession, event: Extract<AgentEvent, { type: 'tool_start' }>, sessionId: string, workspaceId: string, generationKey: number): Promise<void> {
    {
        if (managed.isProcessing && !managed.stopRequested && generationKey === managed.processingGeneration
            && managed.activeObjective?.terminalState === 'active') {
            const objectiveAtStart = managed.activeObjective;
            let starts = sessionOperationContext.state.checkpointToolStarts.get(managed);
            if (starts?.generation !== generationKey) {
                starts = { generation: generationKey, calls: new Map() };
                sessionOperationContext.state.checkpointToolStarts.set(managed, starts);
            }
            if (!starts.calls.has(event.toolUseId)) {
                starts.calls.set(event.toolUseId, {
                    objective: objectiveAtStart,
                    objectiveId: objectiveAtStart.userMessageId,
                    acceptanceRevision: objectiveAtStart.acceptanceRevision ?? objectiveAtStart.userMessageId,
                    acceptanceSha256: objectiveReviewBinding(objectiveAtStart).acceptanceSha256,
                    authorityEpoch: sessionOperationContext.state.objectiveAuthorityEpochs.get(managed) ?? 0,
                    toolName: event.toolName,
                });
            }
        }
        // Inputs are evidence. Preserve exact paths, commands and provider
        // arguments in the transcript and renderer, including after reload.
        const toolInput = event.input ? structuredClone(event.input) : event.input;
        const formattedToolInput = toolInput ? structuredClone(toolInput) : toolInput;
        sessionOpRecordAutonomyEvent(sessionOperationContext, managed, {
            phase: 'attempt', toolName: event.toolName,
            message: `Attempting ${event.toolName}.`,
        });
        // Resolve call_llm model for TurnCard badge display.
        // Resolve call_llm model short names to full IDs for display.
        // Pi supplies the explicit model or the model selected in the parent session.
        if (event.toolName === 'mcp__session__call_llm' && formattedToolInput?.["model"]) {
            const shortName = String(formattedToolInput["model"]);
            const modelDef = MODEL_REGISTRY.find(m => m.id === shortName)
                || MODEL_REGISTRY.find(m => m.shortName.toLowerCase() === shortName.toLowerCase())
                || MODEL_REGISTRY.find(m => m.name.toLowerCase() === shortName.toLowerCase());
            if (modelDef) {
                formattedToolInput["model"] = modelDef.id;
            }
        }
        // Resolve tool display metadata (icon, displayName) for skills/sources
        // Only resolve when we have input (second event for SDK dual-event pattern)
        const workspaceRootPath = managed.workspace.rootPath;
        let toolDisplayMeta: ToolDisplayMeta | undefined;
        if (formattedToolInput && Object.keys(formattedToolInput).length > 0) {
            const allSources = loadAllSources(workspaceRootPath);
            toolDisplayMeta = await resolveToolDisplayMeta(event.toolName, formattedToolInput, workspaceRootPath, allSources);
        }
        // Permission denial and orderly shutdown can race the asynchronous
        // display-metadata lookup above. Re-check the generation tombstone
        // before inserting/updating a tool row; the denial path has already
        // materialized and flushed the authoritative non-execution receipt.
        const deniedDuringDisplayResolution = sessionOperationContext.state.permissionDeniedToolUseIdsByGeneration
            .get(managed)?.get(generationKey)?.has(event.toolUseId) === true;
        const startOwner = sessionOperationContext.state.checkpointToolStarts.get(managed)?.calls.get(event.toolUseId);
        const startStillCurrent = !!startOwner
            && startOwner.objective === managed.activeObjective
            && startOwner.authorityEpoch === (sessionOperationContext.state.objectiveAuthorityEpochs.get(managed) ?? 0)
            && startOwner.acceptanceRevision
                === (managed.activeObjective?.acceptanceRevision ?? managed.activeObjective?.userMessageId)
            && startOwner.acceptanceSha256
                === (managed.activeObjective ? objectiveReviewBinding(managed.activeObjective).acceptanceSha256 : undefined);
        if (deniedDuringDisplayResolution) {
            const starts = sessionOperationContext.state.checkpointToolStarts.get(managed);
            if (starts?.generation === generationKey)
                starts.calls.delete(event.toolUseId);
            sessionLog.info('Ignoring tool start denied during display resolution', {
                sessionId,
                generation: generationKey,
                toolUseId: event.toolUseId,
            });
            return;
        }
        if (!startStillCurrent) {
            // The external execution may already have started before the host
            // observed the supersession. Retain a non-authoritative audit row so
            // recovery and duplicate detection can see the uncertain effect, but
            // drop its immutable owner so no later result can become evidence for
            // the replacement objective.
            const starts = sessionOperationContext.state.checkpointToolStarts.get(managed);
            if (starts?.generation === generationKey)
                starts.calls.delete(event.toolUseId);
            sessionLog.info('Retaining non-authoritative tool start superseded during display resolution', {
                sessionId,
                generation: generationKey,
                toolUseId: event.toolUseId,
            });
        }
        // Check if a message with this toolUseId already exists FIRST
        // SDK sends two events per tool: first from stream_event (empty input),
        // second from assistant message (complete input)
        const existingStartMsg = managed.messages.find(m => m.toolUseId === event.toolUseId);
        const isDuplicateEvent = !!existingStartMsg;
        // Use parentToolUseId directly from the event — CraftAgent resolves this
        // from SDK's parent_tool_use_id (authoritative, handles parallel Tasks correctly).
        // No stack or map needed; the event carries the correct parent from the start.
        const parentToolUseId = event.parentToolUseId;
        // Track if we need to send an event to the renderer
        // Send on: first occurrence OR when we have new input data to update
        let shouldSendEvent = !isDuplicateEvent;
        if (existingStartMsg) {
            // Update existing message with complete input (second event has full input)
            // Once PreToolUse has consumed the one-shot admission, that durable
            // row contains the exact normalized payload approved for execution.
            // Pi may still publish its second SDK tool_start afterwards; never
            // let that late provider payload rewrite the execution receipt.
            if (formattedToolInput && Object.keys(formattedToolInput).length > 0
                && startOwner?.durableAdmissionClaimed !== true) {
                const hadInputBefore = existingStartMsg.toolInput && Object.keys(existingStartMsg.toolInput).length > 0;
                existingStartMsg.toolInput = toolInput;
                // Send update event if we're adding input that wasn't there before
                if (!hadInputBefore) {
                    shouldSendEvent = true;
                }
            }
            // Also set parent if not already set
            if (parentToolUseId && !existingStartMsg.parentToolUseId) {
                existingStartMsg.parentToolUseId = parentToolUseId;
                shouldSendEvent = true;
            }
            // Set toolDisplayMeta if not already set (has base64 icon for viewer)
            if (toolDisplayMeta && !existingStartMsg.toolDisplayMeta) {
                existingStartMsg.toolDisplayMeta = toolDisplayMeta;
                shouldSendEvent = true;
            }
            // Update toolIntent if not already set (second event has intent from complete input)
            if (event.intent && !existingStartMsg.toolIntent) {
                existingStartMsg.toolIntent = event.intent;
                shouldSendEvent = true;
            }
            // Update toolDisplayName if not already set
            if (event.displayName && !existingStartMsg.toolDisplayName) {
                existingStartMsg.toolDisplayName = event.displayName;
                shouldSendEvent = true;
            }
        }
        else {
            // Add tool message immediately (will be updated on tool_result)
            // This ensures tool calls are persisted even if they don't complete
            const toolStartMessage: Message = {
                id: generateMessageId(),
                role: 'tool',
                content: `Running ${event.toolName}...`,
                timestamp: sessionOpMonotonic(sessionOperationContext),
                toolName: event.toolName,
                toolUseId: event.toolUseId,
                toolInput,
                toolStatus: 'executing',
                ...(event.intent !== undefined ? { toolIntent: event.intent } : {}),
                ...(event.displayName !== undefined ? { toolDisplayName: event.displayName } : {}),
                ...(toolDisplayMeta !== undefined ? { toolDisplayMeta: toolDisplayMeta } : {}), // Includes base64 icon for viewer compatibility
                ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
                ...(parentToolUseId !== undefined ? { parentToolUseId: parentToolUseId } : {}),
            };
            managed.messages.push(toolStartMessage);
        }
        // The autonomy event saved a snapshot before this tool was added or
        // updated. Queue the actual start now so quit can retain its identity
        // and inputs even when no result or later event ever arrives.
        sessionOperationContext.owner["persistSession"](managed);
        if (!isDuplicateEvent) {
            const toolStartTimestamp = managed.messages.find(message => message.toolUseId === event.toolUseId)?.timestamp ?? sessionOpMonotonic(sessionOperationContext);
            sessionOperationContext.owner["emitExecutionTelemetry"](managed, {
                schemaVersion: 1,
                eventId: randomUUID(),
                timestamp: toolStartTimestamp,
                name: 'tool.started',
                correlation: {
                    workspaceId,
                    sessionId,
                    ...(event.turnId ? { turnId: event.turnId } : {}),
                    toolCallId: event.toolUseId,
                },
                toolName: event.toolName,
            });
        }
        // Activate browser agent control overlay on actionable browser tool starts.
        // Skip browser_tool help/release commands to avoid pointless overlay flashes.
        const shouldActivateOverlay = shouldActivateBrowserOverlay(event.toolName, formattedToolInput);
        const overlayBpm = sessionOperationContext.owner.getBrowserPaneManagerForSession(sessionId);
        if (overlayBpm && shouldActivateOverlay) {
            // Ensure first browser action in a turn gets an instance before overlay activation.
            overlayBpm.getOrCreateForSession(sessionId, { workspaceId });
            const resolvedDisplayName = toolDisplayMeta?.displayName
                ?? event.displayName
                ?? event.toolName;
            overlayBpm.setAgentControl(sessionId, { displayName: resolvedDisplayName, ...(event.intent !== undefined ? { intent: event.intent } : {}) }, { workspaceId });
        }
        // Send event to renderer on first occurrence OR when input data is updated
        if (shouldSendEvent) {
            const timestamp = existingStartMsg?.timestamp ?? sessionOpMonotonic(sessionOperationContext);
            sessionOperationContext.owner["sendEvent"](omitUndefined<Extract<SessionEvent, { type: 'tool_start' }>>({
                type: 'tool_start',
                sessionId,
                toolName: event.toolName,
                toolUseId: event.toolUseId,
                toolInput: existingStartMsg?.toolInput ?? toolInput ?? {},
                toolIntent: event.intent,
                toolDisplayName: event.displayName,
                toolDisplayMeta, // Includes base64 icon for viewer compatibility
                turnId: event.turnId,
                parentToolUseId,
                timestamp,
            }), workspaceId);
        }
        return;
    }
}


