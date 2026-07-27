/**
 * Session Bundle — Serialization Format for Session Export/Import
 *
 * A SessionBundle is the portable representation of a session directory,
 * used for transferring sessions between workspaces (same-server or cross-server).
 *
 * This is the foundation for session dispatch (move/fork), backup, and sharing.
 */

import { existsSync, readFileSync } from 'fs'
import { basename, extname } from 'path'
import type { SessionHeader, StoredMessage, SessionConfig } from './types.ts'
import type { StoredSession } from './types.ts'
import type { SessionExecutionIsolation } from '../tasks/durable-execution.ts'
import { readSessionJsonl } from './jsonl.ts'
import { getSessionPath, getSessionFilePath } from './storage.ts'
import { validateSessionId } from './validation.ts'
import { debug } from '../utils/debug.ts'
import { redactSecretLikeMaterial, redactStructuredSecrets } from '../utils/redaction.ts'
import {
  type BundleFile,
  MAX_BUNDLE_SIZE_BYTES,
  collectDirectoryFiles,
} from '../utils/bundle-files.ts'

// Re-export BundleFile and MAX_BUNDLE_SIZE_BYTES for backward compatibility
export { type BundleFile, MAX_BUNDLE_SIZE_BYTES } from '../utils/bundle-files.ts'

/**
 * Directories to skip when collecting session files for export.
 * tmp/ is regenerable; dotfiles are typically internal state.
 */
const SKIP_DIRS = new Set(['tmp'])

/**
 * Files to skip when collecting session files for export.
 * session.jsonl is in the bundle as structured data.
 */
const SKIP_SESSION_FILES = new Set(['session.jsonl', 'session.jsonl.tmp'])

const SENSITIVE_FILE_NAMES = new Set([
  '.env',
  '.npmrc',
  '.pypirc',
  'credentials.json',
  'credentials.enc',
  'token.json',
  'tokens.json',
  'id_rsa',
  'id_ed25519',
])

const SENSITIVE_FILE_EXTENSIONS = new Set(['.key', '.pem', '.p12', '.pfx', '.kdbx'])
const REDACTABLE_TEXT_EXTENSIONS = new Set([
  '.conf', '.css', '.csv', '.env', '.html', '.ini', '.js', '.json', '.jsonl', '.jsx',
  '.log', '.md', '.sql', '.sh', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml',
])

/**
 * Dispatch mode determines how the imported session relates to the original.
 */
export type DispatchMode = 'move' | 'fork'

/**
 * Branch info for fork operations.
 * Enables SDK-level conversation branching on the target server,
 * so the forked session has full context from the original.
 */
export interface BundleBranchInfo {
  /** SDK session ID to branch from */
  sdkSessionId: string
  /** SDK turn ID (branch point) */
  sdkTurnId: string
  /** Working directory for SDK session storage */
  sdkCwd: string
}

/**
 * Serialized representation of a session directory.
 * JSON envelope format — sessions are typically small (text + a few attachments).
 */
export interface SessionBundle {
  /** Bundle format version */
  version: 1
  /** Session data (header metadata + full message history) */
  session: {
    /** Session metadata (id, name, timestamps, config) */
    header: SessionHeader
    /** Full message history */
    messages: StoredMessage[]
  }
  /** All files from the session directory (attachments, plans, data, downloads, etc.) */
  files: BundleFile[]
  /** Branch info for fork operations (populated by the exporter when forking) */
  branchInfo?: BundleBranchInfo
  /** Security posture of this portable payload. Legacy bundles may omit it. */
  security?: {
    trust: 'portable-redacted'
    secretLikeTextRedacted: true
    excludedSensitiveFiles: string[]
    /** Binary attachments are preserved byte-for-byte and require destination-side policy review. */
    binaryFilesUninspected: string[]
  }
}

/**
 * Portable bundles are intentionally unsigned. A task execution envelope from
 * another host can therefore never be trusted or rebound implicitly. Imported
 * task sessions receive a local quarantine envelope and must be re-authorized
 * by the TaskRunner before they can inspect or mutate workspace files.
 */
export function createImportedSessionIsolation(
  header: SessionHeader,
  workspaceRootPath: string,
): SessionExecutionIsolation | undefined {
  const isTaskSession = Boolean(
    header.taskRunId ||
    header.taskNodeId ||
    header.executionIsolation,
  )
  if (!isTaskSession) return undefined

  return {
    effect: 'read',
    policy: {
      workspaceRoot: workspaceRootPath,
      allowedReadPaths: [],
      allowedWritePaths: [],
      networkAccess: 'disabled',
      allowedHosts: [],
      maxCpuPercent: 100,
      maxMemoryMb: 512,
      timeoutMs: 30_000,
    },
  }
}

function sanitizePortableFiles(files: BundleFile[]): {
  files: BundleFile[]
  excludedSensitiveFiles: string[]
  binaryFilesUninspected: string[]
} {
  const excludedSensitiveFiles: string[] = []
  const binaryFilesUninspected: string[] = []
  const sanitized: BundleFile[] = []

  for (const file of files) {
    const fileName = basename(file.relativePath).toLowerCase()
    const extension = extname(fileName)
    if (SENSITIVE_FILE_NAMES.has(fileName) || SENSITIVE_FILE_EXTENSIONS.has(extension)) {
      excludedSensitiveFiles.push(file.relativePath)
      continue
    }

    if (!REDACTABLE_TEXT_EXTENSIONS.has(extension)) {
      binaryFilesUninspected.push(file.relativePath)
      sanitized.push(file)
      continue
    }

    const redacted = Buffer.from(
      redactSecretLikeMaterial(Buffer.from(file.contentBase64, 'base64').toString('utf8')),
      'utf8',
    )
    sanitized.push({
      relativePath: file.relativePath,
      contentBase64: redacted.toString('base64'),
      size: redacted.length,
    })
  }

  return { files: sanitized, excludedSensitiveFiles, binaryFilesUninspected }
}

/**
 * Serialize a session directory into a SessionBundle.
 *
 * Reads the session JSONL and all associated files (attachments, plans, data, downloads).
 * Skips tmp/ directory and dotfiles. Validates total size against MAX_BUNDLE_SIZE_BYTES.
 *
 * @param workspaceRootPath - Root path of the workspace containing the session
 * @param sessionId - ID of the session to serialize
 * @returns SessionBundle or null if session doesn't exist or exceeds size limit
 */
export function serializeSession(
  workspaceRootPath: string,
  sessionId: string,
): SessionBundle | null {
  const sessionDir = getSessionPath(workspaceRootPath, sessionId)
  const sessionFile = getSessionFilePath(workspaceRootPath, sessionId)

  if (!existsSync(sessionFile)) {
    debug('[bundle] Session file not found:', sessionFile)
    return null
  }

  // Read and parse session JSONL
  const stored = readSessionJsonl(sessionFile)
  if (!stored) {
    debug('[bundle] Failed to parse session JSONL:', sessionFile)
    return null
  }

  // Collect all files from session directory (except session.jsonl and tmp/)
  const collectedFiles = collectDirectoryFiles(sessionDir, {
    skipDirs: SKIP_DIRS,
    skipFiles: SKIP_SESSION_FILES,
  })
  const sanitizedFiles = sanitizePortableFiles(collectedFiles)
  const files = sanitizedFiles.files

  // Validate total bundle size
  const totalSize = files.reduce((sum, f) => sum + f.size, 0)
  if (totalSize > MAX_BUNDLE_SIZE_BYTES) {
    debug(`[bundle] Session exceeds max bundle size: ${totalSize} bytes > ${MAX_BUNDLE_SIZE_BYTES} bytes`)
    return null
  }

  // Build header from stored session (re-use the header creation from JSONL)
  // We read the raw header from the JSONL to preserve pre-computed fields
  const rawContent = readFileSync(sessionFile, 'utf-8')
  const firstLine = rawContent.split('\n')[0]
  if (!firstLine) return null

  // Strip server-internal fields that shouldn't travel with the bundle
  const rawHeader: SessionHeader = {
    ...JSON.parse(firstLine) as SessionHeader,
    // workspaceRootPath will be set by the importing server
  }
  const header = redactStructuredSecrets<SessionHeader>({
    ...rawHeader,
    workspaceRootPath: '',
    workingDirectory: undefined,
    sdkCwd: undefined,
    sharedUrl: undefined,
    sharedId: undefined,
    pendingPlanExecution: undefined,
    // Host-bound execution rights are never portable. The importer recreates
    // a deny-by-default quarantine envelope for task sessions.
    executionIsolation: undefined,
  })

  return {
    version: 1,
    session: {
      header,
      messages: redactStructuredSecrets(stored.messages),
    },
    files,
    security: {
      trust: 'portable-redacted',
      secretLikeTextRedacted: true,
      excludedSensitiveFiles: sanitizedFiles.excludedSensitiveFiles,
      binaryFilesUninspected: sanitizedFiles.binaryFilesUninspected,
    },
  }
}

/**
 * Validate a SessionBundle structure.
 * Checks version, required fields, and basic integrity.
 */
export function validateBundle(bundle: unknown): bundle is SessionBundle {
  if (!bundle || typeof bundle !== 'object') return false
  const b = bundle as Record<string, unknown>

  if (b.version !== 1) return false
  if (!b.session || typeof b.session !== 'object') return false

  const session = b.session as Record<string, unknown>
  if (!session.header || typeof session.header !== 'object') return false
  if (!Array.isArray(session.messages)) return false

  const header = session.header as Record<string, unknown>
  if (typeof header.id !== 'string') return false
  if (typeof header.createdAt !== 'number') return false
  try {
    validateSessionId(header.id)
  } catch {
    return false
  }

  if (!Array.isArray(b.files)) return false

  if (b.security !== undefined) {
    if (!b.security || typeof b.security !== 'object') return false
    const security = b.security as Record<string, unknown>
    if (security.trust !== 'portable-redacted' || security.secretLikeTextRedacted !== true) return false
    if (!Array.isArray(security.excludedSensitiveFiles) || !Array.isArray(security.binaryFilesUninspected)) return false
    if (!security.excludedSensitiveFiles.every((path) => typeof path === 'string')) return false
    if (!security.binaryFilesUninspected.every((path) => typeof path === 'string')) return false
  }

  return true
}
