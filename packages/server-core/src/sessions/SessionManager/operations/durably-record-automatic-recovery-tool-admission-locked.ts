import { enforceUncertainToolEffectPolicy } from './uncertain-tool-effect-policy.ts';
import type { SessionOperationContext } from '../operation-context.ts';
import { persistenceRootFor, isLegacyHostObjectiveContractEnabled } from '../policy.ts';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AutonomyEvent } from '@craft-agent/core';
import { ToolAdmissionRecoveryError, TERMINAL_RECONCILIATION_CAPABILITY_FIELD } from '@craft-agent/shared/agent';
import { isWorkspaceAutomaticToolFallbackEnabled, loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import { loadSession as loadStoredSession } from '@craft-agent/shared/sessions';
import { generateMessageId } from '@craft-agent/shared/protocol';
import type { Message } from '@craft-agent/core/types';
import { objectiveReviewBinding } from '../../objective-contract';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { DELEGATED_TERMINAL_RESULT_PROTOCOL } from '../runtime-policy.ts';
import type { AgentInstance } from '../runtime-types.ts';
import { monotonic as sessionOpMonotonic } from './runtime-host.ts';

async function sessionOpDurablyRecordAutomaticRecoveryToolAdmissionLocked(sessionOperationContext: SessionOperationContext, managed: ManagedSession, runtimeAgent: AgentInstance, request: {
    toolUseId?: string;
    toolName: string;
    toolInput: Record<string, unknown>;
}): Promise<void> {
    let binding = sessionOperationContext.state.runtimeToolAdmissionBindings.get(runtimeAgent);
    if (!binding) {
        throw new Error('Tool admission has no exact provider-handoff binding');
    }
    // redirect() can synchronously enqueue a provider steer while the accepted
    // user row and replacement objective are still crossing their durability
    // fence. Follow every chained steer barrier: a second steer can arrive while
    // the first flush is completing.
    while (binding.pendingRebind) {
        await binding.pendingRebind;
        const current = sessionOperationContext.state.runtimeToolAdmissionBindings.get(runtimeAgent);
        if (!current)
            throw new Error('Tool admission lost its provider-handoff binding during steer');
        binding = current;
    }
    const generation = sessionOperationContext.state.runtimeProcessingGenerations.get(runtimeAgent);
    const recovery = binding.automaticRecovery;
    const pending = binding.pendingTurnRecovery;
    const dispatch = binding.recoveryDispatch;
    const explicitRetryMessageBoundary = recovery?.cause === 'user_retry'
        && dispatch?.origin === 'retry'
        && pending?.recoveryDispatch === dispatch
        && Number.isSafeInteger(pending.userRetryFromMessageCount)
        && pending.userRetryFromMessageCount! > 0
        ? pending.userRetryFromMessageCount
        : undefined;
    const cleanExplicitRetryBoundary = explicitRetryMessageBoundary !== undefined
        && !!dispatch?.cleanContinuationId
        && dispatch.id === binding.userMessageId
        && binding.userMessage.hidden === true;
    const hasExactDeferredMachineInboxFifo = (message: {
        id: string;
        content: string;
        internalOrigin?: Message['internalOrigin'];
        agentDelivery?: Message['agentDelivery'];
    }): boolean => managed.messageQueue.filter(item => (item.messageId === message.id
        && item.message === message.content
        && item.options?.internalOrigin?.kind === 'agent-message'
        && message.internalOrigin?.kind === 'agent-message'
        && item.options.internalOrigin.senderSessionId === message.internalOrigin.senderSessionId
        && item.options.internalOrigin.deliveryId === message.internalOrigin.deliveryId
        && message.agentDelivery?.id === message.internalOrigin.deliveryId)).length === 1;
    const isWaitConsumedDelegatedReceipt = (message: {
        hidden?: boolean;
        isQueued?: boolean;
        providerDispatch?: Message['providerDispatch'];
        content: string;
        internalOrigin?: Message['internalOrigin'];
        agentDelivery?: Message['agentDelivery'];
    }): boolean => (message.hidden === true
        && message.isQueued !== true
        && !message.providerDispatch
        && message.agentDelivery?.status === 'processed'
        && message.internalOrigin?.kind === 'agent-message'
        && message.internalOrigin.deliveryId === message.agentDelivery.id
        && message.content.startsWith(DELEGATED_TERMINAL_RESULT_PROTOCOL));
    const isDeferredMachineInboxUser = (message: Message): boolean => (message.role === 'user'
        && ((message.hidden === true
            && message.isQueued === true
            && message.agentDelivery?.status === 'queued'
            && message.internalOrigin?.kind === 'agent-message'
            && message.internalOrigin.deliveryId === message.agentDelivery.id
            && hasExactDeferredMachineInboxFifo(message))
            || isWaitConsumedDelegatedReceipt(message)));
    const boundAgentDelivery = binding.userMessage.internalOrigin?.kind === 'agent-message'
        && binding.userMessage.agentDelivery?.id === binding.userMessage.internalOrigin.deliveryId
        && binding.lastSentOptions?.internalOrigin?.kind === 'agent-message'
        && binding.lastSentOptions.internalOrigin.deliveryId === binding.userMessage.agentDelivery?.id;
    const latestBoundUserMessage = (): Message | undefined => {
        const userMessages = managed.messages.filter(message => message.role === 'user');
        const exactMessages = userMessages.filter(message => message.id === binding.userMessageId);
        const exact = exactMessages[0];
        if (exactMessages.length !== 1 || !exact)
            return undefined;
        const exactIndex = managed.messages.indexOf(exact);
        if (exactIndex < 0)
            return undefined;
        if (boundAgentDelivery) {
            // A child result can remain durably queued while later human answers
            // and recovery turns are processed. Its provider turn starts only when
            // that exact delivery is dequeued. Historical rows before this handoff
            // cannot supersede it; a new human row after the handoff still can.
            if (exactIndex >= binding.messageCountAtHandoff
                || managed.messages.length < binding.messageCountAtHandoff
                || managed.messages.slice(binding.messageCountAtHandoff).some(message => (message.role === 'user' && !isDeferredMachineInboxUser(message))))
                return undefined;
        }
        else if (explicitRetryMessageBoundary !== undefined) {
            // Retry deliberately reuses the latest accepted human/delegated root
            // instead of appending its host-authored recovery prompt to the
            // transcript. Historical automatic-recovery rows therefore follow the
            // anchor. Bind the provider turn to the exact persisted message-count
            // fence minted by retryTurn(), while still rejecting every later human
            // turn. Deferred machine inbox rows remain outside the active turn.
            if (cleanExplicitRetryBoundary) {
                if (exactIndex !== explicitRetryMessageBoundary
                    || managed.messages.slice(exactIndex + 1).some(message => (message.role === 'user' && !isDeferredMachineInboxUser(message))))
                    return undefined;
            }
            else if (exactIndex >= explicitRetryMessageBoundary
                || explicitRetryMessageBoundary > managed.messages.length
                || managed.messages.slice(explicitRetryMessageBoundary).some(message => (message.role === 'user' && !isDeferredMachineInboxUser(message))))
                return undefined;
        }
        else if (managed.messages.slice(exactIndex + 1).some(message => (message.role === 'user' && !isDeferredMachineInboxUser(message))))
            return undefined;
        return exact;
    };
    const ownsExactTurn = (): boolean => (!sessionOperationContext.state.shuttingDown
        && binding.managed === managed
        && binding.sessionId === managed.id
        && sessionOperationContext.state.sessions.get(managed.id) === managed
        && managed.agent === runtimeAgent
        && managed.isProcessing
        && !managed.stopRequested
        && generation !== undefined
        && binding.generation === generation
        && generation === managed.processingGeneration
        && managed.activeObjective === binding.activeObjective
        && (sessionOperationContext.state.objectiveAuthorityEpochs.get(managed) ?? 0) === binding.authorityEpoch
        && managed.lastSentOptions === binding.lastSentOptions
        && latestBoundUserMessage() === binding.userMessage);
    const ownsExactStartedDispatch = (): boolean => !recovery || (ownsExactTurn()
        && managed.lastSentOptions?.automaticRecovery === recovery
        // Permission handoffs persist `waitingForPermission` by replacing the
        // pending snapshot. The same started dispatch still owns this turn;
        // revocation or a newer dispatch changes its identity below.
        && managed.pendingTurnRecovery?.userMessageId === pending?.userMessageId
        && managed.pendingTurnRecovery?.recoveryDispatch === dispatch
        && pending?.recoveryDispatch === dispatch
        && dispatch?.schemaVersion === 1
        && dispatch.phase === 'started'
        && dispatch.preToolExecutionReceiptVersion === 1
        && Number.isFinite(dispatch.startedAt)
        && recovery.originalUserMessageId === pending?.userMessageId
        && recovery.dispatchId === dispatch.id
        && recovery.dispatchAttempt === dispatch.attempt
        && recovery.dispatchOrigin === dispatch.origin
        && recovery.dispatchAllocatedAt === dispatch.allocatedAt
        && recovery.cause === dispatch.cause
        && (recovery.cause === 'user_retry'
            ? dispatch.origin === 'retry' && (dispatch.cleanContinuationId
                ? binding.userMessageId === dispatch.id
                    && binding.userMessage.hidden === true
                : binding.userMessageId === recovery.originalUserMessageId)
            : dispatch.origin !== 'retry'
                && binding.userMessageId === dispatch.id
                && binding.userMessage.hidden === true));
    if (!ownsExactTurn() || !ownsExactStartedDispatch()) {
        // The provider receives a fixed fail-closed error. Keep only ownership
        // booleans in the host log so an inbox/rebind regression can be diagnosed
        // without logging message text, tool inputs, or delegated payloads.
        sessionLog.warn('Tool admission turn ownership mismatch', {
            sessionId: managed.id,
            generationMatches: generation !== undefined
                && binding.generation === generation
                && generation === managed.processingGeneration,
            runtimeMatches: sessionOperationContext.state.sessions.get(managed.id) === managed
                && managed.agent === runtimeAgent && managed.isProcessing && !managed.stopRequested,
            objectiveMatches: managed.activeObjective === binding.activeObjective,
            authorityMatches: (sessionOperationContext.state.objectiveAuthorityEpochs.get(managed) ?? 0) === binding.authorityEpoch,
            optionsMatch: managed.lastSentOptions === binding.lastSentOptions,
            userBoundaryMatches: latestBoundUserMessage() === binding.userMessage,
            queuedMachineInboxCount: managed.messages.filter(isDeferredMachineInboxUser).length,
            queuedUserCount: managed.messages.filter(message => message.role === 'user' && message.isQueued).length,
        });
        throw new ToolAdmissionRecoveryError(recovery
            ? 'Automatic recovery tool admission no longer owns its started dispatch because the durable turn boundary changed. Continue from the current turn; do not retry the superseded mutation or request permission.'
            : 'Tool admission no longer owns its exact provider turn because a newer durable turn superseded it. Continue from the current turn; do not retry the superseded operation or request permission.');
    }
    const hasAutomaticToolFallbackIntent = !!(recovery && dispatch?.fallbackIntent || binding.liveToolFallbackIntent);
    const assertAutomaticToolFallbackStillEnabled = (): void => {
        if (hasAutomaticToolFallbackIntent
            && !isWorkspaceAutomaticToolFallbackEnabled(loadWorkspaceConfig(managed.workspace.rootPath))) {
            throw new ToolAdmissionRecoveryError('Automatic channel fallback was disabled before this tool could execute. The fallback has been revoked and must continue from a fresh generic recovery boundary.');
        }
    };
    assertAutomaticToolFallbackStillEnabled();
    const toolUseId = request.toolUseId?.trim();
    if (!toolUseId) {
        throw new Error('Tool admission requires an exact tool-use identity');
    }
    const operationalInput = structuredClone(request.toolInput);
    const { [TERMINAL_RECONCILIATION_CAPABILITY_FIELD]: _terminalCapability, ...safeReceiptInput } = operationalInput;
    const durableBeforeAdmission = loadStoredSession(persistenceRootFor(managed), managed.id);
    const durableMessages = durableBeforeAdmission?.messages ?? [];
    const durableTurnIndexes = durableMessages.flatMap((message, index) => (message.type === 'user' && message.id === binding.userMessageId ? [index] : []));
    const isDeferredDurableMachineInboxUser = (message: typeof durableMessages[number]): boolean => (message.type === 'user'
        && ((message.hidden === true
            && message.isQueued === true
            && message.agentDelivery?.status === 'queued'
            && message.internalOrigin?.kind === 'agent-message'
            && message.internalOrigin.deliveryId === message.agentDelivery.id
            && hasExactDeferredMachineInboxFifo(message))
            || isWaitConsumedDelegatedReceipt(message)));
    const latestDurableUserIndex = durableMessages.findLastIndex(message => (message.type === 'user' && !isDeferredDurableMachineInboxUser(message)));
    const durableExplicitRetryBoundaryValid = explicitRetryMessageBoundary !== undefined
        && explicitRetryMessageBoundary <= durableMessages.length
        && durableTurnIndexes.length === 1
        && durableTurnIndexes[0]! < explicitRetryMessageBoundary
        && !durableMessages.slice(explicitRetryMessageBoundary).some(message => (message.type === 'user' && !isDeferredDurableMachineInboxUser(message)));
    const durableCleanExplicitRetryBoundaryValid = cleanExplicitRetryBoundary
        && explicitRetryMessageBoundary! < durableMessages.length
        && durableTurnIndexes.length === 1
        && durableTurnIndexes[0] === explicitRetryMessageBoundary
        && durableTurnIndexes[0] === latestDurableUserIndex
        && durableMessages[latestDurableUserIndex]?.hidden === true;
    const durableAgentDeliveryBoundaryValid = boundAgentDelivery
        && durableTurnIndexes.length === 1
        && durableTurnIndexes[0]! < binding.messageCountAtHandoff
        && durableMessages.length >= binding.messageCountAtHandoff
        && durableMessages[durableTurnIndexes[0]!]!.internalOrigin?.kind === 'agent-message'
        && durableMessages[durableTurnIndexes[0]!]!.internalOrigin?.deliveryId === binding.userMessage.agentDelivery?.id
        && !durableMessages.slice(binding.messageCountAtHandoff).some(message => (message.type === 'user' && !isDeferredDurableMachineInboxUser(message)));
    if (durableTurnIndexes.length !== 1
        || (boundAgentDelivery
            ? !durableAgentDeliveryBoundaryValid
            : explicitRetryMessageBoundary === undefined
                ? durableTurnIndexes[0] !== latestDurableUserIndex
                : cleanExplicitRetryBoundary
                    ? !durableCleanExplicitRetryBoundaryValid
                    : !durableExplicitRetryBoundaryValid)) {
        throw new Error('Tool admission has no unique latest durable user-turn boundary');
    }
    let durableBoundaryTimestamp = binding.userMessage.timestamp;
    if (recovery) {
        const recoveryAnchorIndexes = durableMessages.flatMap((message, index) => (message.type === 'user' && message.id === recovery.originalUserMessageId ? [index] : []));
        if (recoveryAnchorIndexes.length !== 1
            || (recovery.cause === 'user_retry'
                ? cleanExplicitRetryBoundary
                    ? !durableCleanExplicitRetryBoundaryValid
                        || recoveryAnchorIndexes[0]! >= durableTurnIndexes[0]!
                    : !durableExplicitRetryBoundaryValid
                        || recoveryAnchorIndexes[0] !== durableTurnIndexes[0]
                : recoveryAnchorIndexes[0]! >= latestDurableUserIndex)
            || (recovery.cause !== 'user_retry'
                && (durableMessages[latestDurableUserIndex]?.id !== dispatch!.id
                    || durableMessages[latestDurableUserIndex]?.hidden !== true))) {
            throw new Error('Automatic recovery tool admission has no unique durable objective and dispatch boundary');
        }
        durableBoundaryTimestamp = Math.max(durableBoundaryTimestamp, dispatch!.startedAt!);
    }
    // Keep the strict uncertain-effect quarantine within the opt-in legacy
    // contract. Native SDK recovery retains durable admissions and read-first
    // instructions without inheriting a global lock it cannot reconcile.
    const quarantinesUncertainObjectiveEffect = isLegacyHostObjectiveContractEnabled(managed)
        && (recovery?.cause !== 'user_retry'
            || cleanExplicitRetryBoundary)
        && (!!recovery || (binding.userMessage.agentDelivery?.attempts ?? 0) > 1);
    enforceUncertainToolEffectPolicy(managed, quarantinesUncertainObjectiveEffect, request, safeReceiptInput, durableMessages, toolUseId);
    const turnMessageIndexes = managed.messages.flatMap((message, index) => (message.id === binding.userMessageId && message.role === 'user' ? [index] : []));
    if (turnMessageIndexes.length !== 1
        || latestBoundUserMessage() !== binding.userMessage) {
        throw new Error('Tool admission has no unique latest user-turn prompt');
    }
    const turnMessageIndex = turnMessageIndexes[0]!;
    const existingReceipts = managed.messages.filter(message => message.toolUseId === toolUseId);
    const existingReceipt = existingReceipts[0];
    const existingReceiptIndex = existingReceipt ? managed.messages.indexOf(existingReceipt) : -1;
    const currentStartOwner = sessionOperationContext.state.checkpointToolStarts.get(managed);
    const currentStart = currentStartOwner && currentStartOwner.generation === generation
        ? currentStartOwner.calls.get(toolUseId)
        : undefined;
    const currentStartIsExactLiveCall = !!currentStart
        && currentStart.objective === managed.activeObjective
        && currentStart.objectiveId === managed.activeObjective?.userMessageId
        && currentStart.acceptanceRevision
            === (managed.activeObjective?.acceptanceRevision ?? managed.activeObjective?.userMessageId)
        && currentStart.acceptanceSha256
            === (managed.activeObjective ? objectiveReviewBinding(managed.activeObjective).acceptanceSha256 : undefined)
        && currentStart.authorityEpoch === (sessionOperationContext.state.objectiveAuthorityEpochs.get(managed) ?? 0)
        && currentStart.toolName === request.toolName
        && currentStart.durableAdmissionClaimed !== true;
    // Pi emits tool_execution_start when the SDK begins the invocation, then
    // its wrapped execute awaits PreToolUse. The event loop can therefore
    // persist the exact live start before this durability callback acquires
    // its serialized lock. Adopt only that current-generation row. Its
    // immutable owner and its position after this provider-turn boundary
    // distinguish it from every historical/reused tool-use id.
    const existingReceiptIsExactLiveStart = existingReceipts.length === 1
        && !!existingReceipt
        && existingReceipt.role === 'tool'
        && existingReceipt.toolStatus === 'executing'
        && existingReceipt.toolResult === undefined
        && existingReceipt.toolName === request.toolName
        && existingReceipt.timestamp >= durableBoundaryTimestamp
        && (boundAgentDelivery
            ? existingReceiptIndex >= binding.messageCountAtHandoff
            : explicitRetryMessageBoundary === undefined
                ? existingReceiptIndex > turnMessageIndex
                : existingReceiptIndex >= explicitRetryMessageBoundary)
        && currentStartIsExactLiveCall;
    if (existingReceipts.length > 0 && !existingReceiptIsExactLiveStart) {
        // A provider/tool-use ID is single-use across the complete transcript.
        // Reusing even an input-identical historical row could leave the current
        // prompt last and make a possibly repeated mutation look reclaimable.
        const collision: AutonomyEvent = {
            id: randomUUID(),
            timestamp: Math.max(Date.now(), durableBoundaryTimestamp),
            phase: 'diagnosis',
            toolName: request.toolName,
            message: 'Blocked a reused tool execution identity before execution.',
            evidence: `${dispatch ? `dispatch=${dispatch.id}; ` : ''}turn=${binding.userMessageId}; toolUseId=${toolUseId}`,
        };
        managed.autonomyEvents = [...(managed.autonomyEvents ?? []), collision].slice(-50);
        sessionOperationContext.owner["persistSession"](managed);
        await sessionOperationContext.owner.flushSession(managed.id);
        const storedCollision = loadStoredSession(persistenceRootFor(managed), managed.id)
            ?.autonomyEvents?.some(event => event.id === collision.id) === true;
        if (!storedCollision) {
            throw new Error('Tool admission identity collision was not durable');
        }
        throw new Error('Tool execution identity already belongs to the transcript');
    }
    const receipt: Message = existingReceiptIsExactLiveStart
        ? existingReceipt!
        : {
            id: generateMessageId(),
            role: 'tool',
            content: `Running ${request.toolName}...`,
            timestamp: Math.max(sessionOpMonotonic(sessionOperationContext), durableBoundaryTimestamp),
            toolName: request.toolName,
            toolUseId,
            toolInput: safeReceiptInput,
            toolStatus: 'executing',
        };
    if (currentStartIsExactLiveCall) {
        // Consume Pi's live-start ownership synchronously, including the race
        // where display metadata is still resolving and its ordinary receipt is
        // not materialized yet. If the following fsync fails, no later callback
        // may adopt the in-memory receipt created below and turn that failed ACK
        // into an execution. A later provider attempt must use a fresh tool id.
        currentStart!.durableAdmissionClaimed = true;
    }
    if (existingReceiptIsExactLiveStart) {
        // PreToolUse may have normalized or narrowed the provider input after
        // tool_execution_start. Persist the exact approved payload that will be
        // executed, while retaining display metadata already attached to the row.
        receipt.toolInput = structuredClone(safeReceiptInput);
    }
    else {
        managed.messages.push(receipt);
    }
    sessionOperationContext.owner["persistSession"](managed);
    await sessionOperationContext.owner.flushSession(managed.id);
    // flushSession is the execution ACK only when the cold restart path can
    // reconstruct the exact possible mutation, including its target/payload.
    const stored = loadStoredSession(persistenceRootFor(managed), managed.id);
    const storedTurnIndexes = stored?.messages?.flatMap((message, index) => (message.id === binding.userMessageId && message.type === 'user' ? [index] : [])) ?? [];
    const storedLatestUserIndex = stored?.messages?.findLastIndex(message => (message.type === 'user' && !isDeferredDurableMachineInboxUser(message))) ?? -1;
    const storedExplicitRetryBoundaryValid = explicitRetryMessageBoundary !== undefined
        && explicitRetryMessageBoundary <= (stored?.messages?.length ?? 0)
        && storedTurnIndexes.length === 1
        && storedTurnIndexes[0]! < explicitRetryMessageBoundary
        && !stored?.messages?.slice(explicitRetryMessageBoundary).some(message => (message.type === 'user' && !isDeferredDurableMachineInboxUser(message)));
    const storedCleanExplicitRetryBoundaryValid = cleanExplicitRetryBoundary
        && explicitRetryMessageBoundary! < (stored?.messages?.length ?? 0)
        && storedTurnIndexes.length === 1
        && storedTurnIndexes[0] === explicitRetryMessageBoundary
        && storedTurnIndexes[0] === storedLatestUserIndex
        && stored?.messages?.[storedLatestUserIndex]?.hidden === true;
    const storedAgentDeliveryBoundaryValid = boundAgentDelivery
        && storedTurnIndexes.length === 1
        && storedTurnIndexes[0]! < binding.messageCountAtHandoff
        && (stored?.messages?.length ?? 0) >= binding.messageCountAtHandoff
        && stored?.messages?.[storedTurnIndexes[0]!]!.internalOrigin?.kind === 'agent-message'
        && stored?.messages?.[storedTurnIndexes[0]!]!.internalOrigin?.deliveryId === binding.userMessage.agentDelivery?.id
        && !stored?.messages?.slice(binding.messageCountAtHandoff).some(message => (message.type === 'user' && !isDeferredDurableMachineInboxUser(message)));
    const storedReceiptIndex = stored?.messages?.findIndex(message => (message.id === receipt.id
        && message.type === 'tool'
        && message.toolUseId === toolUseId
        && message.toolName === request.toolName
        && message.toolStatus === 'executing'
        && isDeepStrictEqual(message.toolInput, safeReceiptInput))) ?? -1;
    const receiptIsDurable = turnMessageIndex < managed.messages.indexOf(receipt)
        && storedTurnIndexes.length === 1
        && (boundAgentDelivery
            ? storedAgentDeliveryBoundaryValid
                && storedReceiptIndex >= binding.messageCountAtHandoff
            : explicitRetryMessageBoundary === undefined
                ? storedTurnIndexes[0] === storedLatestUserIndex
                    && storedReceiptIndex > storedLatestUserIndex
                : cleanExplicitRetryBoundary
                    ? storedCleanExplicitRetryBoundaryValid
                        && storedReceiptIndex > explicitRetryMessageBoundary
                    : storedExplicitRetryBoundaryValid
                        && storedReceiptIndex >= explicitRetryMessageBoundary);
    if (!receiptIsDurable) {
        throw new Error('Tool admission receipt was not durable');
    }
    // Stop/steering may win while the flush runs. The durable receipt remains
    // conservative evidence, while rejection prevents the stale tool running.
    if (!ownsExactTurn() || !ownsExactStartedDispatch()) {
        throw new Error(recovery
            ? 'Automatic recovery tool admission was superseded during durability flush'
            : 'Tool admission was superseded during durability flush');
    }
    // The workspace switch may change while the receipt fsync is pending.
    // Re-read it at the final synchronous ACK boundary; no await separates
    // this check from returning execution authority to the provider.
    assertAutomaticToolFallbackStillEnabled();
    const objectiveAtStart = managed.activeObjective;
    if (objectiveAtStart?.terminalState === 'active') {
        let starts = sessionOperationContext.state.checkpointToolStarts.get(managed);
        if (starts?.generation !== generation) {
            starts = { generation: generation!, calls: new Map() };
            sessionOperationContext.state.checkpointToolStarts.set(managed, starts);
        }
        starts!.calls.set(toolUseId, {
            objective: objectiveAtStart,
            objectiveId: objectiveAtStart.userMessageId,
            acceptanceRevision: objectiveAtStart.acceptanceRevision ?? objectiveAtStart.userMessageId,
            acceptanceSha256: objectiveReviewBinding(objectiveAtStart).acceptanceSha256,
            authorityEpoch: sessionOperationContext.state.objectiveAuthorityEpochs.get(managed) ?? 0,
            toolName: request.toolName,
            durableAdmissionClaimed: true,
        });
    }
    sessionOperationContext.owner["sendEvent"]({
        type: 'tool_start',
        sessionId: managed.id,
        toolName: request.toolName,
        toolUseId,
        toolInput: structuredClone(safeReceiptInput),
        timestamp: receipt.timestamp,
    }, managed.workspace.id);
    sessionOperationContext.owner["emitExecutionTelemetry"](managed, {
        schemaVersion: 1,
        eventId: randomUUID(),
        timestamp: receipt.timestamp,
        name: 'tool.started',
        correlation: {
            workspaceId: managed.workspace.id,
            sessionId: managed.id,
            toolCallId: toolUseId,
        },
        toolName: request.toolName,
    });
}

export { sessionOpDurablyRecordAutomaticRecoveryToolAdmissionLocked as durablyRecordAutomaticRecoveryToolAdmissionLocked };
