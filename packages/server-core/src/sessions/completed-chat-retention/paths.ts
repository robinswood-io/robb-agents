import { existsSync, mkdirSync, openSync, fsyncSync, closeSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";

const canonicalRoot = (root: string): string => {
  try { return realpathSync.native(root) } catch { return resolve(root) }
}

export const directory = (root: string) => join(canonicalRoot(root), 'memory', 'completed-chats')

export const filename = (root: string, id: string) => join(directory(root), `${createHash('sha256').update(id).digest('hex')}.json`)

const sessionsDirectory = (root: string) => join(canonicalRoot(root), 'sessions')

const archivesDirectory = (root: string) => join(canonicalRoot(root), 'archives')

const completedChatArchivesDirectory = (root: string) => join(canonicalRoot(root), 'archives', 'completed-chats')

export const MAX_MEMORY_RECEIPT_BYTES = 64_000

export const MAX_DIRECT_USER_MEMORY_CHARS = 1_200

export const MAX_CONTEXT_EXCERPT_CHARS = 800

export function expectedArchiveTargetPrefix(id: string): string {
  return `${createHash('sha256').update(id).digest('hex')}-`
}

export function validatedArchiveTarget(root: string, id: string, value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value
    || dirname(value) !== completedChatArchivesDirectory(root)
    || !basename(value).startsWith(expectedArchiveTargetPrefix(id))
    || !/^[a-f0-9]{64}-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(basename(value))) {
    throw new Error('Invalid completed-chat archive target')
  }
  return value
}

export function validatedSessionPath(root: string, id: string): string {
  const path = resolve(sessionsDirectory(root), id)
  if (dirname(path) !== sessionsDirectory(root)) throw new Error('Invalid completed-chat session identity')
  return path
}

export function fsyncDirectories(paths: string[]): void {
  const errors: unknown[] = []
  for (const path of new Set(paths)) {
    try {
      const fd = openSync(path, 'r')
      try { fsyncSync(fd) } finally { closeSync(fd) }
    } catch (error) { errors.push(error) }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'Completed-chat directory durability failed')
}

export function assertRealArchiveDirectories(root: string): void {
  for (const path of [archivesDirectory(root), completedChatArchivesDirectory(root)]) {
    if (!existsSync(path) || !lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) {
      throw new Error('Completed-chat archive must be a real directory')
    }
  }
}

export function ensureArchiveDirectories(root: string): string {
  const archives = archivesDirectory(root)
  const destination = completedChatArchivesDirectory(root)
  for (const path of [archives, destination]) {
    if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) {
      throw new Error('Completed-chat archive must be a real directory')
    }
    if (!existsSync(path)) {
      const parent = dirname(path)
      mkdirSync(path, { mode: 0o700 })
      fsyncDirectories([parent, path])
    }
  }
  assertRealArchiveDirectories(root)
  return destination
}
