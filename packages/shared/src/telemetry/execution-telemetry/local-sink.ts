import { constants, fchmodSync, ftruncateSync, readSync, writeSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { ensureConfinedDirectory, openConfinedRegularFile, unlinkConfinedRegularFile, type ConfinedRegularFile } from "../../missions/confined-file.ts";
import type { ExecutionTelemetrySink, RobbExecutionTelemetryEvent } from './contracts.ts';
import { toPrivacySafeTelemetryRecord } from './contracts.ts';

const localJsonlOperations = new Map<string, Promise<void>>()

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

async function serializeLocalJsonlOperation(
  key: string,
  operation: () => Promise<void>,
): Promise<void> {
  const previous = localJsonlOperations.get(key) ?? Promise.resolve()
  const result = previous.then(operation, operation)
  const barrier = result.catch(() => {})
  localJsonlOperations.set(key, barrier)
  try {
    await result
  } finally {
    if (localJsonlOperations.get(key) === barrier) localJsonlOperations.delete(key)
  }
}

function openLocalJsonlFile(
  root: string,
  path: string,
  allowCreate: boolean,
): ConfinedRegularFile | undefined {
  try {
    const handle = openConfinedRegularFile(root, path, {
      flags: constants.O_RDWR | constants.O_APPEND | (allowCreate ? constants.O_CREAT : 0),
      mode: 0o600,
      allowCreate,
    })
    fchmodSync(handle.descriptor, 0o600)
    return handle
  } catch (error) {
    if (!allowCreate && errnoCode(error) === 'ENOENT') return undefined
    throw error
  }
}

function findLastNewline(handle: ConfinedRegularFile, size: number): number {
  const chunk = Buffer.allocUnsafe(Math.min(4096, size))
  let cursor = size
  while (cursor > 0) {
    const start = Math.max(0, cursor - chunk.length)
    const length = cursor - start
    readSync(handle.descriptor, chunk, 0, length, start)
    const index = chunk.subarray(0, length).lastIndexOf(0x0a)
    if (index >= 0) return start + index
    cursor = start
  }
  return -1
}

/** Repair only an interrupted final record; complete earlier JSONL stays intact. */
function repairLocalJsonlTail(handle: ConfinedRegularFile, maxBytes: number): number {
  const initialSize = handle.assertStillBound().size
  if (initialSize === 0) return 0
  const finalByte = Buffer.allocUnsafe(1)
  readSync(handle.descriptor, finalByte, 0, 1, initialSize - 1)
  if (finalByte[0] === 0x0a) return initialSize

  const lastNewline = findLastNewline(handle, initialSize)
  const tailStart = lastNewline + 1
  const tail = Buffer.allocUnsafe(initialSize - tailStart)
  readSync(handle.descriptor, tail, 0, tail.length, tailStart)
  try {
    JSON.parse(tail.toString('utf8'))
    if (initialSize < maxBytes) {
      writeSync(handle.descriptor, '\n')
      return initialSize + 1
    }
  } catch {
    // A torn final record is discarded below at its preceding line boundary.
  }
  ftruncateSync(handle.descriptor, tailStart)
  return tailStart
}

function inspectLocalJsonlFile(
  root: string,
  path: string,
  maxBytes: number,
): ConfinedRegularFile | undefined {
  const handle = openLocalJsonlFile(root, path, false)
  if (!handle) return undefined
  try {
    if (handle.assertStillBound().size > maxBytes) {
      unlinkConfinedRegularFile(handle)
      handle.close()
      return undefined
    }
    repairLocalJsonlTail(handle, maxBytes)
    return handle
  } catch (error) {
    handle.close()
    throw error
  }
}

function appendCompleteLocalJsonlRecord(
  handle: ConfinedRegularFile,
  line: Buffer,
  maxBytes: number,
): void {
  const initialSize = handle.assertStillBound().size
  if (initialSize + line.length > maxBytes) {
    throw new Error('Local JSONL append would exceed its configured byte budget')
  }
  let offset = 0
  try {
    while (offset < line.length) {
      const written = writeSync(handle.descriptor, line, offset, line.length - offset)
      if (written <= 0) throw new Error('Local JSONL append made no progress')
      offset += written
    }
    const finalSize = handle.assertStillBound().size
    if (finalSize > maxBytes) throw new Error('Local JSONL append exceeded its configured byte budget')
  } catch (error) {
    handle.assertStillBound()
    ftruncateSync(handle.descriptor, initialSize)
    throw error
  }
}

function readBoundLocalJsonlFile(handle: ConfinedRegularFile, size: number): Buffer {
  const content = Buffer.allocUnsafe(size)
  let offset = 0
  while (offset < size) {
    const read = readSync(handle.descriptor, content, offset, size - offset, offset)
    if (read <= 0) throw new Error('Local JSONL read made no progress')
    offset += read
  }
  handle.assertStillBound()
  return content
}

function replaceBoundLocalJsonlFile(
  handle: ConfinedRegularFile,
  content: Buffer,
  maxBytes: number,
): void {
  if (content.length > maxBytes) {
    throw new Error('Local JSONL rotation would exceed its configured byte budget')
  }
  handle.assertStillBound()
  ftruncateSync(handle.descriptor, 0)
  try {
    let offset = 0
    while (offset < content.length) {
      const written = writeSync(handle.descriptor, content, offset, content.length - offset)
      if (written <= 0) throw new Error('Local JSONL rotation made no progress')
      offset += written
    }
    const finalSize = handle.assertStillBound().size
    if (finalSize !== content.length || finalSize > maxBytes) {
      throw new Error('Local JSONL rotation produced an invalid archive size')
    }
  } catch (error) {
    // The active descriptor is left intact until the archive is complete. If
    // copying fails, remove the partial archive record rather than retain it.
    ftruncateSync(handle.descriptor, 0)
    throw error
  }
}

function rotateBoundLocalJsonlFile(
  root: string,
  active: ConfinedRegularFile,
  archivePath: string,
  maxBytes: number,
): void {
  const activeSize = active.assertStillBound().size
  const content = readBoundLocalJsonlFile(active, activeSize)
  const archive = openLocalJsonlFile(root, archivePath, true)
  if (!archive) throw new Error(`Unable to open local telemetry archive: ${archivePath}`)
  try {
    replaceBoundLocalJsonlFile(archive, content, maxBytes)
    // Keep the source intact until the archive copy is complete. Both
    // operations remain descriptor-bound if an untrusted workspace swaps a
    // parent path concurrently.
    active.assertStillBound()
    ftruncateSync(active.descriptor, 0)
  } finally {
    archive.close()
  }
}

/**
 * Small, dependency-free JSONL sink for local quality/cost analysis. Events are
 * serialized through an explicit allowlist and rotated to a single bounded
 * archive at the size limit. Writes are ordered to prevent interleaved JSON
 * records. Rotation copies the previous window through confined descriptors
 * before truncating the active file. A record that cannot fit by itself is
 * discarded whole: the sink never intentionally persists truncated JSON or a
 * file larger than the configured byte budget.
 */
export class LocalJsonlTelemetrySink implements ExecutionTelemetrySink {
  private readonly filePath: string
  private readonly confinementRoot: string
  private readonly maxBytes: number

  constructor(
    filePath: string,
    maxBytes = 10 * 1024 * 1024,
    confinementRoot = dirname(filePath),
  ) {
    this.filePath = resolve(filePath)
    this.confinementRoot = resolve(confinementRoot)
    // Invalid limits fail closed for local persistence instead of silently
    // turning the size guard off (for example, every comparison with NaN is
    // false). A zero-byte budget simply drops every complete record.
    this.maxBytes = Number.isFinite(maxBytes) && maxBytes > 0
      ? Math.floor(maxBytes)
      : 0
  }

  async emit(event: RobbExecutionTelemetryEvent): Promise<void> {
    const line = Buffer.from(`${JSON.stringify(toPrivacySafeTelemetryRecord(event))}\n`)
    const lineBytes = line.length
    const write = async () => {
      const parentPath = dirname(this.filePath)
      const parentRelative = relative(this.confinementRoot, parentPath)
      if (
        isAbsolute(parentRelative)
        || parentRelative === '..'
        || parentRelative.startsWith(`..${sep}`)
      ) {
        throw new Error(`Local telemetry path escapes its confinement root: ${this.filePath}`)
      }
      ensureConfinedDirectory(
        this.confinementRoot,
        ...parentRelative.split(sep).filter(Boolean),
      )

      // Clean up an oversized file left by an earlier implementation before
      // considering the new event. It cannot be retained within this sink's
      // strict on-disk byte contract.
      const archivePath = `${this.filePath}.1`
      const archive = inspectLocalJsonlFile(this.confinementRoot, archivePath, this.maxBytes)
      archive?.close()
      let active = inspectLocalJsonlFile(this.confinementRoot, this.filePath, this.maxBytes)

      // Never truncate JSON to satisfy the limit. Dropping one oversized,
      // already-allowlisted record is preferable to corrupting the journal or
      // retaining an unexpectedly large value on disk.
      if (lineBytes > this.maxBytes) {
        active?.close()
        return
      }

      active ??= openLocalJsonlFile(this.confinementRoot, this.filePath, true)
      if (!active) throw new Error(`Unable to open local telemetry file: ${this.filePath}`)
      try {
        if (active.assertStillBound().size + lineBytes > this.maxBytes) {
          rotateBoundLocalJsonlFile(
            this.confinementRoot,
            active,
            archivePath,
            this.maxBytes,
          )
        }
        appendCompleteLocalJsonlRecord(active, line, this.maxBytes)
      } finally {
        active.close()
      }
    }
    await serializeLocalJsonlOperation(this.filePath, write)
  }
}
