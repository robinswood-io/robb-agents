import type { SessionOperationContext } from '../operation-context.ts';
import { isLegacyHostObjectiveContractEnabled } from '../policy.ts';
import { validateFilePath, getWorkspaceAllowedDirs } from '@craft-agent/server-core/handlers';
import { readFileSync } from 'fs';
import { createHash } from 'node:crypto';
import { getLlmConnection } from '@craft-agent/shared/config';
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import type { SessionDelegation } from '@craft-agent/shared/sessions';
import type { FileAttachment } from '@craft-agent/shared/protocol';
import { readFileAttachment } from '@craft-agent/shared/utils';
import { hasCurrentObjectiveIndependentReviewPass } from '../../objective-outcome';
import { evaluateReviewDelegation, makeActiveDelegationKey } from '../../review-delegation-policy';
import type { SpawnSessionResult } from '@craft-agent/shared/agent';
import { deriveHostDelegatedReviewSingleTarget, HOST_PARENT_REVIEW_INSTRUCTION, prependHostDelegatedReviewerScope } from '../../delegated-review-outcome';
import { assertCurrentDelegationObjective, resolveDelegatedPermissionMode } from '../../delegation-budget';
import { parseSpawnSessionInput } from '@craft-agent/session-tools-core';
import { findObjectiveText, objectiveReviewBinding } from '../../objective-contract';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import type { SessionCompletionEvent } from '../runtime-types.ts';
import { resolveExplicitSpawnedSessionRoute } from '../session-creation.ts';
import { consumeTerminalInvocationCapability as sessionOpConsumeTerminalInvocationCapability } from './repair-legacy-synthetic-objective-authority.ts';
import { autonomousAdmissionBlock as sessionOpAutonomousAdmissionBlock } from './exact-user-input-response.ts';
import { monotonic as sessionOpMonotonic } from './runtime-host.ts';
import { reserveSpawnAdmission as sessionOpReserveSpawnAdmission } from './claim-automatic-admission.ts';
import { sendDelegatedDispatch as sessionOpSendDelegatedDispatch, recordDelegatedDispatchFailure as sessionOpRecordDelegatedDispatchFailure } from './record-delegated-dispatch-failure.ts';

/**
 * Subscribe to in-process session completion (Tasks Conductor seam).
 * Returns an unsubscribe function. Not a renderer event; not agent-facing.
 */
function sessionOpOnSessionComplete(sessionOperationContext: SessionOperationContext, listener: (evt: SessionCompletionEvent) => void): () => void {
    sessionOperationContext.state.sessionCompletionListeners.add(listener);
    return () => {
        sessionOperationContext.state.sessionCompletionListeners.delete(listener);
    };
}

async function sessionOpSpawnDelegatedSession(sessionOperationContext: SessionOperationContext, managed: ManagedSession, input: unknown): Promise<SpawnSessionResult> {
    const parsedRequest = parseSpawnSessionInput(input);
    const terminalCapability = parsedRequest._hostTerminalReconciliationCapability;
    const { _hostTerminalReconciliationCapability: _terminalCapability, ...request } = parsedRequest;
    if (request.help || !request.prompt?.trim())
        throw new Error('Host dispatch requires a non-empty spawn prompt');
    if (managed.activeObjective?.terminalReconciliation && !sessionOpConsumeTerminalInvocationCapability(sessionOperationContext, managed, 'mcp__session__spawn_session', parsedRequest as Record<string, unknown>, terminalCapability))
        throw new Error('The terminal reviewer-dispatch capability is missing, stale, or belongs to another objective revision.');
    if (!managed.activeObjective?.terminalReconciliation && terminalCapability) {
        throw new Error('A terminal reviewer-dispatch capability cannot be used outside its bound reconciliation objective.');
    }
    const prompt = request.prompt;
    const generation = managed.processingGeneration;
    const objective = managed.activeObjective;
    let dispatchChildId: string | undefined;
    const assertDispatch = () => {
        if (sessionOperationContext.state.shuttingDown || sessionOperationContext.state.sessions.get(managed.id) !== managed || managed.stopRequested
            || sessionOperationContext.state.retentionDeleting.has(managed.id) || managed.processingGeneration !== generation
            || managed.activeObjective !== objective) {
            throw new Error('The originating turn is no longer current; no delegated work was dispatched.');
        }
        const block = sessionOpAutonomousAdmissionBlock(sessionOperationContext, managed, true, false);
        if (block)
            throw new Error(`Delegation deferred (${block}). Resolve the ancestor decision before dispatching work.`);
        if (request.role === 'reviewer' && objective?.terminalReconciliation) {
            if (Object.keys(request).some(key => ![
                'prompt', 'name', 'role', 'permissionMode',
            ].includes(key)) || request.permissionMode && request.permissionMode !== 'safe') {
                throw new Error('Terminal reconciliation reviewer dispatch accepts only prompt, optional name, role:reviewer and permissionMode:safe.');
            }
            const initialReviewAllowed = objective.terminalReconciliation.initialAcceptanceRegistrationRequired === true
                && objective.requiresAcceptanceCriteria === true
                && !!objective.acceptanceCriteria?.length
                && objective.acceptanceNeedsReview !== true
                && objective.acceptanceRegisteredRevision
                    === (objective.acceptanceRevision ?? objective.userMessageId)
                && Number.isFinite(objective.acceptanceRegisteredAt)
                && objective.acceptanceRegisteredAt! >= objective.terminalReconciliation.timestamp
                && objective.completionCriteria.includes('independent-review-passed');
            if (!initialReviewAllowed) {
                throw new Error('Terminal reconciliation cannot create or relaunch a reviewer for an existing or incomplete acceptance contract.');
            }
            if (hasCurrentObjectiveIndependentReviewPass(objective, managed.messages, objective.acceptanceRegisteredAt)) {
                throw new Error('Terminal reconciliation already has an exact current independent-review PASS; reuse its receipt.');
            }
            const objectiveId = objective.objectiveId ?? objective.userMessageId;
            const currentReviewBinding = objectiveReviewBinding(objective);
            const duplicate = [...sessionOperationContext.state.sessions.values()].some(candidate => {
                if (candidate.id === dispatchChildId || candidate.parentSessionId !== managed.id
                    || candidate.delegation?.role !== 'reviewer')
                    return false;
                const persistedBinding = candidate.delegation.reviewBinding;
                const exactBinding = persistedBinding?.objectiveId === currentReviewBinding.objectiveId
                    && persistedBinding.acceptanceSha256 === currentReviewBinding.acceptanceSha256;
                const conservativeLegacyCandidate = !persistedBinding
                    && candidate.delegation.parentObjectiveId === objectiveId
                    && (candidate.createdAt ?? Number.POSITIVE_INFINITY) >= objective.acceptanceRegisteredAt!;
                if (!exactBinding && !conservativeLegacyCandidate)
                    return false;
                // The immutable terminal contract binds every direct reviewer
                // created after its first registration. Do not reparse model-authored
                // prompt prose to decide whether that host-issued attempt counts.
                const createdAfterRegistration = exactBinding || conservativeLegacyCandidate;
                const persistedAttempt = !!candidate.activeObjective || candidate.messages.some(message => (message.role === 'user' && !!message.internalOrigin)) || !!candidate.pendingQueuedMessageIds?.length
                    || !!candidate.pendingAgentDeliveryIds?.length;
                const activeAttempt = candidate.isProcessing || candidate.messageQueue.length > 0
                    || !!candidate.pendingTurnRecovery
                    || sessionOperationContext.state.automaticAdmissionReservations.has(candidate.id);
                if (createdAfterRegistration && !persistedAttempt && !activeAttempt
                    && !candidate.delegation.finishedAt) {
                    // A crash can persist createSession before the first child prompt.
                    // Retire that provably inert envelope so it cannot deadlock the one
                    // legitimate post-registration review after restart.
                    candidate.delegation.finishedAt = sessionOpMonotonic(sessionOperationContext);
                    sessionOperationContext.owner["persistSession"](candidate);
                }
                return createdAfterRegistration && (activeAttempt || persistedAttempt);
            });
            if (duplicate) {
                throw new Error('Terminal reconciliation already dispatched the reviewer for this exact host binding; wait for or reuse that review instead of spawning another.');
            }
        }
    };
    assertDispatch();
    const terminalReviewBinding = request.role === 'reviewer' && objective?.terminalReconciliation
        ? objectiveReviewBinding(objective) : undefined;
    const terminalReviewReservation = terminalReviewBinding
        ? `${managed.id}:${terminalReviewBinding.objectiveId}:${terminalReviewBinding.acceptanceSha256}`
        : undefined;
    if (terminalReviewReservation) {
        if (sessionOperationContext.state.terminalReviewDispatchReservations.has(terminalReviewReservation)) {
            throw new Error('Terminal reconciliation already has an in-flight reviewer dispatch for this exact host binding.');
        }
        sessionOperationContext.state.terminalReviewDispatchReservations.add(terminalReviewReservation);
    }
    try {
        const sourceSlugs = request.enabledSourceSlugs ?? managed.enabledSourceSlugs;
        const enforceLegacyReviewContract = !!objective && (isLegacyHostObjectiveContractEnabled(managed)
            || !!objective.acceptanceCriteria?.length
            || !!objective.terminalReconciliation);
        // A reviewer must not spawn a review of its own review, including native chats.
        if (objective) {
            const decision = evaluateReviewDelegation({ parentSessionId: managed.parentSessionId,
                objective, prompt, proposedRole: request.role, sourceSlugs });
            if (!decision.allowed)
                throw new Error(decision.message);
        }
        const hostTargetChecks = request.role === 'reviewer' && objective && enforceLegacyReviewContract
            ? objective.acceptanceCriteria ?? []
            : [];
        const hostSingleTarget = request.role === 'reviewer' && objective && enforceLegacyReviewContract && !hostTargetChecks.length
            ? deriveHostDelegatedReviewSingleTarget(prompt, sourceSlugs)
            : undefined;
        if (request.role === 'reviewer' && objective && enforceLegacyReviewContract && !hostTargetChecks.length && !hostSingleTarget) {
            throw new Error('Reviewer delegation requires immutable host target checks or one explicit, unambiguous inspection target.');
        }
        // Resolve attachments before creation: the key binds actual bytes, and a
        // rejected input cannot silently create an incomplete parallel task.
        const fileAttachments: FileAttachment[] = [];
        const attachmentContentHashes: string[] = [];
        for (const item of request.attachments ?? []) {
            const allowedDirs = getWorkspaceAllowedDirs(managed.workspace.id);
            if (request.workingDirectory)
                allowedDirs.push(request.workingDirectory);
            const safePath = await validateFilePath(item.path, allowedDirs);
            assertDispatch();
            const attachment = readFileAttachment(safePath);
            if (!attachment)
                throw new Error(`Spawn attachment is unavailable: ${item.path}`);
            if (item.name)
                attachment.name = item.name;
            fileAttachments.push(attachment);
            attachmentContentHashes.push(createHash('sha256').update(readFileSync(safePath)).digest('hex'));
        }
        // Attachment authorization can yield. Select the child route only after
        // every input is fixed so an ON -> OFF toggle during validation cannot
        // admit a new child on the stale adaptive route.
        const workspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath);
        const spawnConnectionSlug = managed.llmConnection;
        const inheritedRoute = resolveExplicitSpawnedSessionRoute({}, managed, {
            prompt,
            role: request.role ?? 'worker',
            connection: spawnConnectionSlug ? getLlmConnection(spawnConnectionSlug) ?? undefined : undefined,
            policy: workspaceConfig?.costControl,
        });
        const options = {
            name: request.name, llmConnection: inheritedRoute.llmConnection, model: inheritedRoute.model,
            connectionRoutePinned: inheritedRoute.connectionRoutePinned ?? false,
            modelRoutePinned: inheritedRoute.modelRoutePinned ?? false,
            thinkingLevelPinned: inheritedRoute.thinkingLevelPinned ?? false,
            enabledSourceSlugs: sourceSlugs,
            permissionMode: resolveDelegatedPermissionMode(managed.permissionMode ?? 'ask', request.permissionMode, request.role),
            thinkingLevel: inheritedRoute.thinkingLevel, labels: request.labels ?? managed.labels,
            workingDirectory: request.workingDirectory, projectId: request.projectId ?? managed.projectId,
            parentSessionId: managed.id,
        };
        let root = managed;
        const visited = new Set<string>([root.id]);
        while (root.parentSessionId && !visited.has(root.parentSessionId)) {
            const parent = sessionOperationContext.state.sessions.get(root.parentSessionId);
            if (!parent || parent.workspace.id !== managed.workspace.id)
                break;
            visited.add(parent.id);
            root = parent;
        }
        // Role is part of the authority boundary: a worker is never reused as a reviewer.
        const { name: _name, ...configuration } = options;
        const key = makeActiveDelegationKey({ workspaceId: managed.workspace.id,
            rootObjectiveId: root.activeObjective?.objectiveId ?? '',
            parentObjectiveId: objective?.objectiveId ?? '', prompt,
            targetConfiguration: JSON.parse(JSON.stringify({ ...configuration, role: request.role,
                attachmentsSha256: createHash('sha256').update(JSON.stringify({ fileAttachments, attachmentContentHashes })).digest('hex') })),
        });
        const result = await sessionOperationContext.state.activeDelegations.run(key, async () => {
            assertDispatch();
            const budget = sessionOperationContext.state.delegationBudget.reserve(managed, sessionOperationContext.state.sessions.values(), request.role);
            let admission: symbol | undefined;
            let child: ManagedSession | undefined;
            try {
                admission = sessionOpReserveSpawnAdmission(sessionOperationContext, managed, request.role);
                const delegation: SessionDelegation = terminalReviewBinding
                    ? { ...budget.delegation, reviewBinding: { ...terminalReviewBinding } }
                    : budget.delegation;
                const session = await sessionOperationContext.owner.createSession(managed.workspace.id, options, { delegation });
                child = sessionOperationContext.state.sessions.get(session.id);
                if (!child)
                    throw new Error('Created delegation is unavailable before dispatch');
                dispatchChildId = child.id;
                sessionOperationContext.state.automaticAdmissionReservations.add(session.id);
                sessionOperationContext.state.pendingSpawnRoots.delete(admission);
                admission = undefined;
                assertDispatch();
                await sessionOperationContext.owner.flushSession(child.id);
                assertDispatch();
                assertCurrentDelegationObjective(managed, sessionOperationContext.state.sessions.values(), delegation);
                // A permission reduction during any asynchronous preparation applies at dispatch.
                const dispatchMode = resolveDelegatedPermissionMode(managed.permissionMode ?? 'ask', child.permissionMode, request.role);
                if (child.permissionMode !== dispatchMode)
                    sessionOperationContext.owner.setSessionPermissionMode(child.id, dispatchMode);
                const delegatedPrompt = request.role === 'reviewer' && objective && enforceLegacyReviewContract
                    ? `${prependHostDelegatedReviewerScope(prompt)}\n\n<host_parent_review_contract>${JSON.stringify({
                        protocol: 'host-review-v2',
                        ...objectiveReviewBinding(objective),
                        criteria: [...objective.completionCriteria.filter(id => id !== 'independent-review-passed'),
                            ...hostTargetChecks.map(item => item.id)],
                        targetChecks: hostTargetChecks,
                        request: findObjectiveText(managed.messages, objective),
                        amendments: (objective.amendments ?? []).map(amendment => amendment.text),
                        ...(hostSingleTarget ? { singleTarget: hostSingleTarget } : {}),
                        instruction: HOST_PARENT_REVIEW_INSTRUCTION,
                    }).replace(/</g, '\\u003c')}</host_parent_review_contract>` : prompt;
                try {
                    // `started` means the exact child prompt crossed its durable ACK, not
                    // merely that createSession returned. Pre-ACK failures are returned to
                    // the spawning tool and persisted on the child as a consumable result.
                    await sessionOpSendDelegatedDispatch(sessionOperationContext, managed, child, objective, delegatedPrompt, fileAttachments.length ? fileAttachments : undefined);
                }
                catch (error) {
                    await sessionOpRecordDelegatedDispatchFailure(sessionOperationContext, child, error);
                    sessionOperationContext.state.activeDelegations.release(session.id);
                    throw error;
                }
                finally {
                    sessionOperationContext.state.automaticAdmissionReservations.delete(session.id);
                    sessionOperationContext.owner["scheduleDeferredAutomaticSessions"]();
                }
                return { sessionId: session.id, name: session.name || request.name || session.id,
                    status: 'started' as const, connection: session.llmConnection, model: session.model };
            }
            catch (error) {
                if (child?.delegation)
                    await sessionOpRecordDelegatedDispatchFailure(sessionOperationContext, child, error);
                if (child)
                    sessionOperationContext.state.automaticAdmissionReservations.delete(child.id);
                throw error;
            }
            finally {
                if (admission)
                    sessionOperationContext.state.pendingSpawnRoots.delete(admission);
                budget.release();
                sessionOperationContext.owner["scheduleDeferredAutomaticSessions"]();
            }
        }, sessionId => {
            const target = sessionOperationContext.state.sessions.get(sessionId);
            return !!target && target.workspace.id === managed.workspace.id && !target.delegation?.finishedAt &&
                (target.isProcessing || target.messageQueue.length > 0 || !!target.pendingTurnRecovery ||
                    (target.processingGeneration === 0 && !target.lastWaitCompletion));
        });
        return { ...result.value, ...(result.reused ? { reused: true } : {}) };
    }
    finally {
        if (terminalReviewReservation) {
            sessionOperationContext.state.terminalReviewDispatchReservations.delete(terminalReviewReservation);
        }
    }
}

/**
 * Trusted connector-runtime seam. This method is intentionally not exposed by
 * RPC or renderer protocols, so model-authored text cannot become execution proof.
 */
function sessionOpRecordExecutionProof(sessionOperationContext: SessionOperationContext, sessionId: string, proof: import('@craft-agent/shared/governance').SignedExecutionProof): void {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    const missionId = managed?.missionId ?? managed?.taskSlug;
    const nodeId = managed?.missionWorkItemId ?? managed?.taskNodeId;
    if (!managed || !missionId || !nodeId) {
        throw new Error('Execution proof can only be recorded for a bound task or mission work session');
    }
    sessionOperationContext.state.executionProofCollector.record({
        sessionId,
        workspaceId: managed.workspace.id,
        missionId,
        nodeId,
    }, proof);
}

function sessionOpEmitSessionComplete(sessionOperationContext: SessionOperationContext, evt: SessionCompletionEvent): void {
    const target = sessionOperationContext.state.sessions.get(evt.sessionId);
    if (target?.workspace.id === evt.workspaceId) {
        target.lastWaitCompletion = { generation: target.processingGeneration, event: evt };
    }
    for (const wake of sessionOperationContext.state.sessionWaitListeners)
        wake(evt.sessionId);
    if (sessionOperationContext.state.sessionCompletionListeners.size === 0)
        return;
    for (const listener of sessionOperationContext.state.sessionCompletionListeners) {
        try {
            listener(evt);
        }
        catch (err) {
            sessionLog.error(`onSessionComplete listener threw for session ${evt.sessionId}:`, err);
        }
    }
}

export { sessionOpOnSessionComplete as onSessionComplete };
export { sessionOpSpawnDelegatedSession as spawnDelegatedSession };
export { sessionOpRecordExecutionProof as recordExecutionProof };
export { sessionOpEmitSessionComplete as emitSessionComplete };
