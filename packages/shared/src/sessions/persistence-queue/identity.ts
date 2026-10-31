import { join } from "path";
import { getSessionPath } from "../storage.js";
import { validateSessionId } from "../validation.js";
import type { SessionPersistenceQueue } from '../persistence-queue.ts';
import { SessionPersistenceRootIdentityError, physicalDirectoryStats, optionalPhysicalDirectoryStats, assertDirectoryIdentityPair, bindSessionContainerIdentity, canonicalWorkspaceRoot, workspaceRootIsCaseInsensitive, rawIdentityAlias, canonicalCaseFoldedIdentityAlias, lexicalCaseFoldedIdentityAlias, existingCanonicalWorkspaceRoot } from './shared.ts';
import type { SessionPersistenceRootIdentity } from './shared.ts';

export function lookupIdentityAlias(transportOwner: SessionPersistenceQueue, workspaceRootPath: string, sessionId: string): string | undefined {
    const exact = transportOwner.identityAliases.get(rawIdentityAlias(workspaceRootPath, sessionId));
    const existingCanonicalRoot = existingCanonicalWorkspaceRoot(workspaceRootPath);
    if (exact) {
        const exactIdentity = transportOwner.identities.get(exact);
        // Missing roots use their last proven lexical alias. Live roots must
        // still resolve to the same target; otherwise this alias was retargeted.
        if (!existingCanonicalRoot || exactIdentity?.workspaceRootPath === existingCanonicalRoot) {
            return exact;
        }
    }
    const canonicalRoot = existingCanonicalRoot ?? canonicalWorkspaceRoot(workspaceRootPath);
    const canonicalAlias = transportOwner.caseInsensitiveCanonicalAliases.get(canonicalCaseFoldedIdentityAlias(canonicalRoot, sessionId));
    if (canonicalAlias)
        return canonicalAlias;
    // A live root with a different canonical path is a different workspace,
    // even if its lexical spelling differs only by case from a known root.
    if (existingCanonicalRoot)
        return undefined;
    const candidates = transportOwner.caseInsensitiveFallbackAliases.get(lexicalCaseFoldedIdentityAlias(workspaceRootPath, sessionId));
    if (!candidates || candidates.size === 0)
        return undefined;
    if (candidates.size === 1)
        return candidates.values().next().value;
    const canonicalMatches = [...candidates].filter(key => (transportOwner.identities.get(key)?.workspaceRootPath === canonicalRoot));
    if (canonicalMatches.length === 1)
        return canonicalMatches[0];
    throw new Error(`Ambiguous case-insensitive workspace persistence identity: ${sessionId}`);
}

export function recordIdentityAliases(transportOwner: SessionPersistenceQueue, workspaceRootPath: string, canonicalRoot: string, sessionId: string, key: string, caseInsensitive: boolean): void {
    transportOwner.identityAliases.set(rawIdentityAlias(workspaceRootPath, sessionId), key);
    transportOwner.identityAliases.set(rawIdentityAlias(canonicalRoot, sessionId), key);
    if (caseInsensitive) {
        transportOwner.caseInsensitiveCanonicalAliases.set(canonicalCaseFoldedIdentityAlias(canonicalRoot, sessionId), key);
        for (const aliasRoot of new Set([workspaceRootPath, canonicalRoot])) {
            const alias = lexicalCaseFoldedIdentityAlias(aliasRoot, sessionId);
            const candidates = transportOwner.caseInsensitiveFallbackAliases.get(alias) ?? new Set<string>();
            candidates.add(key);
            transportOwner.caseInsensitiveFallbackAliases.set(alias, candidates);
        }
    }
}

export function workspaceRootIsCaseInsensitiveOperation(transportOwner: SessionPersistenceQueue, workspaceRootPath: string): boolean {
    return transportOwner["testHooks"]?.caseInsensitiveWorkspaceRoot?.(workspaceRootPath)
        ?? workspaceRootIsCaseInsensitive(workspaceRootPath);
}

export function assertOrBindPersistenceHierarchy(transportOwner: SessionPersistenceQueue, key: string, workspaceRootPath: string, sessionId: string, persistenceRootIdentity: SessionPersistenceRootIdentity | undefined, options: {
    bind: boolean;
    requireSession: boolean;
}): void {
    const registered = transportOwner.identities.get(key);
    if (!registered || registered.workspaceRootPath !== workspaceRootPath) {
        throw new SessionPersistenceRootIdentityError(`Session persistence identity is unavailable: ${sessionId}`);
    }
    const sessionsPath = join(workspaceRootPath, 'sessions');
    const sessions = physicalDirectoryStats(sessionsPath, 'Session persistence directory');
    assertDirectoryIdentityPair(sessionsPath, 'Session persistence directory', sessions, registered.sessionsDevice, registered.sessionsInode, registered.sessionsBirthtimeNs);
    if (options.bind) {
        registered.sessionsDevice ??= sessions.dev.toString();
        registered.sessionsInode ??= sessions.ino.toString();
        registered.sessionsBirthtimeNs ??= sessions.birthtimeNs.toString();
        if (persistenceRootIdentity) {
            bindSessionContainerIdentity(persistenceRootIdentity, workspaceRootPath);
        }
    }
    const sessionPath = getSessionPath(workspaceRootPath, sessionId);
    const session = optionalPhysicalDirectoryStats(sessionPath, `Session directory for ${sessionId}`);
    assertDirectoryIdentityPair(sessionPath, `Session directory for ${sessionId}`, session, registered.sessionDevice, registered.sessionInode, registered.sessionBirthtimeNs);
    if (!session) {
        if (options.requireSession) {
            throw new SessionPersistenceRootIdentityError(`Session directory is unavailable: ${sessionPath}`);
        }
        return;
    }
    if (options.bind) {
        registered.sessionDevice ??= session.dev.toString();
        registered.sessionInode ??= session.ino.toString();
        registered.sessionBirthtimeNs ??= session.birthtimeNs.toString();
    }
}

export function registerIdentity(transportOwner: SessionPersistenceQueue, workspaceRootPath: string, sessionId: string): string {
    validateSessionId(sessionId);
    const registeredAlias = transportOwner.lookupIdentityAlias(workspaceRootPath, sessionId);
    if (registeredAlias)
        return registeredAlias;
    const canonicalRoot = canonicalWorkspaceRoot(workspaceRootPath);
    const caseInsensitive = transportOwner.workspaceRootIsCaseInsensitive(canonicalRoot);
    const normalizedSessionId = caseInsensitive ? sessionId.toLowerCase() : sessionId;
    const key = JSON.stringify([canonicalRoot, normalizedSessionId]);
    transportOwner.identities.set(key, {
        workspaceRootPath: canonicalRoot,
        sessionId,
        normalizedSessionId,
        caseInsensitive,
    });
    transportOwner.recordIdentityAliases(workspaceRootPath, canonicalRoot, sessionId, key, caseInsensitive);
    return key;
}

export function resolveIdentityKey(transportOwner: SessionPersistenceQueue, sessionId: string, workspaceRootPath?: string): string | undefined {
    if (workspaceRootPath !== undefined) {
        const registeredAlias = transportOwner.lookupIdentityAlias(workspaceRootPath, sessionId);
        if (registeredAlias)
            return registeredAlias;
        const canonicalRoot = canonicalWorkspaceRoot(workspaceRootPath);
        const caseInsensitive = transportOwner.workspaceRootIsCaseInsensitive(canonicalRoot);
        return JSON.stringify([
            canonicalRoot,
            caseInsensitive ? sessionId.toLowerCase() : sessionId,
        ]);
    }
    const matches = [...transportOwner.identities.entries()]
        .filter(([, identity]) => identity.normalizedSessionId
        === (identity.caseInsensitive ? sessionId.toLowerCase() : sessionId))
        .map(([key]) => key);
    if (matches.length > 1) {
        throw new Error(`Ambiguous session persistence identity; workspace root is required: ${sessionId}`);
    }
    return matches[0];
}
