export interface SessionPersistenceIdentity {
    sessionId: string;
    normalizedSessionId: string;
    workspaceRootPath: string;
    caseInsensitive: boolean;
    sessionsDevice?: string;
    sessionsInode?: string;
    sessionsBirthtimeNs?: string;
    sessionDevice?: string;
    sessionInode?: string;
    sessionBirthtimeNs?: string;
}

export interface SessionPersistenceRootIdentity {
    workspaceRootPath: string;
    device?: string;
    inode?: string;
    /** Creation time distinguishes a replacement that reuses the same inode. */
    birthtimeNs?: string;
    /** Physical `sessions/` object, bound as soon as it exists. */
    sessionsDevice?: string;
    sessionsInode?: string;
    sessionsBirthtimeNs?: string;
}
