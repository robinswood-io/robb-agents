/** Resolve a document link against the session directory, without changing its filesystem root. */
export function resolveSessionFilePath(path: string, workingDirectory?: string, workspaceRoot?: string): string {
  if (path.startsWith('/') || path.startsWith('~/') || path.startsWith('\\\\') || /^[a-z]:[\\/]/i.test(path)) return path
  const baseDir = workingDirectory || workspaceRoot
  if (!baseDir) return path
  return `${baseDir.replace(/\/+$/, '')}/${path.replace(/^\.\//, '')}`
}

/** A preview's relative links belong to its document, not to the renderer or another session. */
export function resolveDocumentFilePath(path: string, documentPath: string): string {
  const normalized = documentPath.replace(/\\/g, '/')
  const directory = normalized.slice(0, normalized.lastIndexOf('/') + 1)
  return resolveSessionFilePath(path, directory)
}
