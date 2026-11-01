import { omitUndefined } from '@craft-agent/shared/utils/json';
import { copySessionBranchStorage, prepareSessionBranchRuntime } from './branch-session-preparation.ts';
import type { ValidatedSessionBranch } from './branch-session-preparation.ts';
import type { SessionOperationContext } from '../operation-context.ts';
import { persistenceRootFor } from '../policy.ts';
import { isDeepStrictEqual } from 'node:util';
import { requirePermissionMode } from '@craft-agent/shared/agent/mode-types';
import { setPermissionMode, hydratePreviousPermissionMode } from '@craft-agent/shared/agent';
import { resolveBackendContext } from '@craft-agent/shared/agent/backend';
import { getLlmConnection, getDefaultThinkingLevel, getWorkspaceByNameOrId, loadConfigDefaults } from '@craft-agent/shared/config';
import { getBuiltinPlaybook, loadWorkspacePlaybook } from '@craft-agent/shared/playbooks';
import { validateSessionExecutionIsolation } from '@craft-agent/shared/tasks';
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import { loadSession as loadStoredSession, createSession as createStoredSession, getSessionPath as getSessionStoragePath, assertSessionPersistenceRootIdentity, captureSessionPersistenceRootIdentity, SessionPersistenceRootIdentityError, sessionPersistenceQueue } from '@craft-agent/shared/sessions';
import type { SessionDelegation, MissionOrdinaryRouteLock } from '@craft-agent/shared/sessions';
import type { Session, CreateSessionOptions } from '@craft-agent/shared/protocol';
import { normalizeThinkingLevel } from '@craft-agent/shared/agent/thinking-levels';
import { getPlatformSessionAppProvenance } from '../../session-app-provenance';
import { assertValidOrdinaryMissionRouteLock, canonicalMissionSourceSlugs } from '../mission-route.ts';
import { isTerminalReviewSession } from '../review-lifecycle.ts';
import { _platform, sessionLog } from '../runtime-platform.ts';
import { createManagedSession, resolveCreateSessionRouteProvenance, sanitizeParentSessionLabels } from '../session-creation.ts';
import { managedToSession } from '../session-presentation.ts';
import { resolveBranchedSessionSourceSelection, resolveEffectiveSessionSourceSelection } from '../source-selection.ts';
import { getClaudeTurnAnchor, getPiTurnAnchor, isClaudeMessageUuid } from '../turn-anchors.ts';
import { ownsSessionOperation as sessionOpOwnsSessionOperation } from './track-session-operation.ts';

async function sessionOpPerformCreateSession(sessionOperationContext: SessionOperationContext, workspaceId: string, options?: CreateSessionOptions, internal?: {
    emitCreatedEvent?: boolean;
    delegation?: SessionDelegation;
    missionOrdinaryRouteLock?: MissionOrdinaryRouteLock;
}): Promise<Session> {
    const workspace = getWorkspaceByNameOrId(workspaceId);
    if (!workspace) {
        throw new Error(`Workspace ${workspaceId} not found`);
    }
    // Get new session defaults from workspace config (with global fallback)
    // Options.permissionMode overrides the workspace default (used by EditPopover for auto-execute)
    const workspaceRootPath = workspace.rootPath;
    const selectedPlaybook = options?.playbookSlug
        ? loadWorkspacePlaybook(workspaceRootPath, options.playbookSlug) ?? getBuiltinPlaybook(options.playbookSlug)
        : null;
    if (options?.playbookSlug && !selectedPlaybook) {
        throw new Error(`Unknown playbook: ${options.playbookSlug}`);
    }
    const wsConfig = loadWorkspaceConfig(workspaceRootPath);
    const globalDefaults = loadConfigDefaults();
    // Read permission mode from workspace config, fallback to global defaults
    const requestedPermissionMode = requirePermissionMode(options?.permissionMode !== undefined
        ? options.permissionMode
        : wsConfig?.defaults?.permissionMode ?? globalDefaults.workspaceDefaults.permissionMode);
    // Mission v2 reviewers/supervisors and legacy delegated reviewers are
    // terminal, read-only agents. Clamp at the creation boundary so their
    // very first runtime cannot inherit Execute before restore-time guards run.
    const defaultPermissionMode = isTerminalReviewSession({
        missionRole: options?.missionRole,
        delegation: internal?.delegation,
    }) ? 'safe' : requestedPermissionMode;
    const userDefaultWorkingDir = wsConfig?.defaults?.workingDirectory || undefined;
    // Resolve thinking level with caller-first precedence, matching permissionMode above:
    //   caller override → workspace default → global default.
    // normalizeThinkingLevel() tolerates undefined/unknown inputs.
    const defaultThinkingLevel = normalizeThinkingLevel(options?.thinkingLevel)
        ?? normalizeThinkingLevel(wsConfig?.defaults?.thinkingLevel)
        ?? getDefaultThinkingLevel();
    // Get default model from workspace config (used when no session-specific model is set)
    const defaultModel = wsConfig?.defaults?.model;
    // Materialize workspace defaults for this process, but preserve the fact
    // that an omitted session selection must keep following those defaults.
    let sourceSlugsForPersistence = options?.enabledSourceSlugs;
    let sourceSelection = resolveEffectiveSessionSourceSelection(options?.enabledSourceSlugs, wsConfig?.defaults?.enabledSourceSlugs);
    const selectedConnectionDefault = options?.llmConnection
        && options.llmConnection !== wsConfig?.defaults?.defaultLlmConnection
        ? getLlmConnection(options.llmConnection)?.defaultModel
        : defaultModel;
    const resolvedModelOption = options?.model ?? selectedConnectionDefault;
    // Resolve backend target early for branching policy checks.
    const targetBackendContext = resolveBackendContext({
        ...(options?.llmConnection !== undefined ? { sessionConnectionSlug: options?.llmConnection } : {}),
        ...(wsConfig?.defaults?.defaultLlmConnection !== undefined ? { workspaceDefaultConnectionSlug: wsConfig?.defaults?.defaultLlmConnection } : {}),
        ...(resolvedModelOption !== undefined ? { managedModel: resolvedModelOption } : {}),
    });
    const creationRoute = resolveCreateSessionRouteProvenance(options, targetBackendContext.connection?.slug);
    const targetProviderType = targetBackendContext.connection?.providerType
        ?? (targetBackendContext.provider === 'pi' ? 'pi' : 'anthropic');
    const targetPiAuthProvider = targetBackendContext.connection?.piAuthProvider;
    // Resolve working directory from options:
    // - 'user_default' or undefined: Use workspace's configured default
    // - 'none': No working directory (empty string means session folder only)
    // - Absolute path: Use as-is
    let resolvedWorkingDir: string | undefined;
    if (options?.workingDirectory === 'none') {
        resolvedWorkingDir = undefined; // No working directory
    }
    else if (options?.workingDirectory === 'user_default' || options?.workingDirectory === undefined) {
        resolvedWorkingDir = userDefaultWorkingDir;
    }
    else {
        resolvedWorkingDir = options.workingDirectory;
    }
    if (options?.executionIsolation) {
        const isolationDecision = validateSessionExecutionIsolation(options.executionIsolation, workspaceRootPath);
        if (!isolationDecision.allowed) {
            throw new Error(`Invalid session execution isolation: ${isolationDecision.reason ?? 'blocked'}`);
        }
    }
    // Resolve project binding. When a projectId is provided and the project has a
    // workingDirectory configured, inherit it (only when the caller didn't pass an
    // explicit override). This lets "+ New session in {project}" reuse the project's
    // bound directory without duplicating logic on the renderer side.
    // Subtasks inherit the parent's project when the caller didn't bind one explicitly —
    // a child of a project-bound task belongs to that project (board quick-add passes none),
    // so project-scoped filtering sees the whole task family.
    const inheritedProjectId = options?.parentSessionId
        ? sessionOperationContext.state.sessions.get(options.parentSessionId)?.projectId
        : undefined;
    const requestedProjectId = options?.projectId ?? inheritedProjectId;
    let resolvedProjectId: string | undefined;
    if (requestedProjectId) {
        const { loadProjectById } = await import('@craft-agent/shared/projects');
        const project = loadProjectById(workspaceRootPath, requestedProjectId);
        if (!project) {
            // An EXPLICIT binding to a missing project is a caller bug; an inherited one
            // (parent's project deleted since) just no-ops rather than failing the child.
            if (options?.projectId) {
                throw new Error(`Project ${options.projectId} not found in workspace ${workspaceId}`);
            }
        }
        else {
            resolvedProjectId = project.config.id;
            if ((options?.workingDirectory === undefined || options?.workingDirectory === 'user_default') &&
                project.config.workingDirectory) {
                resolvedWorkingDir = project.config.workingDirectory;
            }
        }
    }
    const ordinaryRouteLock = internal?.missionOrdinaryRouteLock;
    if (ordinaryRouteLock) {
        assertValidOrdinaryMissionRouteLock(ordinaryRouteLock);
        if (!options?.missionId
            || !options.missionWorkItemId
            || !options.missionDispatchId
            || !options.missionRole
            || options.missionRouteLockSha256
            || creationRoute.llmConnection !== ordinaryRouteLock.connectionSlug
            || resolvedModelOption !== ordinaryRouteLock.model
            || defaultThinkingLevel !== ordinaryRouteLock.thinkingLevel
            || resolvedWorkingDir !== ordinaryRouteLock.cwd
            || !isDeepStrictEqual(canonicalMissionSourceSlugs(sourceSelection.enabledSourceSlugs), ordinaryRouteLock.effectiveSourceSlugs)
            || sourceSlugsForPersistence === undefined) {
            throw new Error('Ordinary Mission route lock does not match the exact session projection');
        }
    }
    // Validate branch request up-front so branch metadata is only set for valid branches.
    // This prevents creating sessions that claim to be branched but don't have copied history.
    let validatedBranch: ValidatedSessionBranch;
    if (options?.branchFromSessionId || options?.branchFromMessageId) {
        if (!options.branchFromSessionId || !options.branchFromMessageId) {
            sessionLog.warn('Branch validation failed: missing branchFromSessionId or branchFromMessageId', {
                workspaceId,
                branchFromSessionId: options.branchFromSessionId,
                branchFromMessageId: options.branchFromMessageId,
            });
            throw new Error('Invalid branch request: both branchFromSessionId and branchFromMessageId are required');
        }
        const sourceManaged = sessionOperationContext.state.sessions.get(options.branchFromSessionId);
        if (sourceManaged) {
            if (!sessionOpOwnsSessionOperation(sessionOperationContext, sourceManaged)) {
                throw new Error(`Invalid branch request: source session ${options.branchFromSessionId} is being deleted`);
            }
            if (sourceManaged.workspace.rootPath !== workspaceRootPath) {
                sessionLog.warn('Branch validation failed: source session belongs to different workspace', {
                    workspaceId,
                    targetWorkspaceRootPath: workspaceRootPath,
                    sourceWorkspaceRootPath: sourceManaged.workspace.rootPath,
                    branchFromSessionId: options.branchFromSessionId,
                });
                throw new Error('Invalid branch request: source session belongs to a different workspace');
            }
            // Flush source session to disk to ensure latest message list is available for branch copy.
            sessionOperationContext.owner["persistSession"](sourceManaged);
            await sessionPersistenceQueue.flush(sourceManaged.id, persistenceRootFor(sourceManaged));
        }
        const sourcePersistenceRootIdentity = sourceManaged?.persistenceRootIdentity
            ?? captureSessionPersistenceRootIdentity(workspaceRootPath);
        const sourcePersistenceRootPath = assertSessionPersistenceRootIdentity(sourcePersistenceRootIdentity);
        const assertSourcePersistenceRoot = (): void => {
            const verifiedRoot = assertSessionPersistenceRootIdentity(sourcePersistenceRootIdentity);
            if (verifiedRoot !== sourcePersistenceRootPath) {
                throw new SessionPersistenceRootIdentityError(`Branch source persistence root changed: ${options.branchFromSessionId}`);
            }
        };
        const sourceSession = loadStoredSession(sourcePersistenceRootPath, options.branchFromSessionId);
        if (!sourceSession) {
            sessionLog.warn('Branch validation failed: source session not found on disk', {
                workspaceId,
                branchFromSessionId: options.branchFromSessionId,
            });
            throw new Error(`Invalid branch request: source session ${options.branchFromSessionId} not found`);
        }
        // Branch source provenance is host-owned. A renderer only identifies the
        // parent; it cannot freeze a materialized workspace default into an
        // explicit child selection (or substitute a different source set).
        const branchedSources = resolveBranchedSessionSourceSelection(sourceManaged ?? {
            ...(sourceSession.enabledSourceSlugs !== undefined ? { enabledSourceSlugs: sourceSession.enabledSourceSlugs } : {}),
            inheritsWorkspaceSourceSlugs: sourceSession.enabledSourceSlugs === undefined,
        }, wsConfig?.defaults?.enabledSourceSlugs);
        sourceSlugsForPersistence = branchedSources.persistedSourceSlugs;
        sourceSelection = branchedSources;
        const sourceBackendContext = resolveBackendContext({
            sessionConnectionSlug: sourceManaged?.llmConnection || sourceSession.llmConnection,
            ...(wsConfig?.defaults?.defaultLlmConnection !== undefined ? { workspaceDefaultConnectionSlug: wsConfig?.defaults?.defaultLlmConnection } : {}),
            managedModel: sourceManaged?.model || sourceSession.model,
        });
        const sourceProviderType = sourceBackendContext.connection?.providerType
            ?? (sourceBackendContext.provider === 'pi' ? 'pi' : 'anthropic');
        const sourcePiAuthProvider = sourceBackendContext.connection?.piAuthProvider;
        const providerMismatch = sourceBackendContext.provider !== targetBackendContext.provider;
        const providerTypeMismatch = sourceProviderType !== targetProviderType;
        const piAuthProviderMismatch = sourceBackendContext.provider === 'pi' && sourcePiAuthProvider !== targetPiAuthProvider;
        if (providerMismatch || providerTypeMismatch || piAuthProviderMismatch) {
            sessionLog.warn('Branch validation failed: source and target providers are incompatible', {
                workspaceId,
                branchFromSessionId: options.branchFromSessionId,
                sourceProvider: sourceBackendContext.provider,
                sourceProviderType,
                sourcePiAuthProvider,
                targetProvider: targetBackendContext.provider,
                targetProviderType,
                targetPiAuthProvider,
            });
            throw new Error('Branching is only supported within the same provider/backend. Switch this panel connection and try again.');
        }
        const branchIdx = sourceSession.messages.findIndex(m => m.id === options.branchFromMessageId);
        if (branchIdx === -1) {
            sessionLog.warn('Branch validation failed: message not found in source session', {
                workspaceId,
                branchFromSessionId: options.branchFromSessionId,
                branchFromMessageId: options.branchFromMessageId,
            });
            throw new Error(`Invalid branch request: message ${options.branchFromMessageId} not found in source session`);
        }
        // New branches always use strict provider-level SDK fork semantics.
        // Seeded mode remains only for legacy sessions created before strict fork was enforced.
        const branchContextStrategy: 'sdk-fork' | 'seeded-fresh-session' = 'sdk-fork';
        const branchFromSdkSessionId = branchContextStrategy === 'sdk-fork'
            ? (sourceManaged?.sdkSessionId || sourceSession.sdkSessionId)
            : undefined;
        const branchFromSessionPath = branchContextStrategy === 'sdk-fork'
            ? getSessionStoragePath(sourcePersistenceRootPath, options.branchFromSessionId)
            : undefined;
        // Capture parent's sdkCwd so the child SDK subprocess can find the parent's
        // session file (stored under ~/.claude/projects/{cwd-hash}/).
        const branchFromSdkCwd = branchContextStrategy === 'sdk-fork'
            ? (sourceManaged?.sdkCwd || sourceSession.sdkCwd)
            : undefined;
        // Provider-native branch anchor at branch point.
        // - Claude: assistant message UUID (resumeSessionAt), but only when anchor lineage
        //   matches the parent SDK session being resumed.
        // - Pi: session entry ID loaded from sidecar (pi-turn-anchors.json)
        const branchMessage = sourceSession.messages[branchIdx];
        let branchFromSdkTurnId: string | undefined;
        if (branchContextStrategy === 'sdk-fork') {
            if (sourceBackendContext.provider === 'pi') {
                if (branchFromSessionPath) {
                    branchFromSdkTurnId = await getPiTurnAnchor(branchFromSessionPath, options.branchFromMessageId, assertSourcePersistenceRoot);
                    if (!branchFromSdkTurnId) {
                        sessionLog.warn('Pi branch anchor missing: falling back to full-history fork for this branch', {
                            workspaceId,
                            branchFromSessionId: options.branchFromSessionId,
                            branchFromMessageId: options.branchFromMessageId,
                        });
                    }
                }
            }
            else if (sourceBackendContext.provider === 'anthropic') {
                if (branchFromSessionPath && branchFromSdkSessionId) {
                    const anchor = await getClaudeTurnAnchor(branchFromSessionPath, options.branchFromMessageId, assertSourcePersistenceRoot);
                    if (!anchor) {
                        sessionLog.warn('Claude branch anchor missing: falling back to full-history fork for this branch', {
                            workspaceId,
                            branchFromSessionId: options.branchFromSessionId,
                            branchFromMessageId: options.branchFromMessageId,
                        });
                    }
                    else if (!anchor.sdkMessageUuid || !isClaudeMessageUuid(anchor.sdkMessageUuid)) {
                        sessionLog.warn('Claude branch anchor malformed: falling back to full-history fork for this branch', {
                            workspaceId,
                            branchFromSessionId: options.branchFromSessionId,
                            branchFromMessageId: options.branchFromMessageId,
                            anchorSdkSessionId: anchor.sdkSessionId,
                        });
                    }
                    else if (anchor.sdkSessionId !== branchFromSdkSessionId) {
                        sessionLog.warn('Claude branch anchor lineage mismatch: falling back to full-history fork for this branch', {
                            workspaceId,
                            branchFromSessionId: options.branchFromSessionId,
                            branchFromMessageId: options.branchFromMessageId,
                            anchorSdkSessionId: anchor.sdkSessionId,
                            parentSdkSessionId: branchFromSdkSessionId,
                        });
                    }
                    else {
                        branchFromSdkTurnId = anchor.sdkMessageUuid;
                    }
                }
            }
            else {
                branchFromSdkTurnId = branchMessage?.turnId;
            }
        }
        if (branchContextStrategy === 'sdk-fork' && !branchFromSdkSessionId) {
            sessionLog.warn('Branch validation failed: sdk-fork requires parent SDK session ID', {
                workspaceId,
                branchFromSessionId: options.branchFromSessionId,
                sourceProvider: sourceBackendContext.provider,
                targetProvider: targetBackendContext.provider,
            });
            throw new Error('Cannot create branch yet: parent session SDK context is not initialized. Send one message in the parent session and try again.');
        }
        validatedBranch = omitUndefined<NonNullable<ValidatedSessionBranch>>({
            sourceSessionId: options.branchFromSessionId,
            sourceMessageId: options.branchFromMessageId,
            sourceSession,
            branchIdx,
            branchContextStrategy,
            branchFromSdkSessionId,
            branchFromSessionPath,
            branchFromSdkCwd,
            branchFromSdkTurnId,
            sourceProvider: sourceBackendContext.provider,
            sourcePersistenceRootPath,
            sourcePersistenceRootIdentity,
        });
        sessionLog.info('Branch validation succeeded', {
            workspaceId,
            branchFromSessionId: validatedBranch.sourceSessionId,
            branchFromMessageId: validatedBranch.sourceMessageId,
            branchContextStrategy: validatedBranch.branchContextStrategy,
            branchFromSdkSessionId: !!validatedBranch.branchFromSdkSessionId,
            copiedMessageCount: validatedBranch.branchIdx + 1,
        });
    }
    // Use storage layer to create and persist the session
    const currentApp = getPlatformSessionAppProvenance(_platform);
    const storedSession = await createStoredSession(workspaceRootPath, omitUndefined<NonNullable<Parameters<typeof createStoredSession>[1]>>({
        name: options?.name,
        permissionMode: defaultPermissionMode,
        workingDirectory: resolvedWorkingDir,
        hidden: options?.hidden,
        sessionStatus: options?.sessionStatus,
        // The storage helper allocates the ID internally, so a new session cannot
        // legitimately self-reference yet. Canonicalize against the structural
        // parent before the first durable write.
        labels: sanitizeParentSessionLabels('', options?.parentSessionId, options?.labels),
        isFlagged: options?.isFlagged,
        projectId: resolvedProjectId,
        parentSessionId: options?.parentSessionId,
        delegation: internal?.delegation,
        taskSlug: options?.taskSlug,
        taskRunId: options?.taskRunId,
        taskNodeId: options?.taskNodeId,
        taskDraft: options?.taskDraft,
        executionIsolation: options?.executionIsolation,
        missionId: options?.missionId,
        missionWorkItemId: options?.missionWorkItemId,
        missionDispatchId: options?.missionDispatchId,
        missionRole: options?.missionRole,
        missionRouteLockSha256: options?.missionRouteLockSha256,
        missionOrdinaryRouteLock: internal?.missionOrdinaryRouteLock,
        playbookSlug: selectedPlaybook?.manifest.slug,
        // Persist only an EXPLICIT selection (e.g. a task's spec.sources on its subtasks).
        // The workspace-default fallback stays dynamic — freezing it into the header would
        // pin every ordinary session to the defaults as of its creation time.
        enabledSourceSlugs: sourceSlugsForPersistence,
        model: options?.model,
        modelRoutePinned: creationRoute.modelRoutePinned,
        llmConnection: creationRoute.llmConnection,
        connectionRoutePinned: creationRoute.connectionRoutePinned,
        // Persist only the caller's explicit reasoning value. Workspace/global
        // defaults remain dynamic, while an explicit pin must survive a crash
        // before the first message triggers the ordinary persistence path.
        thinkingLevel: normalizeThinkingLevel(options?.thinkingLevel),
        thinkingLevelPinned: options?.thinkingLevelPinned ?? options?.thinkingLevel !== undefined,
        createdByApp: currentApp,
        lastUsedByApp: currentApp,
    }));
    // Branch: copy messages from source session up to and including the branch point
    if (validatedBranch) await copySessionBranchStorage(validatedBranch, workspaceRootPath, storedSession);
    // Resolve connection/provider/auth/model using the provider-agnostic backend resolver.
    // Reuse precomputed target context so branch validation and session construction share the same target identity.
    const resolvedContext = targetBackendContext;
    const resolvedModel = resolvedContext.resolvedModel;
    // Log mini agent session creation
    if (options?.systemPromptPreset === 'mini' || options?.model) {
        sessionLog.info(`🤖 Creating mini agent session: model=${resolvedModel}, systemPromptPreset=${options?.systemPromptPreset}`);
    }
    const isBranch = !!validatedBranch;
    const managed = createManagedSession(storedSession, workspace, {
        permissionMode: defaultPermissionMode,
        workingDirectory: resolvedWorkingDir,
        model: resolvedModel,
        modelRoutePinned: creationRoute.modelRoutePinned,
        thinkingLevelPinned: options?.thinkingLevelPinned ?? options?.thinkingLevel !== undefined,
        llmConnection: creationRoute.llmConnection,
        connectionRoutePinned: creationRoute.connectionRoutePinned,
        thinkingLevel: defaultThinkingLevel,
        systemPromptPreset: options?.systemPromptPreset,
        ...sourceSelection,
        branchFromMessageId: validatedBranch?.sourceMessageId,
        branchContextStrategy: validatedBranch?.branchContextStrategy,
        branchFromSdkSessionId: validatedBranch?.branchFromSdkSessionId,
        branchFromSessionPath: validatedBranch?.branchFromSessionPath,
        branchFromSdkCwd: validatedBranch?.branchFromSdkCwd,
        branchFromSdkTurnId: validatedBranch?.branchFromSdkTurnId,
        branchSeedApplied: validatedBranch ? validatedBranch.branchContextStrategy === 'sdk-fork' : undefined,
        messagesLoaded: !isBranch, // Branched sessions: lazy-load messages from JSONL
    });
    // Eagerly load messages for branched sessions so the renderer gets the full
    // conversation immediately (needed for scroll-to-bottom on panel open)
    if (isBranch) await prepareSessionBranchRuntime(managed, sessionOperationContext, isBranch, workspaceId, storedSession, validatedBranch, workspaceRootPath);
    // Initialize mode-manager state immediately to avoid UI/enforcement races
    // before the agent instance is lazily created.
    setPermissionMode(storedSession.id, managed.permissionMode ?? 'ask', { changedBy: 'restore' });
    if (managed.previousPermissionMode) {
        hydratePreviousPermissionMode(storedSession.id, managed.previousPermissionMode);
    }
    sessionOperationContext.state.sessions.set(storedSession.id, managed);
    // Initialize session metadata in AutomationSystem for diffing
    const automationSystem = sessionOperationContext.state.automationSystems.get(workspaceRootPath);
    if (automationSystem) {
        automationSystem.setInitialSessionMetadata(storedSession.id, {
            ...(storedSession.permissionMode !== undefined ? { permissionMode: storedSession.permissionMode } : {}),
            ...(managed.labels !== undefined ? { labels: managed.labels } : {}),
            ...(storedSession.isFlagged !== undefined ? { isFlagged: storedSession.isFlagged } : {}),
            ...(storedSession.sessionStatus !== undefined ? { sessionStatus: storedSession.sessionStatus } : {}),
            ...(managed.name !== undefined ? { sessionName: managed.name } : {}),
        });
    }
    // Reserved "Task" label: task flows opt in so the tile (and its subtasks, which inherit the
    // parent's number) are filterable as tasks from the moment they exist. Applied before the
    // created-event so the renderer hydrates the label with the rest of the metadata. Fail-soft:
    // a label problem must never abort session creation.
    if (options?.applyTaskLabel) {
        try {
            await sessionOperationContext.owner.applyTaskLabel(storedSession.id, omitUndefined({ parentSessionId: options?.parentSessionId }));
        }
        catch (error) {
            sessionLog.warn('Failed to apply Task label to new session', {
                sessionId: storedSession.id,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    // Announce by default so the renderer hydrates full metadata (name, parentSessionId, …)
    // instead of fabricating a titleless "New Chat" from the first streamed event. Emitted at
    // the very end so a thrown branch-preflight failure above never announces an orphan.
    if (internal?.emitCreatedEvent !== false) {
        sessionOperationContext.owner.notifySessionCreated(workspaceId, storedSession.id);
    }
    return managedToSession(managed, isBranch ? { messages: managed.messages } : undefined);
}

export { sessionOpPerformCreateSession as performCreateSession };
