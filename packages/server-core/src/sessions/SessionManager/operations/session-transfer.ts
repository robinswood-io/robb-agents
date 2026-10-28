import {omitUndefined, setOptional } from '@craft-agent/shared/utils/json';
import type { SessionOperationContext } from '../operation-context.ts';
import { persistenceRootFor } from '../policy.ts';
import { setPermissionMode, hydratePreviousPermissionMode, generateConversationSummary } from '@craft-agent/shared/agent';
import { resolveBackendContext, createBackendFromResolvedContext } from '@craft-agent/shared/agent/backend';
import { getWorkspaceByNameOrId, getGitBashPath } from '@craft-agent/shared/config';
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import { getSessionPath as getSessionStoragePath, ensureSessionDir, getSessionFilePath, generateSessionId, captureSessionPersistenceRootPath, sessionPersistenceQueue, writeSessionJsonl, createImportedSessionIsolation, serializeSession, validateBundle } from '@craft-agent/shared/sessions';
import type { SessionBundle, DispatchMode, StoredSession } from '@craft-agent/shared/sessions';
import { loadWorkspaceSources } from '@craft-agent/shared/sources';
import { restoreFiles } from '@craft-agent/shared/utils/bundle-files';
import type { RemoteSessionTransferPayload, ImportRemoteSessionTransferResult } from '@craft-agent/shared/protocol';
import { storedToMessage } from '@craft-agent/core/types';
import { redactSecretLikeMaterial } from '@craft-agent/shared/utils';
import { getPlatformSessionAppProvenance, resolveImportedSessionAppProvenance } from '../../session-app-provenance';
import { buildExtractiveTransferSummary, selectTransferSummaryMessages } from '../../transfer-summary-context';
import type { ManagedSession } from '../managed-session.ts';
import { buildBackendHostRuntimeContext, hasImmutableMissionRoute, hasMissionDispatchTriplet } from '../mission-route.ts';
import { _platform, sessionLog } from '../runtime-platform.ts';
import { createManagedSession, sanitizeParentSessionLabels } from '../session-creation.ts';
import { DEFAULT_TOKEN_USAGE } from '../session-presentation.ts';
import { resolveEffectiveSessionSourceSelection } from '../source-selection.ts';
import { trackSessionOperation as sessionOpTrackSessionOperation, ownsSessionOperation as sessionOpOwnsSessionOperation, trackManagerOperation as sessionOpTrackManagerOperation, assertSessionOperationOwner as sessionOpAssertSessionOperationOwner } from './track-session-operation.ts';

// ============================================
// Export / Import / Dispatch
// ============================================
async function sessionOpGenerateRemoteTransferSummary(sessionOperationContext: SessionOperationContext, managed: ManagedSession): Promise<string | null> {
    await sessionOperationContext.owner["ensureMessagesLoaded"](managed);
    const messages = managed.messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .filter(m => !m.isIntermediate)
        .map(m => ({
        type: m.role as 'user' | 'assistant',
        content: redactSecretLikeMaterial(m.content),
    }));
    if (messages.length === 0)
        return null;
    // Do not hand a governed transcript to an auxiliary provider path. Remote
    // transfer remains available through a bounded local extract only.
    if (hasImmutableMissionRoute(managed) || hasMissionDispatchTriplet(managed)) {
        return buildExtractiveTransferSummary(messages);
    }
    const workspaceRootPath = managed.workspace.rootPath;
    const wsConfig = loadWorkspaceConfig(workspaceRootPath);
    const defaultModel = wsConfig?.defaults?.model;
    const backendContext = resolveBackendContext({
        ...(managed.llmConnection !== undefined ? { sessionConnectionSlug: managed.llmConnection } : {}),
        ...(wsConfig?.defaults?.defaultLlmConnection !== undefined ? { workspaceDefaultConnectionSlug: wsConfig?.defaults?.defaultLlmConnection } : {}),
        managedModel: managed.model || defaultModel,
    });
    const persistedGitBashPath = getGitBashPath();
    const envOverrides: Record<string, string> = {
        CRAFT_WORKSPACE_PATH: workspaceRootPath,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: backendContext.resolvedModel,
        ...(persistedGitBashPath ? { CLAUDE_CODE_GIT_BASH_PATH: persistedGitBashPath } : {}),
    };
    const agent = createBackendFromResolvedContext({
        context: backendContext,
        hostRuntime: buildBackendHostRuntimeContext(),
        coreConfig: {
            workspace: managed.workspace,
            isModelRoutePinned: () => managed.modelRoutePinned === true,
            session: {
                id: `${managed.id}-remote-transfer-summary`,
                workspaceRootPath,
                createdAt: Date.now(),
                lastUsedAt: Date.now(),
                ...(managed.workingDirectory !== undefined ? { workingDirectory: managed.workingDirectory } : {}),
                ...(managed.sdkCwd !== undefined ? { sdkCwd: managed.sdkCwd } : {}),
                ...(managed.model !== undefined ? { model: managed.model } : {}),
                ...(managed.llmConnection !== undefined ? { llmConnection: managed.llmConnection } : {}),
                ...(managed.permissionMode !== undefined ? { permissionMode: managed.permissionMode } : {}),
                ...(managed.previousPermissionMode !== undefined ? { previousPermissionMode: managed.previousPermissionMode } : {}),
            },
            ...(managed.thinkingLevel !== undefined ? { thinkingLevel: managed.thinkingLevel } : {}),
            envOverrides,
            isHeadless: true,
        },
        providerOptions: { ...(backendContext.connection?.piAuthProvider !== undefined ? { piAuthProvider: backendContext.connection?.piAuthProvider } : {}) },
    });
    const boundedMessages = selectTransferSummaryMessages(messages);
    const extractiveFallback = buildExtractiveTransferSummary(messages);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        const summary = await Promise.race([
            generateConversationSummary(boundedMessages, async (prompt) => (await agent.queryLlm({ prompt })).text),
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new Error('Provider handoff summary timed out after 15 seconds')), 15000);
            }),
        ]);
        return summary ? redactSecretLikeMaterial(summary) : extractiveFallback;
    }
    catch (error) {
        sessionLog.warn(`Provider summary generation unavailable for ${managed.id}; using bounded local extract`, {
            error: error instanceof Error ? error.message : String(error),
            sourceMessages: messages.length,
            boundedMessages: boundedMessages.length,
        });
        return extractiveFallback;
    }
    finally {
        if (timeout)
            clearTimeout(timeout);
        agent.destroy();
    }
}

async function sessionOpExportRemoteSessionTransfer(sessionOperationContext: SessionOperationContext, sessionId: string, workspaceId: string): Promise<RemoteSessionTransferPayload | null> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed) {
        sessionLog.warn(`[dispatch] Cannot export remote transfer: ${sessionId} not found`);
        return null;
    }
    if (managed.workspace.id !== workspaceId) {
        sessionLog.warn(`[dispatch] Session ${sessionId} does not belong to workspace ${workspaceId}`);
        return null;
    }
    return sessionOpTrackSessionOperation(sessionOperationContext, managed, () => sessionOpPerformExportRemoteSessionTransfer(sessionOperationContext, managed));
}

async function sessionOpPerformExportRemoteSessionTransfer(sessionOperationContext: SessionOperationContext, managed: ManagedSession): Promise<RemoteSessionTransferPayload | null> {
    const sessionId = managed.id;
    if (managed.isProcessing) {
        sessionLog.warn(`[dispatch] Cannot export remote transfer ${sessionId}: still processing`);
        return null;
    }
    sessionOperationContext.owner["persistSession"](managed);
    await sessionPersistenceQueue.flush(sessionId, persistenceRootFor(managed));
    if (!sessionOpOwnsSessionOperation(sessionOperationContext, managed))
        return null;
    const summary = await sessionOpGenerateRemoteTransferSummary(sessionOperationContext, managed);
    if (!sessionOpOwnsSessionOperation(sessionOperationContext, managed))
        return null;
    if (!summary) {
        sessionLog.warn(`[dispatch] Failed to generate remote transfer summary for ${sessionId}`);
        return null;
    }
    return omitUndefined<RemoteSessionTransferPayload>({
        sourceSessionId: managed.id,
        name: managed.name,
        sessionStatus: managed.sessionStatus,
        labels: managed.labels,
        permissionMode: managed.permissionMode,
        summary,
        trust: 'external-untrusted',
        secretLikeTextRedacted: true,
    });
}

async function sessionOpImportRemoteSessionTransfer(sessionOperationContext: SessionOperationContext, workspaceId: string, payload: RemoteSessionTransferPayload): Promise<ImportRemoteSessionTransferResult> {
    return sessionOpTrackManagerOperation(sessionOperationContext, () => sessionOpPerformImportRemoteSessionTransfer(sessionOperationContext, workspaceId, payload));
}

async function sessionOpPerformImportRemoteSessionTransfer(sessionOperationContext: SessionOperationContext, workspaceId: string, payload: RemoteSessionTransferPayload): Promise<ImportRemoteSessionTransferResult> {
    if (!payload || typeof payload !== 'object' || typeof payload.summary !== 'string' || !payload.summary.trim()) {
        throw new Error('Invalid remote session transfer payload');
    }
    const session = await sessionOperationContext.owner.performCreateSession(workspaceId, {
        name: payload.name,
        // Remote metadata is untrusted and can never elevate execution rights.
        permissionMode: 'safe',
        sessionStatus: payload.sessionStatus,
        labels: payload.labels,
    });
    const managed = sessionOperationContext.state.sessions.get(session.id);
    if (!managed) {
        throw new Error(`Transferred session ${session.id} was not created`);
    }
    managed.transferredSessionSummary = redactSecretLikeMaterial(payload.summary.trim());
    managed.transferredSessionSummaryApplied = false;
    sessionOperationContext.owner["persistSession"](managed);
    await sessionPersistenceQueue.flush(session.id, persistenceRootFor(managed));
    return { sessionId: session.id };
}

/**
 * Export a session as a portable SessionBundle.
 *
 * Steps:
 * 1. Validate session exists and resolve its workspace
 * 2. If session is processing, refuse (caller must stop it first)
 * 3. Flush pending persistence writes
 * 4. Serialize session directory into a bundle
 */
async function sessionOpExportSession(sessionOperationContext: SessionOperationContext, sessionId: string, workspaceId: string): Promise<SessionBundle | null> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed) {
        sessionLog.warn(`[dispatch] Cannot export session: ${sessionId} not found`);
        return null;
    }
    if (managed.workspace.id !== workspaceId) {
        sessionLog.warn(`[dispatch] Session ${sessionId} does not belong to workspace ${workspaceId}`);
        return null;
    }
    return sessionOpTrackSessionOperation(sessionOperationContext, managed, async () => {
        sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
        if (managed.isProcessing) {
            sessionLog.warn(`[dispatch] Cannot export session ${sessionId}: still processing`);
            return null;
        }
        // Flush pending writes to ensure JSONL is up to date
        sessionOperationContext.owner["persistSession"](managed);
        await sessionPersistenceQueue.flush(sessionId, persistenceRootFor(managed));
        sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
        const bundle = serializeSession(persistenceRootFor(managed), sessionId);
        if (!bundle) {
            sessionLog.error(`[dispatch] Failed to serialize session ${sessionId}`);
            return null;
        }
        return bundle;
    });
}

/**
 * Import a session bundle into a target workspace.
 *
 * Steps:
 * 1. Validate bundle structure and target workspace
 * 2. Generate new session ID (fork) or use original (move)
 * 3. Create session directory and write JSONL + files
 * 4. Register session in-memory
 * 5. Emit session_created event
 * 6. Return new session ID and compatibility warnings
 */
async function sessionOpImportSession(sessionOperationContext: SessionOperationContext, workspaceId: string, bundle: SessionBundle, mode: DispatchMode): Promise<{
    sessionId: string;
    warnings?: string[];
}> {
    return sessionOpTrackManagerOperation(sessionOperationContext, () => sessionOpPerformImportSession(sessionOperationContext, workspaceId, bundle, mode));
}

async function sessionOpPerformImportSession(sessionOperationContext: SessionOperationContext, workspaceId: string, bundle: SessionBundle, mode: DispatchMode): Promise<{
    sessionId: string;
    warnings?: string[];
}> {
    sessionLog.info(`[import] Starting import: workspaceId=${workspaceId}, mode=${mode}, bundleSessionId=${bundle?.session?.header?.id ?? 'unknown'}, files=${bundle?.files?.length ?? 0}`);
    if (!validateBundle(bundle)) {
        throw new Error('Invalid session bundle');
    }
    const workspace = getWorkspaceByNameOrId(workspaceId);
    if (!workspace) {
        throw new Error(`Workspace ${workspaceId} not found`);
    }
    sessionLog.info(`[import] Target workspace: "${workspace.name}" at ${workspace.rootPath}`);
    const warnings: string[] = [];
    const workspaceRootPath = workspace.rootPath;
    const header = bundle.session.header;
    const currentApp = getPlatformSessionAppProvenance(_platform);
    const importedAppProvenance = resolveImportedSessionAppProvenance(mode, header, currentApp);
    const importedExecutionIsolation = createImportedSessionIsolation(header, workspaceRootPath);
    if (importedExecutionIsolation) {
        warnings.push('Imported task execution is quarantined until re-authorized by the TaskRunner');
    }
    // Determine session ID
    const sessionId = mode === 'move'
        ? bundle.session.header.id
        : generateSessionId(workspaceRootPath);
    // Check for ID collision on move
    if (mode === 'move' && sessionOperationContext.state.sessions.has(sessionId)) {
        throw new Error(`Session ${sessionId} already exists in target workspace`);
    }
    if (mode === 'move' && sessionPersistenceQueue.isRetired(sessionId, captureSessionPersistenceRootPath(workspaceRootPath))) {
        throw new Error(`Session ${sessionId} was deleted during this app run and cannot be imported until restart`);
    }
    // Create session directory with all subdirectories
    const sessionDir = ensureSessionDir(workspaceRootPath, sessionId);
    // Build the stored session from bundle data
    const storedSession: StoredSession = omitUndefined<StoredSession>({
        id: sessionId,
        workspaceRootPath,
        // Portable bundles are unsigned. Never resume a provider-native session
        // selected by an importing client, because that would be an SDK-session IDOR.

        // Always regenerate sdkCwd for the target workspace.
        // The source sdkCwd points to a path on the originating server
        // which doesn't exist here (cross-server transfer).
        sdkCwd: getSessionStoragePath(workspaceRootPath, sessionId),
        ...(header.name !== undefined ? { name: header.name } : {}),
        createdAt: header.createdAt,
        lastUsedAt: Date.now(),
        ...importedAppProvenance,
        lastMessageAt: header.lastMessageAt,
        isFlagged: header.isFlagged,
        permissionMode: 'safe',
        previousPermissionMode: undefined,
        sessionStatus: header.sessionStatus,
        labels: header.labels,
        enabledSourceSlugs: header.enabledSourceSlugs,
        workingDirectory: undefined,
        model: header.model,
        llmConnection: undefined,
        connectionLocked: false,
        thinkingLevel: header.thinkingLevel,
        hidden: header.hidden,
        taskSlug: header.taskSlug,
        taskRunId: header.taskRunId,
        taskNodeId: header.taskNodeId,
        taskNodeCount: header.taskNodeCount,
        taskDraft: header.taskDraft,
        executionIsolation: importedExecutionIsolation,
        // Imported sessions never retain local Mission v2 authority.
        missionId: undefined,
        missionWorkItemId: undefined,
        missionDispatchId: undefined,
        missionRole: undefined,
        transferredSessionSummary: header.transferredSessionSummary,
        transferredSessionSummaryApplied: header.transferredSessionSummaryApplied,
        messages: bundle.session.messages.map(message => message.internalOrigin?.kind === 'user-input'
            ? { ...message, isQueued: false } : message),
        tokenUsage: header.tokenUsage ?? DEFAULT_TOKEN_USAGE,
    });
    if (bundle.branchInfo) {
        warnings.push('Unsigned provider-native branch metadata was ignored for security');
    }
    // Fork-specific: clear sharing state and attempt resume-first strategy
    if (mode === 'fork') {
        delete storedSession.sharedUrl;
        delete storedSession.sharedId;
        // Provider state is not portable. Import the transcript with the target
        // workspace's explicit defaults; never search for a similar connection.
        delete storedSession.sdkSessionId;
        delete storedSession.llmConnection;
        storedSession.connectionLocked = false;
        // Clear working directory — the source path won't exist on a different server.
        // The user can set a new cwd after the session is transferred.
        delete storedSession.workingDirectory;
    }
    // Check source compatibility (before writing JSONL so fixes are persisted)
    if (storedSession.enabledSourceSlugs?.length) {
        const availableSources = loadWorkspaceSources(workspaceRootPath);
        const availableSlugs = new Set(availableSources.map(s => s.config.slug));
        const missingSources = storedSession.enabledSourceSlugs.filter(s => !availableSlugs.has(s));
        if (missingSources.length > 0) {
            sessionLog.warn(`[import] Sources not available: ${missingSources.join(', ')}`);
            warnings.push(`Sources not available in target workspace: ${missingSources.join(', ')}`);
        }
    }
    if (storedSession.parentSessionId === sessionId)
        delete storedSession.parentSessionId;
    setOptional(storedSession, "labels", sanitizeParentSessionLabels(sessionId, storedSession.parentSessionId, storedSession.labels));
    // Write JSONL file (after compatibility checks so remapped values are persisted)
    const sessionFile = getSessionFilePath(workspaceRootPath, sessionId);
    sessionLog.info(`[import] Writing JSONL: ${sessionFile} (llmConnection=${storedSession.llmConnection ?? 'default'}, messages=${storedSession.messages.length})`);
    writeSessionJsonl(sessionFile, storedSession);
    // Write all bundle files (attachments, plans, data, downloads, etc.)
    // Uses restoreFiles() for path traversal, size, and base64 validation.
    restoreFiles(sessionDir, bundle.files);
    // Register in-memory — pass session metadata without messages to avoid
    // StoredMessage[] vs Message[] type mismatch, then convert messages separately
    const { messages: bundleMessages, ...sessionMeta } = storedSession;
    const managed = createManagedSession(sessionMeta, workspace, {
        messagesLoaded: true,
        workingDirectory: storedSession.workingDirectory,
        ...resolveEffectiveSessionSourceSelection(storedSession.enabledSourceSlugs, loadWorkspaceConfig(workspaceRootPath)?.defaults?.enabledSourceSlugs),
    });
    managed.messages = bundleMessages.map(storedToMessage);
    setPermissionMode(sessionId, managed.permissionMode ?? 'ask', { changedBy: 'restore' });
    if (managed.previousPermissionMode) {
        hydratePreviousPermissionMode(sessionId, managed.previousPermissionMode);
    }
    sessionOperationContext.state.sessions.set(sessionId, managed);
    // Initialize automation metadata
    const automationSystem = sessionOperationContext.state.automationSystems.get(workspaceRootPath);
    if (automationSystem) {
        automationSystem.setInitialSessionMetadata(sessionId, {
            ...(storedSession.permissionMode !== undefined ? { permissionMode: storedSession.permissionMode } : {}),
            ...(managed.labels !== undefined ? { labels: managed.labels } : {}),
            ...(storedSession.isFlagged !== undefined ? { isFlagged: storedSession.isFlagged } : {}),
            ...(storedSession.sessionStatus !== undefined ? { sessionStatus: storedSession.sessionStatus } : {}),
            ...(managed.name !== undefined ? { sessionName: managed.name } : {}),
        });
    }
    // Built by hand (not via createSession), so announce it explicitly.
    sessionOperationContext.owner.notifySessionCreated(workspaceId, sessionId);
    sessionLog.info(`[import] Complete: sessionId=${sessionId}, transferredSummary=${managed.transferredSessionSummary ? `${managed.transferredSessionSummary.length} chars` : 'none'}, applied=${managed.transferredSessionSummaryApplied}, warnings=${warnings.length > 0 ? warnings.join('; ') : 'none'}`);
    return omitUndefined({ sessionId, warnings: warnings.length > 0 ? warnings : undefined });
}

export { sessionOpGenerateRemoteTransferSummary as generateRemoteTransferSummary };
export { sessionOpExportRemoteSessionTransfer as exportRemoteSessionTransfer };
export { sessionOpPerformExportRemoteSessionTransfer as performExportRemoteSessionTransfer };
export { sessionOpImportRemoteSessionTransfer as importRemoteSessionTransfer };
export { sessionOpPerformImportRemoteSessionTransfer as performImportRemoteSessionTransfer };
export { sessionOpExportSession as exportSession };
export { sessionOpImportSession as importSession };
export { sessionOpPerformImportSession as performImportSession };
