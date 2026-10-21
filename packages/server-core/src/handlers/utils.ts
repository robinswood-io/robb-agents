import { normalize, isAbsolute, sep, dirname, basename, join } from 'path'
import { homedir, tmpdir } from 'os'
import { realpath } from 'fs/promises'
import { getWorkspaceByNameOrId, type Workspace } from '@craft-agent/shared/config'
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces'
import type { PlatformServices } from '../runtime/platform'

/**
 * Get workspace by ID or name, throwing if not found.
 * Use this when a workspace must exist for the operation to proceed.
 */
export function getWorkspaceOrThrow(workspaceId: string): Workspace {
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`)
  }
  return workspace
}

export function buildBackendHostRuntimeContext(platform: PlatformServices) {
  return {
    appRootPath: platform.appRootPath,
    resourcesPath: platform.resourcesPath,
    isPackaged: platform.isPackaged,
  }
}

/**
 * Sanitizes a filename to prevent path traversal and filesystem issues.
 * Removes dangerous characters and limits length.
 */
export function sanitizeFilename(name: string): string {
  const forbidden = new Set(['/', '\\', '<', '>', ':', '"', '|', '?', '*'])
  let sanitized = ''
  let previousWasDot = false

  for (const character of name) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 31) continue
    if (forbidden.has(character)) {
      sanitized += '_'
      previousWasDot = false
      continue
    }
    if (character === '.') {
      if (!previousWasDot) sanitized += character
      previousWasDot = true
      continue
    }
    sanitized += character
    previousWasDot = false
  }

  let start = 0
  let end = sanitized.length
  while (start < end && (sanitized[start] === '.' || sanitized[start] === ' ')) start++
  while (end > start && (sanitized[end - 1] === '.' || sanitized[end - 1] === ' ')) end--
  return sanitized.slice(start, end).slice(0, 200) || 'unnamed'
}

/**
 * Resolve allowed directories for a workspace: its root path and configured
 * working directory (if set). Returns an empty array if the workspace is
 * unknown or has no relevant paths.
 */
export function getWorkspaceAllowedDirs(workspaceId?: string | null): string[] {
  if (!workspaceId) return []
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) return []

  const dirs: string[] = [workspace.rootPath]
  const config = loadWorkspaceConfig(workspace.rootPath)
  if (config?.defaults?.workingDirectory) {
    dirs.push(config.defaults.workingDirectory)
  }
  return dirs
}

const SENSITIVE_FILE_PATTERNS = [
  /\.ssh[\\/]/,
  /\.gnupg[\\/]/,
  /\.aws[\\/]credentials/,
  /\.kube[\\/]config$/,
  /\.env$/,
  /\.env\./,
  /credentials\.json$/,
  /credentials\.enc(?:\.lock|\.tmp)?$/,
  /\.credential-cache\.json$/,
  /remote-devices\.json$/,
  /\.netrc$/,
  /\.npmrc$/,
  /\.git-credentials$/,
  /id_(?:rsa|ed25519|ecdsa|dsa)$/,
  /secrets?\./i,
  /\.pem$/,
  /\.key$/,
]

export function isSensitiveFilePath(filePath: string): boolean {
  return SENSITIVE_FILE_PATTERNS.some(pattern => pattern.test(filePath))
}

async function resolveRealOrAncestorPath(targetPath: string): Promise<string> {
  try {
    return await realpath(targetPath)
  } catch {
    const parent = dirname(targetPath)
    if (parent === targetPath) return targetPath
    const realParent = await resolveRealOrAncestorPath(parent)
    return join(realParent, basename(targetPath))
  }
}

/**
 * Validates that a file path is within allowed directories to prevent path traversal attacks.
 * Allowed directories: user's home directory, /tmp, and any additional dirs passed by the caller
 * (e.g. workspace root, workspace working directory).
 */
export async function validateFilePath(
  filePath: string,
  additionalAllowedDirs?: string[],
): Promise<string> {
  if (typeof filePath !== 'string' || filePath.includes('\0')) {
    throw new Error('Invalid file path')
  }

  // Normalize the path to resolve . and .. components
  let normalizedPath = normalize(filePath)

  // Expand ~ to home directory
  if (normalizedPath.startsWith('~')) {
    normalizedPath = normalizedPath.replace(/^~/, homedir())
  }

  // Must be an absolute path
  if (!isAbsolute(normalizedPath)) {
    throw new Error('Only absolute file paths are allowed')
  }

  // Resolve symlinks to get the real path (or real ancestor path for non-existent files)
  const realFilePath = await resolveRealOrAncestorPath(normalizedPath)

  // Define allowed base directories
  const rawAllowedDirs = [
    homedir(),
    tmpdir(),
    ...(additionalAllowedDirs ?? []),
  ].filter(Boolean)

  const resolvedAllowedDirs = await Promise.all(
    rawAllowedDirs.map(async dir => normalize(await resolveRealOrAncestorPath(normalize(dir))))
  )

  // Check if the real path is within an allowed directory (cross-platform)
  const normalizedReal = normalize(realFilePath)
  const isAllowed = resolvedAllowedDirs.some(normalizedDir => {
    const prefix = normalizedDir.endsWith(sep) ? normalizedDir : `${normalizedDir}${sep}`
    return normalizedReal === normalizedDir || normalizedReal.startsWith(prefix)
  })

  if (!isAllowed) {
    throw new Error('Access denied: file path is outside allowed directories')
  }

  if (isSensitiveFilePath(realFilePath) || isSensitiveFilePath(normalizedPath)) {
    throw new Error('Access denied: cannot read sensitive files')
  }

  return realFilePath
}
