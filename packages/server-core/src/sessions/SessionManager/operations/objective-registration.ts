import { omitUndefined } from '@craft-agent/shared/utils/json';
import type { SessionOperationContext } from '../operation-context.ts';
import { createBackendFromConnection } from '@craft-agent/shared/agent/backend';
import { getLlmConnection, getPersistedUiLanguage, resolveTitleLanguageName, getMiniModel } from '@craft-agent/shared/config';
import { i18n } from '@craft-agent/shared/i18n';
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions';
import type { ManagedSession } from '../managed-session.ts';
import { buildBackendHostRuntimeContext, hasImmutableMissionRoute, hasMissionDispatchTriplet } from '../mission-route.ts';
import { sessionLog } from '../runtime-platform.ts';
import type { AgentInstance } from '../runtime-types.ts';
import { ownsSessionOperation as sessionOpOwnsSessionOperation } from './track-session-operation.ts';
import { evaluateAndApplyAutoLabels as sessionOpEvaluateAndApplyAutoLabels } from './perform-adopt-generated-task-orchestrator.ts';

async function sessionOpGenerateTitle(sessionOperationContext: SessionOperationContext, managed: ManagedSession, userMessage: string): Promise<void> {
    sessionLog.info(`[generateTitle] Starting for session ${managed.id}`);
    if (!sessionOpOwnsSessionOperation(sessionOperationContext, managed))
        return;
    if (hasImmutableMissionRoute(managed) || hasMissionDispatchTriplet(managed)) {
        sessionLog.info(`[generateTitle] Skipped for Mission session ${managed.id}`);
        return;
    }
    // Use existing agent or create temporary one
    let agent: AgentInstance | null = managed.agent;
    let isTemporary = false;
    // Wait briefly for agent to be created (it's created concurrently)
    if (!agent) {
        let attempts = 0;
        while (!managed.agent && attempts < 10) {
            await new Promise(resolve => setTimeout(resolve, 100));
            if (!sessionOpOwnsSessionOperation(sessionOperationContext, managed))
                return;
            attempts++;
        }
        agent = managed.agent;
    }
    // If still no agent, create a temporary one using the session's connection
    if (!agent && managed.llmConnection) {
        try {
            const connection = getLlmConnection(managed.llmConnection);
            agent = createBackendFromConnection(managed.llmConnection, omitUndefined({
                workspace: managed.workspace,
                ...(managed.model !== undefined ? { model: managed.model } : {}),
                ...(managed.thinkingLevel !== undefined ? { thinkingLevel: managed.thinkingLevel } : {}),
                isModelRoutePinned: () => managed.modelRoutePinned === true,
                miniModel: connection ? (getMiniModel(connection) ?? connection.defaultModel) : undefined,
                session: {
                    id: `title-${managed.id}`,
                    workspaceRootPath: managed.workspace.rootPath,
                    llmConnection: managed.llmConnection,
                    createdAt: Date.now(),
                    lastUsedAt: Date.now(),
                },
                isHeadless: true,
            }), buildBackendHostRuntimeContext()) as AgentInstance;
            await agent.postInit();
            isTemporary = true;
            if (!sessionOpOwnsSessionOperation(sessionOperationContext, managed)) {
                agent.destroy();
                return;
            }
            sessionLog.info(`[generateTitle] Created temporary agent for session ${managed.id}`);
        }
        catch (error) {
            if (!sessionOpOwnsSessionOperation(sessionOperationContext, managed))
                return;
            sessionLog.error(`[generateTitle] Failed to create temporary agent:`, error);
            return;
        }
    }
    if (!agent) {
        sessionLog.warn(`[generateTitle] No agent and no connection for session ${managed.id}`);
        return;
    }
    try {
        // Race-free language resolution from persisted UI language; undefined => auto-detect (#885).
        const titleLanguage = resolveTitleLanguageName();
        sessionLog.info(`[generateTitle] language at call time`, {
            sessionId: managed.id,
            persistedUiLanguage: getPersistedUiLanguage() ?? null,
            resolvedLanguage: i18n.resolvedLanguage ?? null,
            titleLanguage: titleLanguage ?? null,
        });
        const title = await agent.generateTitle(userMessage, omitUndefined({ language: titleLanguage }));
        if (!sessionOpOwnsSessionOperation(sessionOperationContext, managed))
            return;
        if (title) {
            managed.name = title;
            sessionOperationContext.owner["persistSession"](managed);
            // Flush immediately to ensure disk is up-to-date before notifying renderer.
            // This prevents race condition where lazy loading reads stale disk data
            // (the persistence queue has a 500ms debounce).
            await sessionOperationContext.owner.flushSession(managed.id);
            if (!sessionOpOwnsSessionOperation(sessionOperationContext, managed))
                return;
            // Now safe to notify renderer - disk is authoritative
            sessionOperationContext.owner["sendEvent"]({ type: 'title_generated', sessionId: managed.id, title }, managed.workspace.id);
            sessionLog.info(`Generated title for session ${managed.id}: "${title}"`);
            // Evaluate auto-labels on the synthesized title + user message to tag session topic
            sessionOpEvaluateAndApplyAutoLabels(sessionOperationContext, managed, `${title}\n${userMessage}`);
        }
        else {
            sessionLog.warn(`Title generation returned null for session ${managed.id}`);
        }
    }
    catch (error) {
        if (!sessionOpOwnsSessionOperation(sessionOperationContext, managed))
            return;
        sessionLog.error(`Failed to generate title for session ${managed.id}:`, error);
        // Surface quota/auth errors to the user — these indicate the main chat call will also fail
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (errorMsg.includes('quota') || errorMsg.includes('429') || errorMsg.includes('401') || errorMsg.includes('insufficient')) {
            sessionOperationContext.owner["sendEvent"]({
                type: 'typed_error',
                sessionId: managed.id,
                error: {
                    code: 'provider_error',
                    title: 'API Error',
                    message: `API error: ${errorMsg.slice(0, 200)}`,
                    actions: [{ key: 'r', label: 'Retry', action: 'retry' }],
                    canRetry: true,
                }
            }, managed.workspace.id);
        }
    }
    finally {
        // Clean up temporary agent
        if (isTemporary && agent) {
            agent.destroy();
        }
    }
}

async function sessionOpPersistRegisteredObjectiveForCurrentTurn(sessionOperationContext: SessionOperationContext, managed: ManagedSession, runtimeAgent: AgentInstance, objectiveBefore: ActiveSessionObjective, registered: ActiveSessionObjective, generation: number, authorityEpoch: number): Promise<void> {
    const admissionBinding = sessionOperationContext.state.runtimeToolAdmissionBindings.get(runtimeAgent);
    if (admissionBinding && (admissionBinding.managed !== managed
        || admissionBinding.generation !== generation
        || admissionBinding.activeObjective !== objectiveBefore
        || admissionBinding.authorityEpoch !== authorityEpoch)) {
        throw new Error('Acceptance registration no longer owns its provider turn.');
    }
    // Registration is itself a tool in this provider turn. Hold concurrent
    // admissions until its new objective revision is durable, then rebind the
    // same turn. A real human steer still fails the ownership checks below.
    let releaseRebind: (() => void) | undefined;
    let rebindChain: Promise<void> | undefined;
    if (admissionBinding) {
        const rebindStep = new Promise<void>(resolve => { releaseRebind = resolve; });
        rebindChain = admissionBinding.pendingRebind
            ? admissionBinding.pendingRebind.then(() => rebindStep)
            : rebindStep;
        admissionBinding.pendingRebind = rebindChain;
    }
    try {
        managed.activeObjective = registered;
        sessionOperationContext.owner["persistSession"](managed);
        await sessionOperationContext.owner.flushSession(managed.id);
        if (managed.agent !== runtimeAgent || managed.processingGeneration !== generation
            || managed.activeObjective !== registered
            || (sessionOperationContext.state.objectiveAuthorityEpochs.get(managed) ?? 0) !== authorityEpoch) {
            throw new Error('The objective changed while acceptance criteria were being persisted; the stale provider turn receives no registration receipt.');
        }
        if (admissionBinding) {
            if (sessionOperationContext.state.runtimeToolAdmissionBindings.get(runtimeAgent) !== admissionBinding
                || admissionBinding.activeObjective !== objectiveBefore) {
                throw new Error('Acceptance registration lost its provider-turn binding.');
            }
            admissionBinding.activeObjective = registered;
        }
    }
    finally {
        releaseRebind?.();
        if (admissionBinding && rebindChain) {
            void rebindChain.finally(() => {
                if (admissionBinding.pendingRebind === rebindChain)
                    delete admissionBinding.pendingRebind;
            });
        }
    }
}

export { sessionOpGenerateTitle as generateTitle };
export { sessionOpPersistRegisteredObjectiveForCurrentTurn as persistRegisteredObjectiveForCurrentTurn };
