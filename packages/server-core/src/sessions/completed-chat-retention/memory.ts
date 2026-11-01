import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync, lstatSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { CompletedChatMemory } from './contracts.ts';
import { MAX_DIRECT_USER_MEMORY_CHARS, MAX_MEMORY_RECEIPT_BYTES, directory, filename, validatedArchiveTarget, validatedSessionPath } from './paths.ts';

export function validatedMemory(value: CompletedChatMemory, id: string, root: string): CompletedChatMemory {
  if (value.version !== 1 || value.sessionId !== id || !Number.isFinite(value.completedAt)
    || !Number.isFinite(value.lastActivityAt) || !value.summary?.trim()
    || !/^[a-f0-9]{64}$/.test(value.transcriptSha256)
    || (value.retrievalVersion !== undefined && value.retrievalVersion !== 2)
    || (value.directUserExcerpt !== undefined && (typeof value.directUserExcerpt !== 'string'
      || value.directUserExcerpt.length > MAX_DIRECT_USER_MEMORY_CHARS))
    || (value.reopenedAt !== undefined && !Number.isFinite(value.reopenedAt))
    || (value.deletedAt !== undefined && !Number.isFinite(value.deletedAt))
    || (value.archivedAt !== undefined && !Number.isFinite(value.archivedAt))
    || ((value.archivedAt === undefined) !== (value.archivePath === undefined))) {
    throw new Error('Invalid completed-chat memory receipt')
  }
  if (value.archivePath !== undefined) validatedArchiveTarget(root, id, value.archivePath)
  if (value.archiveIntent !== undefined) {
    if (value.archiveIntent.version !== 1 || !Number.isFinite(value.archiveIntent.archivedAt)
      || !/^\d+$/.test(value.archiveIntent.sourceDevice)
      || !/^\d+$/.test(value.archiveIntent.sourceInode)
      || value.reopenedAt !== undefined || value.deletedAt !== undefined
      || value.archivedAt !== undefined || value.archivePath !== undefined) {
      throw new Error('Invalid completed-chat archive intent')
    }
    validatedArchiveTarget(root, id, value.archiveIntent.targetPath)
  }
  validatedSessionPath(root, id)
  return value
}

export function readCompletedChatMemory(root: string, id: string): CompletedChatMemory | undefined {
  const path = filename(root, id)
  if (!existsSync(path)) return undefined
  if (lstatSync(path).isSymbolicLink()) throw new Error('Completed-chat memory must not be a symlink')
  if (lstatSync(path).size > MAX_MEMORY_RECEIPT_BYTES) throw new Error('Completed-chat memory receipt is too large')
  const value = JSON.parse(readFileSync(path, 'utf8')) as CompletedChatMemory
  return validatedMemory(value, id, root)
}

export function writeCompletedChatMemory(root: string, memory: CompletedChatMemory): void {
  validatedMemory(memory, memory.sessionId, root)
  mkdirSync(directory(root), { recursive: true, mode: 0o700 })
  const path = filename(root, memory.sessionId)
  const temporary = `${path}.${randomUUID()}.tmp`
  const serialized = JSON.stringify(memory)
  writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  const fd = openSync(temporary, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temporary, path)
  const dir = openSync(directory(root), 'r')
  try { fsyncSync(dir) } finally { closeSync(dir) }
  if (readFileSync(path, 'utf8') !== serialized) throw new Error('Completed-chat memory verification failed')
}
