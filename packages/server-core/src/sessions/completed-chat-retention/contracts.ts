
export const COMPLETED_CHAT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export class CompletedChatArchiveError extends Error {
  constructor(
    message: string,
    readonly committed: boolean,
    readonly archivePath: string | undefined,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'CompletedChatArchiveError'
  }
}

export interface CompletedChatMemory {
  version: 1
  sessionId: string
  projectId?: string
  title: string
  completedAt: number
  lastActivityAt: number
  transcriptSha256: string
  summary: string
  reopenedAt?: number
  deletedAt?: number
  archivedAt?: number
  archivePath?: string
  /** Durable write-ahead record for the one atomic archive rename. The exact
   * destination is sealed before the live directory can move. */
  archiveIntent?: CompletedChatArchiveIntent
  /** Version 2 memories are derived exclusively from direct, visible user turns. */
  retrievalVersion?: 2
  /** Bounded text eligible for cross-chat retrieval. Never contains assistant or internal turns. */
  directUserExcerpt?: string
}

export interface CompletedChatArchiveIntent {
  version: 1
  targetPath: string
  archivedAt: number
  sourceDevice: string
  sourceInode: string
}

export interface CompletedChatArchiveReconciliation {
  finalized: Array<{ sessionId: string; archivePath: string }>
  pending: string[]
  errors: Array<{ receipt: string; error: string }>
}
