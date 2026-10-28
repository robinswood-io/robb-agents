import type { SessionEvent } from '../../../../../shared/src/protocol/dto/session-events.ts';
import { omitUndefined } from '@craft-agent/shared/utils/json';
import type { SessionOperationContext } from '../operation-context.ts';
import type { PermissionMode } from '@craft-agent/shared/agent';
import { getDefaultLlmConnection } from '@craft-agent/shared/config';
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import { evaluateAutoLabels } from '@craft-agent/shared/labels/auto';
import { listLabels, loadLabelConfig } from '@craft-agent/shared/labels/storage';
import { extractLabelId, findTaskItemLabelId, findLabelById, formatLabelEntry } from '@craft-agent/shared/labels';
import { ensureTaskItemLabel } from '@craft-agent/shared/labels/crud';
import type { ManagedSession } from '../managed-session.ts';
import { hasImmutableMissionRoute } from '../mission-route.ts';
import { sessionLog } from '../runtime-platform.ts';
import { resolveCreateSessionRouteProvenance, sanitizeParentSessionLabels } from '../session-creation.ts';
import { resolveSupportsBranching } from '../source-selection.ts';
import { trackSessionOperation as sessionOpTrackSessionOperation, assertSessionOperationOwner as sessionOpAssertSessionOperationOwner, ownsSessionOperation as sessionOpOwnsSessionOperation } from './track-session-operation.ts';
import { performBindExistingSessionToTask as sessionOpPerformBindExistingSessionToTask } from './perform-bind-existing-session-to-task.ts';

/**
 * Evaluate auto-label rules against arbitrary text (message or generated title)
 * and merge any matched topic labels into the session.
 */
function sessionOpEvaluateAndApplyAutoLabels(sessionOperationContext: SessionOperationContext, managed: ManagedSession, text: string): void {
    try {
        const labelTree = listLabels(managed.workspace.rootPath);
        if (!labelTree || labelTree.length === 0)
            return;
        const autoMatches = evaluateAutoLabels(text, labelTree);
        if (autoMatches.length === 0)
            return;
        const existingLabels = managed.labels ?? [];
        const newEntries = autoMatches
            .map(m => {
            const config = findLabelById(labelTree, m.labelId);
            return formatLabelEntry(m.labelId, config?.valueType ? m.value : undefined);
        })
            .filter(entry => {
            const id = extractLabelId(entry);
            return !existingLabels.some(existing => extractLabelId(existing) === id);
        });
        if (newEntries.length > 0) {
            const nextLabels = sanitizeParentSessionLabels(managed.id, managed.parentSessionId, [...existingLabels, ...newEntries]) ?? [];
            if (JSON.stringify(nextLabels) !== JSON.stringify(existingLabels)) {
                managed.labels = nextLabels;
                sessionOperationContext.owner["persistSession"](managed);
                sessionOperationContext.owner["sendEvent"]({
                    type: 'labels_changed',
                    sessionId: managed.id,
                    labels: managed.labels,
                }, managed.workspace.id);
            }
        }
    }
    catch (e) {
        sessionLog.warn(`Auto-label evaluation failed for session ${managed.id}:`, e);
    }
}

/**
 * Set labels for a session (additive tags, many-per-session).
 * Labels are IDs referencing workspace labels/config.json.
 */
async function sessionOpSetSessionLabels(sessionOperationContext: SessionOperationContext, sessionId: string, labels: string[]): Promise<void> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (managed)
        return sessionOpTrackSessionOperation(sessionOperationContext, managed, async () => {
            sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
            managed.labels = sanitizeParentSessionLabels(managed.id, managed.parentSessionId, labels) ?? [];
            sessionOperationContext.owner["setMetadataWriteGuard"](managed);
            sessionOperationContext.owner["sendEvent"]({
                type: 'labels_changed',
                sessionId: managed.id,
                labels: managed.labels,
            }, managed.workspace.id);
            // Persist in-memory state directly to avoid race with pending queue writes
            sessionOperationContext.owner["persistSession"](managed);
            await sessionOperationContext.owner.flushSession(managed.id);
            // Workaround: Bun's fs.watch({ recursive: true }) on Linux doesn't track
            // directories created after the watcher started.
            // https://github.com/oven-sh/bun/issues/15939
            const watcher = sessionOperationContext.state.configWatchers.get(managed.workspace.rootPath);
            watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`);
        });
}

/**
 * Apply the reserved Task labeling to a session. Every task gets its own ITEM label —
 * a child of the root "Task" label named `TASK-<slug>-<N>` (plain boolean, no value) —
 * and the task's whole family carries that same item label, so one label filters one
 * task. Top-level sessions mint a fresh item label from their name; a session with
 * `parentSessionId` inherits the parent's item label — and a parent that lacks one (a
 * plain chat gaining its first subtask) is labeled in the same pass, so "becoming a
 * task" holds by construction. Idempotent: a session already carrying an item label
 * keeps it. Returns the resolved ITEM label id — slugs can collide-shift, so callers
 * MUST use it rather than deriving ids themselves.
 */
async function sessionOpApplyTaskLabel(sessionOperationContext: SessionOperationContext, sessionId: string, opts?: {
    parentSessionId?: string;
}): Promise<{
    labelId: string;
} | undefined> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed)
        return undefined;
    return sessionOpTrackSessionOperation(sessionOperationContext, managed, async () => {
        sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
        const rootPath = managed.workspace.rootPath;
        const itemOf = (labels: string[] | undefined): string | undefined => findTaskItemLabelId(labels, loadLabelConfig(rootPath).labels);
        const withItemEntry = (labels: string[] | undefined, itemId: string): string[] => [
            ...(labels ?? []).filter(entry => extractLabelId(entry) !== itemId),
            itemId,
        ];
        const existing = itemOf(managed.labels);
        if (existing)
            return { labelId: existing };
        let itemId: string;
        const parent = opts?.parentSessionId ? sessionOperationContext.state.sessions.get(opts.parentSessionId) : undefined;
        if (parent) {
            const parentItem = itemOf(parent.labels);
            if (parentItem) {
                itemId = parentItem;
            }
            else {
                itemId = ensureTaskItemLabel(rootPath, parent.name || 'task').itemId;
                await sessionOperationContext.owner.setSessionLabels(parent.id, withItemEntry(parent.labels, itemId));
                sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
            }
        }
        else {
            itemId = ensureTaskItemLabel(rootPath, managed.name || 'task').itemId;
        }
        await sessionOperationContext.owner.setSessionLabels(sessionId, withItemEntry(managed.labels, itemId));
        sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
        return { labelId: itemId };
    });
}

/**
 * Bind or unbind a session to/from a workspace project.
 * Pass `null` to unbind. The session's working directory is NOT changed retroactively —
 * the project binding is only used as a default for newly created sessions.
 */
async function sessionOpSetSessionProjectId(sessionOperationContext: SessionOperationContext, sessionId: string, projectId: string | null): Promise<void> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (managed)
        return sessionOpTrackSessionOperation(sessionOperationContext, managed, async () => {
            sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
            managed.projectId = projectId ?? undefined;
            sessionOperationContext.owner["setMetadataWriteGuard"](managed);
            sessionOperationContext.owner["sendEvent"]({
                type: 'project_id_changed',
                sessionId: managed.id,
                projectId: managed.projectId ?? null,
            }, managed.workspace.id);
            sessionOperationContext.owner["persistSession"](managed);
            await sessionOperationContext.owner.flushSession(managed.id);
            const watcher = sessionOperationContext.state.configWatchers.get(managed.workspace.rootPath);
            watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`);
        });
}

/**
 * Set the kanban board column for a session ('todo' | 'in-progress' | 'done').
 * Pass `null` to clear (board falls back to the default column). Independent of sessionStatus.
 */
async function sessionOpSetKanbanColumn(sessionOperationContext: SessionOperationContext, sessionId: string, column: string | null): Promise<void> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (managed)
        return sessionOpTrackSessionOperation(sessionOperationContext, managed, async () => {
            sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
            managed.kanbanColumn = column ?? undefined;
            sessionOperationContext.owner["setMetadataWriteGuard"](managed);
            sessionOperationContext.owner["persistSession"](managed);
            await sessionOperationContext.owner.flushSession(managed.id);
            // Self-writes don't re-emit through the file watcher (kanbanColumn isn't in the header
            // signature), so push a live metadata event for the board to consume.
            sessionOperationContext.owner["sendEvent"]({ type: 'session_metadata_changed', sessionId, changes: { kanbanColumn: column } }, managed.workspace.id);
            const watcher = sessionOperationContext.state.configWatchers.get(managed.workspace.rootPath);
            watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`);
        });
}

/**
 * Record the total DAG node count on a Conductor orchestrator session. The board uses this as a
 * stable progress denominator so it doesn't grow as child sessions are spawned lazily at dispatch.
 */
async function sessionOpSetTaskNodeCount(sessionOperationContext: SessionOperationContext, sessionId: string, count: number): Promise<void> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (managed)
        return sessionOpTrackSessionOperation(sessionOperationContext, managed, async () => {
            sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
            managed.taskNodeCount = count;
            sessionOperationContext.owner["setMetadataWriteGuard"](managed);
            sessionOperationContext.owner["persistSession"](managed);
            await sessionOperationContext.owner.flushSession(managed.id);
            // Self-writes don't re-emit through the file watcher (taskNodeCount isn't in the header
            // signature), so push a live metadata event so the progress denominator updates immediately.
            sessionOperationContext.owner["sendEvent"]({ type: 'session_metadata_changed', sessionId, changes: { taskNodeCount: count } }, managed.workspace.id);
            const watcher = sessionOperationContext.state.configWatchers.get(managed.workspace.rootPath);
            watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`);
        });
}

/**
 * Promote a hidden generate-time orchestrator (`taskDraft`) into the real, board-visible
 * orchestrator for `taskSlug`. This is the single narrow path that lets "Generate → Create & Run"
 * reuse the draft session instead of minting a second top-level tile (#bug1).
 *
 * Returns `true` on success (including an idempotent re-adopt of the same slug). Returns `false`
 * — leaving the session untouched — when the session is missing, isn't a draft, or is already
 * bound to a *different* slug. Callers fall back to `createSession` on `false`.
 *
 * Deliberately does NOT touch tools/sources/capabilities: the orchestrator keeps everything it
 * was created with so it can still author/verify the run.
 */
async function sessionOpAdoptGeneratedTaskOrchestrator(sessionOperationContext: SessionOperationContext, sessionId: string, taskSlug: string, reconcile?: {
    name?: string;
    projectId?: string | undefined;
    workingDirectory?: string;
    model?: string;
    llmConnection?: string;
    permissionMode?: PermissionMode;
}): Promise<boolean> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed) {
        sessionLog.warn('adoptGeneratedTaskOrchestrator: session not found', { sessionId, taskSlug });
        return false;
    }
    return sessionOpTrackSessionOperation(sessionOperationContext, managed, () => sessionOpPerformAdoptGeneratedTaskOrchestrator(sessionOperationContext, managed, taskSlug, reconcile));
}

async function sessionOpPerformAdoptGeneratedTaskOrchestrator(sessionOperationContext: SessionOperationContext, managed: ManagedSession, taskSlug: string, reconcile?: {
    name?: string;
    projectId?: string | undefined;
    workingDirectory?: string;
    model?: string;
    llmConnection?: string;
    permissionMode?: PermissionMode;
}): Promise<boolean> {
    const sessionId = managed.id;
    if (!sessionOpOwnsSessionOperation(sessionOperationContext, managed))
        return false;
    if (hasImmutableMissionRoute(managed)) {
        sessionLog.warn('adoptGeneratedTaskOrchestrator: Mission session is immutable', {
            sessionId, taskSlug,
        });
        return false;
    }
    // Idempotency: already bound to this slug → no-op success. Bound to a different slug → refuse,
    // so a stale draft ref can't hijack an unrelated orchestrator.
    if (managed.taskSlug) {
        if (managed.taskSlug === taskSlug)
            return true;
        sessionLog.warn('adoptGeneratedTaskOrchestrator: slug mismatch, refusing to rebind', {
            sessionId, existing: managed.taskSlug, requested: taskSlug,
        });
        return false;
    }
    // Only hidden generate-time drafts are eligible. A non-draft session without a slug isn't a
    // generate orchestrator and must not be silently captured.
    if (!managed.taskDraft) {
        sessionLog.warn('adoptGeneratedTaskOrchestrator: session is not a task draft', { sessionId, taskSlug });
        return false;
    }
    const requestedRoute = reconcile?.model !== undefined || reconcile?.llmConnection !== undefined
        ? resolveCreateSessionRouteProvenance({
            model: reconcile.model,
            modelRoutePinned: reconcile.model !== undefined,
            llmConnection: reconcile.llmConnection
                ?? (reconcile.model !== undefined ? managed.llmConnection : undefined),
            connectionRoutePinned: reconcile.llmConnection !== undefined ? true : undefined,
        }, managed.llmConnection
            ?? loadWorkspaceConfig(managed.workspace.rootPath)?.defaults?.defaultLlmConnection
            ?? getDefaultLlmConnection()
            ?? undefined)
        : undefined;
    if (requestedRoute?.llmConnection && managed.connectionLocked
        && requestedRoute.llmConnection !== managed.llmConnection) {
        sessionLog.warn('adoptGeneratedTaskOrchestrator: locked connection cannot be reconciled', {
            sessionId, current: managed.llmConnection, requested: requestedRoute.llmConnection,
        });
        return false;
    }
    // What actually changes — so we fire canonical live-updates (agent + caches + per-field events)
    // only when needed. With generate now seeding model/connection/mode, these are usually all false.
    const modelChanged = Boolean(reconcile?.model && reconcile.model !== managed.model);
    const connectionChanged = Boolean(requestedRoute?.llmConnection
        && requestedRoute.llmConnection !== managed.llmConnection);
    const cwdChanged = Boolean(reconcile?.workingDirectory && reconcile.workingDirectory !== managed.workingDirectory);
    const modeChanged = Boolean(reconcile?.permissionMode && reconcile.permissionMode !== managed.permissionMode);
    // Promote task metadata (no canonical mutator for these). Connection is set directly because
    // setSessionConnection() refuses a session that has already sent messages (a generate draft has);
    // the connection_changed event below keeps the renderer in sync.
    managed.taskSlug = taskSlug;
    managed.taskDraft = false;
    if (reconcile?.projectId !== undefined)
        managed.projectId = reconcile.projectId;
    if (connectionChanged)
        managed.llmConnection = requestedRoute!.llmConnection;
    if (requestedRoute) {
        managed.connectionRoutePinned = requestedRoute.connectionRoutePinned;
        managed.modelRoutePinned = requestedRoute.modelRoutePinned;
    }
    const renamed = Boolean(reconcile?.name && reconcile.name !== managed.name);
    if (renamed)
        managed.name = reconcile!.name!;
    // Route model / cwd / permission mode through the canonical mutators so the LIVE agent, caches,
    // and per-field events stay consistent — not just the on-disk metadata (the split-brain the
    // follow-up review flagged). Synchronous updates run before the first await;
    // the model helper is invoked inside this already-owned lease.
    if (cwdChanged)
        sessionOperationContext.owner.updateWorkingDirectory(sessionId, reconcile!.workingDirectory!);
    if (modeChanged)
        sessionOperationContext.owner.setSessionPermissionMode(sessionId, reconcile!.permissionMode!);
    if (modelChanged)
        await sessionOperationContext.owner["performUpdateSessionModel"](managed, reconcile!.model!);
    sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
    sessionOperationContext.owner["setMetadataWriteGuard"](managed);
    sessionOperationContext.owner["persistSession"](managed);
    await sessionOperationContext.owner.flushSession(managed.id);
    sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
    // One-shot board promotion: clearing taskDraft (sent as `false`, never `undefined` — undefined
    // is dropped over the JSON wire) reveals the already-announced tile; taskSlug/projectId
    // reconcile its metadata. `false` is falsy for the board's `if (meta.taskDraft)` skip.
    const changes: {
        taskDraft: boolean;
        taskSlug: string;
        projectId?: string;
    } = { taskDraft: false, taskSlug };
    if (reconcile?.projectId !== undefined)
        changes.projectId = reconcile.projectId;
    sessionOperationContext.owner["sendEvent"]({ type: 'session_metadata_changed', sessionId, changes }, managed.workspace.id);
    if (renamed) {
        sessionOperationContext.owner["sendEvent"](omitUndefined<Extract<SessionEvent, { type: 'name_changed' }>>({ type: 'name_changed', sessionId, name: managed.name }), managed.workspace.id);
    }
    if (connectionChanged) {
        sessionOperationContext.owner["sendEvent"]({
            type: 'connection_changed',
            sessionId,
            connectionSlug: managed.llmConnection!,
            supportsBranching: resolveSupportsBranching(managed),
        }, managed.workspace.id);
    }
    const watcher = sessionOperationContext.state.configWatchers.get(managed.workspace.rootPath);
    watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`);
    sessionLog.info('adoptGeneratedTaskOrchestrator: promoted draft', { sessionId, taskSlug, renamed, modelChanged, connectionChanged, cwdChanged, modeChanged });
    return true;
}

/**
 * User-initiated bind of an *existing, visible* session (e.g. a quick-add tile) to a task slug.
 *
 * This is distinct from {@link adoptGeneratedTaskOrchestrator}, which is the narrow draft-only
 * promotion path. A quick-add tile is a normal non-draft session with no `taskSlug`; the draft
 * guard there correctly refuses it, so the editor's "save this spec onto this tile" flow needs
 * its own path. The guard in the adopt method stays untouched.
 *
 * Returns `true` on success (including an idempotent re-bind of the same slug). Returns `false`
 * — leaving the session untouched — when the session is missing or already bound to a *different*
 * slug. Callers MUST treat `false` as a hard error and must NOT fall back to creating a fresh
 * orchestrator (that would mint a duplicate tile).
 *
 * Unlike adopt, this reconciles `llmConnection` too (a fresh create sets it; adopt skips it) so
 * the bound tile doesn't render a stale backend.
 */
async function sessionOpBindExistingSessionToTask(sessionOperationContext: SessionOperationContext, sessionId: string, taskSlug: string, reconcile?: {
    name?: string;
    projectId?: string | undefined;
    workingDirectory?: string;
    model?: string;
    llmConnection?: string;
    permissionMode?: PermissionMode;
}): Promise<boolean> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed) {
        sessionLog.warn('bindExistingSessionToTask: session not found', { sessionId, taskSlug });
        return false;
    }
    return sessionOpTrackSessionOperation(sessionOperationContext, managed, () => sessionOpPerformBindExistingSessionToTask(sessionOperationContext, managed, taskSlug, reconcile));
}

export { sessionOpEvaluateAndApplyAutoLabels as evaluateAndApplyAutoLabels };
export { sessionOpSetSessionLabels as setSessionLabels };
export { sessionOpApplyTaskLabel as applyTaskLabel };
export { sessionOpSetSessionProjectId as setSessionProjectId };
export { sessionOpSetKanbanColumn as setKanbanColumn };
export { sessionOpSetTaskNodeCount as setTaskNodeCount };
export { sessionOpAdoptGeneratedTaskOrchestrator as adoptGeneratedTaskOrchestrator };
export { sessionOpPerformAdoptGeneratedTaskOrchestrator as performAdoptGeneratedTaskOrchestrator };
export { sessionOpBindExistingSessionToTask as bindExistingSessionToTask };
