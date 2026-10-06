/** Resolve a document link against the session directory, without changing its filesystem root. */
export function resolveSessionFilePath(path: string, workingDirectory?: string, workspaceRoot?: string): string {
  if (path.startsWith('/') || path.startsWith('~/') || /^[a-z]:[\\/]/i.test(path)) return path
  const baseDir = workingDirectory || workspaceRoot
  if (!baseDir) return path
  return `${baseDir.replace(/\/+$/, '')}/${path.replace(/^\.\//, '')}`
}
