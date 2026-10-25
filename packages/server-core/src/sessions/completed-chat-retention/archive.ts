import { existsSync, readFileSync, readdirSync, renameSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Message } from "@craft-agent/core/types";
import { redactSecretLikeMaterial } from "@craft-agent/shared/utils";
import { buildDirectUserExcerpt, isDirectVisibleUserMessage } from './context-retrieval.ts';
import type { CompletedChatArchiveIntent, CompletedChatArchiveReconciliation, CompletedChatMemory } from './contracts.ts';
import { COMPLETED_CHAT_RETENTION_MS, CompletedChatArchiveError } from './contracts.ts';
import { readCompletedChatMemory, validatedMemory, writeCompletedChatMemory } from './memory.ts';
import { MAX_MEMORY_RECEIPT_BYTES, assertRealArchiveDirectories, directory, ensureArchiveDirectories, expectedArchiveTargetPrefix, filename, fsyncDirectories, validatedArchiveTarget, validatedSessionPath } from './paths.ts';

function withoutArchiveIntent(memory: CompletedChatMemory): CompletedChatMemory {
  const { archiveIntent: _archiveIntent, ...rest } = memory
  return rest
}

/** Persist the exact destination before the live directory may move. Reusing an
 * existing intent makes every retry target the same inode location. */
export function prepareCompletedChatArchive(
  root: string,
  memory: CompletedChatMemory,
  archivedAt: number,
): CompletedChatMemory {
  validatedMemory(memory, memory.sessionId, root)
  if (memory.archivedAt !== undefined) return memory
  if (memory.archiveIntent) return memory
  const sourcePath = validatedSessionPath(root, memory.sessionId)
  const source = lstatSync(sourcePath)
  if (!source.isDirectory() || source.isSymbolicLink()) {
    throw new Error('Completed chat must be a real directory before archival is planned')
  }
  const destination = ensureArchiveDirectories(root)
  const targetPath = join(destination, `${expectedArchiveTargetPrefix(memory.sessionId)}${randomUUID()}`)
  validatedArchiveTarget(root, memory.sessionId, targetPath)
  const planned: CompletedChatMemory = {
    ...memory,
    archiveIntent: {
      version: 1,
      targetPath,
      archivedAt,
      sourceDevice: String(source.dev),
      sourceInode: String(source.ino),
    },
  }
  writeCompletedChatMemory(root, planned)
  return planned
}

/** Cancel only an uncommitted, exact intent. A present target is never hidden
 * by rewriting its receipt back to an ordinary live-memory record. */
export function abandonCompletedChatArchive(
  root: string,
  id: string,
  targetPath: string,
): boolean {
  const memory = readCompletedChatMemory(root, id)
  if (memory?.archiveIntent?.targetPath !== targetPath) return false
  const sourcePath = validatedSessionPath(root, id)
  if (!existsSync(sourcePath) || existsSync(targetPath)) return false
  writeCompletedChatMemory(root, withoutArchiveIntent(memory))
  return true
}

/** Publish the final receipt only when the exact planned inode is present at
 * the exact planned target and the live source is absent. */
export function finalizeCompletedChatArchive(
  root: string,
  id: string,
  targetPath: string,
): CompletedChatMemory {
  const memory = readCompletedChatMemory(root, id)
  const intent = memory?.archiveIntent
  if (!memory || !intent || intent.targetPath !== targetPath) {
    throw new Error('Completed-chat archive intent changed before finalization')
  }
  const sourcePath = validatedSessionPath(root, id)
  if (existsSync(sourcePath)) throw new Error('Completed-chat live source still exists')
  if (!existsSync(targetPath)) throw new Error('Completed-chat archive target is missing')
  assertRealArchiveDirectories(root)
  const target = lstatSync(targetPath)
  if (!target.isDirectory() || target.isSymbolicLink()) {
    throw new Error('Completed-chat archive target must be a real directory')
  }
  if (String(target.dev) !== intent.sourceDevice || String(target.ino) !== intent.sourceInode) {
    throw new Error('Completed-chat archive target identity does not match its durable intent')
  }
  const finalized: CompletedChatMemory = {
    ...withoutArchiveIntent(memory),
    archivedAt: intent.archivedAt,
    archivePath: intent.targetPath,
  }
  writeCompletedChatMemory(root, finalized)
  return finalized
}

function readCompletedChatReceiptPath(root: string, path: string): CompletedChatMemory {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Completed-chat memory must be a regular file')
  if (stat.size > MAX_MEMORY_RECEIPT_BYTES) throw new Error('Completed-chat memory receipt is too large')
  const value = JSON.parse(readFileSync(path, 'utf8')) as CompletedChatMemory
  const memory = validatedMemory(value, value.sessionId, root)
  if (filename(root, memory.sessionId) !== path) throw new Error('Completed-chat memory receipt identity mismatch')
  return memory
}

/** Repair the write-ahead transaction independently of the live session map.
 * A committed target is enough to publish the final receipt after restart;
 * an untouched source remains pending for the ordinary guarded sweep. */
export function reconcileCompletedChatArchives(root: string): CompletedChatArchiveReconciliation {
  const result: CompletedChatArchiveReconciliation = { finalized: [], pending: [], errors: [] }
  const receipts = directory(root)
  if (!existsSync(receipts)) return result
  if (!lstatSync(receipts).isDirectory() || lstatSync(receipts).isSymbolicLink()) {
    result.errors.push({ receipt: receipts, error: 'Completed-chat memory directory must be a real directory' })
    return result
  }
  for (const entry of readdirSync(receipts, { withFileTypes: true })) {
    if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue
    const path = join(receipts, entry.name)
    try {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Completed-chat memory must be a regular file')
      const memory = readCompletedChatReceiptPath(root, path)
      const intent = memory.archiveIntent
      if (!intent) continue
      const sourcePath = validatedSessionPath(root, memory.sessionId)
      const sourceExists = existsSync(sourcePath)
      const targetExists = existsSync(intent.targetPath)
      if (sourceExists && (!lstatSync(sourcePath).isDirectory() || lstatSync(sourcePath).isSymbolicLink())) {
        throw new Error('Completed-chat source must be a real directory')
      }
      if (targetExists && (!lstatSync(intent.targetPath).isDirectory() || lstatSync(intent.targetPath).isSymbolicLink())) {
        throw new Error('Completed-chat archive target must be a real directory')
      }
      if (targetExists && !sourceExists) {
        finalizeCompletedChatArchive(root, memory.sessionId, intent.targetPath)
        result.finalized.push({ sessionId: memory.sessionId, archivePath: intent.targetPath })
      } else if (sourceExists && !targetExists) {
        result.pending.push(memory.sessionId)
      } else if (sourceExists) {
        throw new Error('Completed-chat archive has both live source and committed target')
      } else {
        throw new Error('Completed-chat archive intent has neither live source nor committed target')
      }
    } catch (error) {
      result.errors.push({ receipt: entry.name, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

/** Extracts attributed historical context locally, without starting an idle agent. */
export function captureCompletedChatMemory(root: string, input: {
  id: string; name?: string; projectId?: string; lastMessageAt: number; messages: Message[]
}, now = Date.now()): CompletedChatMemory {
  const previous = readCompletedChatMemory(root, input.id)
  const directMessages = input.messages.filter(isDirectVisibleUserMessage)
  const digest = createHash('sha256')
  for (const message of directMessages) digest.update(JSON.stringify({
    id: message.id, content: message.content, timestamp: message.timestamp,
  })).update('\n')
  const transcriptSha256 = digest.digest('hex')
  if (previous && !previous.reopenedAt && !previous.deletedAt && !previous.archivedAt
    && previous.retrievalVersion === 2 && previous.transcriptSha256 === transcriptSha256
    && previous.projectId === input.projectId) return previous
  const directUserExcerpt = buildDirectUserExcerpt(directMessages)
  const memory: CompletedChatMemory = {
    version: 1, sessionId: input.id, projectId: input.projectId,
    title: redactSecretLikeMaterial(input.name ?? 'Conversation terminée').slice(0, 300),
    completedAt: now, lastActivityAt: input.lastMessageAt, transcriptSha256,
    retrievalVersion: 2,
    directUserExcerpt,
    summary: directUserExcerpt || 'Conversation terminée sans message utilisateur direct à conserver.',
  }
  writeCompletedChatMemory(root, memory)
  return memory
}

export function reopenCompletedChat(root: string, id: string, now = Date.now()): void {
  const memory = readCompletedChatMemory(root, id)
  if (memory && !memory.reopenedAt && !memory.deletedAt && !memory.archivedAt) {
    writeCompletedChatMemory(root, { ...withoutArchiveIntent(memory), reopenedAt: now })
  }
}

export function isCompletedChatDue(memory: CompletedChatMemory, now: number): boolean {
  return !memory.reopenedAt && !memory.deletedAt && !memory.archivedAt && now - memory.completedAt >= COMPLETED_CHAT_RETENTION_MS
}

/** Move the entire chat, including deliverables, to a non-expiring local archive. */
export function archiveCompletedChatDirectory(
  root: string,
  sessionPath: string,
  id: string,
  plannedTarget?: string,
  expectedSourceIdentity?: Pick<CompletedChatArchiveIntent, 'sourceDevice' | 'sourceInode'>,
  durabilityBarrier: (paths: string[]) => void = fsyncDirectories,
): string {
  const destination = ensureArchiveDirectories(root)
  if (plannedTarget && !expectedSourceIdentity) {
    throw new Error('Completed-chat planned archive requires its sealed source identity')
  }
  const target = plannedTarget
    ? validatedArchiveTarget(root, id, plannedTarget)
    : join(destination, `${expectedArchiveTargetPrefix(id)}${randomUUID()}`)
  if (existsSync(target)) {
    const archived = lstatSync(target)
    if (!archived.isDirectory() || archived.isSymbolicLink()) {
      throw new Error('Completed-chat archive target must be a real directory')
    }
    if (existsSync(sessionPath)) throw new Error('Completed-chat archive target conflicts with a live source')
    if (expectedSourceIdentity
      && (String(archived.dev) !== expectedSourceIdentity.sourceDevice
        || String(archived.ino) !== expectedSourceIdentity.sourceInode)) {
      throw new Error('Completed-chat archive target identity does not match its durable intent')
    }
    durabilityBarrier([dirname(sessionPath), destination])
    return target
  }
  const source = lstatSync(sessionPath)
  if (!source.isDirectory() || source.isSymbolicLink()) throw new Error('Completed chat must be a real directory')
  if (expectedSourceIdentity
    && (String(source.dev) !== expectedSourceIdentity.sourceDevice
      || String(source.ino) !== expectedSourceIdentity.sourceInode)) {
    throw new Error('Completed-chat source identity does not match its durable intent')
  }
  let moved = false
  try {
    renameSync(sessionPath, target)
    moved = true
    const archived = lstatSync(target)
    if (archived.ino !== source.ino || archived.dev !== source.dev || existsSync(sessionPath)) {
      throw new Error('Completed-chat archive move could not be verified')
    }
    durabilityBarrier([dirname(sessionPath), destination])
    return target
  } catch (error) {
    if (!moved) throw error
    const sourceExists = existsSync(sessionPath)
    if (!sourceExists) {
      try {
        renameSync(target, sessionPath)
        // The inverse rename needs the same two-parent durability barrier as
        // the forward commit. Without it, a crash may replay the archive move
        // even though the process reported a successful rollback.
        durabilityBarrier([dirname(sessionPath), destination])
        const restored = lstatSync(sessionPath)
        if (restored.ino !== source.ino || restored.dev !== source.dev || existsSync(target)) {
          throw new Error('Completed-chat archive rollback could not be verified')
        }
        throw new CompletedChatArchiveError(
          error instanceof Error ? error.message : String(error),
          false,
          undefined,
          { cause: error },
        )
      } catch (rollbackError) {
        if (rollbackError instanceof CompletedChatArchiveError) throw rollbackError
        const targetStillExists = existsSync(target)
        throw new CompletedChatArchiveError(
          `${targetStillExists ? 'Completed-chat archive committed but rollback failed' : 'Completed-chat archive source was restored but rollback durability failed'}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          targetStillExists,
          targetStillExists ? target : undefined,
          { cause: new AggregateError([error, rollbackError]) },
        )
      }
    }
    // The source reappeared while the moved inode still exists at the target.
    // Restoring an in-memory snapshot over that new source would create a
    // second, incomplete transcript, so expose the committed state explicitly.
    const committed = existsSync(target)
    throw new CompletedChatArchiveError(
      error instanceof Error ? error.message : String(error),
      committed,
      committed ? target : undefined,
      { cause: error },
    )
  }
}

/** Chat cleanup must not destroy repositories/worktrees created inside its data folder. */
export function hasProtectedChatWorktree(sessionPath: string): boolean {
  if (!existsSync(sessionPath)) return false
  const pending = [sessionPath]
  let visited = 0
  while (pending.length) {
    if (++visited > 10_000) throw new Error('Session directory too large to verify safe retention')
    for (const entry of readdirSync(pending.pop()!, { withFileTypes: true })) {
      if (entry.name === '.git') return true
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(join(entry.parentPath, entry.name))
    }
  }
  return false
}
