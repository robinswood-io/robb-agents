import { setOptional } from '@craft-agent/shared/utils/json';
import type { ManagedSession } from '../managed-session.ts';
import type { SessionOperationContext } from '../operation-context.ts';
import { destroyContextualGmailSessionState } from '@craft-agent/shared/agent';
import { loadSession as loadStoredSession, saveSession as saveStoredSession, createSession as createStoredSession, deleteSession as deleteStoredSession, getSessionPath as getSessionStoragePath, assertSessionPersistenceRootIdentity, SessionPersistenceRootIdentityError } from '@craft-agent/shared/sessions';
import type { StoredSession, StoredMessage, SessionPersistenceRootIdentity } from '@craft-agent/shared/sessions';
import { storedToMessage } from '@craft-agent/core/types';
import { normalizePath } from '@craft-agent/shared/utils';
import { reconstructObjectiveForBranch } from '../../objective-contract';
import { rollbackFailedBranchCreation } from '@craft-agent/server-core/domain';
import { sessionLog } from '../runtime-platform.ts';
import { copyPiTurnAnchorsForBranch } from '../turn-anchors.ts';

export type ValidatedSessionBranch = {
        sourceSessionId: string;
        sourceMessageId: string;
        sourceSession: StoredSession;
        branchIdx: number;
        branchContextStrategy: 'sdk-fork' | 'seeded-fresh-session';
        branchFromSdkSessionId?: string;
        branchFromSessionPath?: string;
        branchFromSdkCwd?: string;
        branchFromSdkTurnId?: string;
        sourceProvider?: 'anthropic' | 'pi';
        sourcePersistenceRootPath: string;
        sourcePersistenceRootIdentity: SessionPersistenceRootIdentity;
    } | undefined;

export async function copySessionBranchStorage(validatedBranch: ValidatedSessionBranch, workspaceRootPath: string, storedSession: Awaited<ReturnType<typeof createStoredSession>>): Promise<void> {
    // Branch: copy messages from source session up to and including the branch point
    if (validatedBranch) {
        const branchedStored = loadStoredSession(workspaceRootPath, storedSession.id);
        if (!branchedStored) {
            throw new Error(`Failed to load newly created session ${storedSession.id} for branch copy`);
        }
        const sourceMessages = validatedBranch.sourceSession.messages.slice(0, validatedBranch.branchIdx + 1);
        // Re-map embedded paths: source messages were loaded with expandSessionPath(sourceDir),
        // so they contain absolute paths to the *source* session directory. When saved to the
        // branch session, makeSessionPathPortable uses the *branch* dir — which won't match.
        // Fix: replace source dir paths with branch dir paths so tokenization works on save.
        const verifiedSourceRoot = assertSessionPersistenceRootIdentity(validatedBranch.sourcePersistenceRootIdentity);
        if (verifiedSourceRoot !== validatedBranch.sourcePersistenceRootPath) {
            throw new SessionPersistenceRootIdentityError(`Branch source persistence root changed: ${validatedBranch.sourceSessionId}`);
        }
        const sourceDir = normalizePath(getSessionStoragePath(verifiedSourceRoot, validatedBranch.sourceSessionId));
        const branchDir = normalizePath(getSessionStoragePath(workspaceRootPath, storedSession.id));
        if (sourceDir !== branchDir) {
            branchedStored.messages = sourceMessages.map(m => {
                const json = JSON.stringify(m);
                if (!json.includes(sourceDir))
                    return m;
                return JSON.parse(json.replaceAll(sourceDir, branchDir)) as StoredMessage;
            });
        }
        else {
            branchedStored.messages = sourceMessages;
        }
        delete branchedStored.userInputRequests;
        branchedStored.messages = branchedStored.messages.map(message => message.internalOrigin?.kind === 'user-input'
            ? { ...message, isQueued: false } : message);
        setOptional(branchedStored, "activeObjective", reconstructObjectiveForBranch({
            messages: branchedStored.messages.map(storedToMessage),
            ...(validatedBranch.sourceSession.activeObjective !== undefined ? { sourceObjective: validatedBranch.sourceSession.activeObjective } : {}),
            completeSourceHistory: validatedBranch.branchIdx === validatedBranch.sourceSession.messages.length - 1,
        }));
        // The managed session below is created from this original header object;
        // message hydration separately reloads the saved branch JSONL.
        setOptional(storedSession, "activeObjective", branchedStored.activeObjective);
        branchedStored.branchFromMessageId = validatedBranch.sourceMessageId;
        if (validatedBranch.branchContextStrategy === 'sdk-fork') {
            setOptional(branchedStored, "branchFromSdkSessionId", validatedBranch.branchFromSdkSessionId);
            setOptional(branchedStored, "branchFromSessionPath", validatedBranch.branchFromSessionPath);
            setOptional(branchedStored, "branchFromSdkCwd", validatedBranch.branchFromSdkCwd);
            setOptional(branchedStored, "branchFromSdkTurnId", validatedBranch.branchFromSdkTurnId);
        }
        else {
            delete branchedStored.branchFromSdkSessionId;
            delete branchedStored.branchFromSessionPath;
            delete branchedStored.branchFromSdkCwd;
            delete branchedStored.branchFromSdkTurnId;
        }
        await saveStoredSession(branchedStored);
        // Propagate the Pi turn-anchor sidecar into the branch so a downstream
        // branch can still resolve anchors for messages copied here from the
        // source. Without this step, branch-of-branch silently falls back to
        // full-history fork — see craft-agents-oss#782.
        if (validatedBranch.branchContextStrategy === 'sdk-fork' &&
            validatedBranch.sourceProvider === 'pi') {
            try {
                await copyPiTurnAnchorsForBranch(sourceDir, branchDir, branchedStored.messages.map((m) => m.id), () => {
                    const verifiedRoot = assertSessionPersistenceRootIdentity(validatedBranch.sourcePersistenceRootIdentity);
                    if (verifiedRoot !== validatedBranch.sourcePersistenceRootPath) {
                        throw new SessionPersistenceRootIdentityError(`Branch source persistence root changed: ${validatedBranch.sourceSessionId}`);
                    }
                });
            }
            catch (err) {
                sessionLog.warn('Failed to copy Pi turn-anchors sidecar to branch', {
                    err,
                    sourceSessionId: validatedBranch.sourceSessionId,
                    branchSessionId: storedSession.id,
                });
            }
        }
    }
}

export async function prepareSessionBranchRuntime(managed: ManagedSession, sessionOperationContext: SessionOperationContext, isBranch: boolean, workspaceId: string, storedSession: Awaited<ReturnType<typeof createStoredSession>>, validatedBranch: ValidatedSessionBranch, workspaceRootPath: string): Promise<void> {
    // Eagerly load messages for branched sessions so the renderer gets the full
    // conversation immediately (needed for scroll-to-bottom on panel open)
    if (isBranch) {
        await sessionOperationContext.owner["ensureMessagesLoaded"](managed);
        const requiresBranchPreflight = managed.branchContextStrategy === 'sdk-fork';
        if (requiresBranchPreflight) {
            // Enforce branch correctness at creation time.
            // A branch is only valid if backend context can be established now,
            // not deferred to the first user message.
            try {
                await sessionOperationContext.owner["getOrCreateAgent"](managed);
                await managed.agent!.ensureBranchReady();
            }
            catch (error) {
                sessionLog.warn('Branch creation failed during backend preflight handshake', {
                    workspaceId,
                    sessionId: storedSession.id,
                    branchFromSessionId: validatedBranch?.sourceSessionId,
                    branchFromMessageId: validatedBranch?.sourceMessageId,
                    branchContextStrategy: managed.branchContextStrategy,
                    error: error instanceof Error ? error.message : String(error),
                });
                destroyContextualGmailSessionState(storedSession.id);
                await sessionOperationContext.owner["disposeManagedAgentRuntime"](managed, 'failed branch preflight');
                await rollbackFailedBranchCreation({
                    managed,
                    workspaceRootPath,
                    sessionId: storedSession.id,
                    deleteFromRuntimeSessions: (id) => {
                        const m = sessionOperationContext.state.sessions.get(id);
                        if (m?.autoRetryTimer) {
                            clearTimeout(m.autoRetryTimer);
                            m.autoRetryTimer = undefined;
                        }
                        if (m)
                            m.autoRetryPending = undefined;
                        sessionOperationContext.state.sessions.delete(id);
                    },
                    deleteStoredSession,
                });
                throw new Error(`Could not create branch: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
}


