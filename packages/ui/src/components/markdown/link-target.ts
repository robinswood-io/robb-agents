import { isFilePathTarget } from './linkify'
import { hasKnownFileExtension } from '../../lib/file-classification'

export type ResolvedMarkdownLinkTarget =
  | { kind: 'file'; path: string }
  | { kind: 'url'; url: string }

function normalizeFileUrlPath(path: string): string {
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path
}

function resolveFileUrlPath(target: string): string | null {
  if (!/^file:/i.test(target)) return null

  try {
    const parsed = new URL(target)
    if (parsed.protocol !== 'file:') return null

    const pathname = decodeURIComponent(parsed.pathname || '')
    if (!pathname && !parsed.hostname) return null

    if (parsed.hostname) {
      const hostname = decodeURIComponent(parsed.hostname)
      return normalizeFileUrlPath(`//${hostname}${pathname}`)
    }

    return normalizeFileUrlPath(pathname)
  } catch {
    return null
  }
}

function resolveSandboxFilePath(target: string): string | null {
  if (!/^sandbox:/i.test(target)) return null
  try {
    const parsed = new URL(target)
    // Agents sometimes prefix a host-local deliverable with sandbox:. This is
    // a local file reference, never a remote sandbox or a replacement root.
    if (parsed.hostname || !parsed.pathname.startsWith('/') || parsed.pathname.startsWith('//')) return null
    return normalizeFileUrlPath(decodeURIComponent(parsed.pathname))
  } catch {
    return null
  }
}

/**
 * Resolve markdown link targets for click dispatch.
 *
 * - Raw filesystem paths are routed through onFileClick
 * - Explicit file:// and local sandbox: references are normalized to filesystem paths
 * - Everything else is treated as a URL and routed through onUrlClick
 */
export function resolveMarkdownLinkTarget(target: string): ResolvedMarkdownLinkTarget {
  const trimmed = target.trim()

  const fileUrlPath = resolveFileUrlPath(trimmed) ?? resolveSandboxFilePath(trimmed)
  if (fileUrlPath) {
    return { kind: 'file', path: fileUrlPath }
  }

  // A parsed anchor has an explicit destination: unlike autolinking prose, it
  // may legitimately contain spaces or Unicode (notably raw HTML anchors).
  const hasUrlScheme = /^[a-z][a-z\d+.-]*:/i.test(trimmed) && !/^[a-z]:[\\/]/i.test(trimmed)
  // A standard PDF page fragment is navigation metadata, not part of the
  // filename. Keep all other # characters (including encoded literals) intact.
  const localPath = hasUrlScheme ? trimmed : trimmed.replace(/^(.*\.pdf)#page=\d+$/i, '$1')
  const explicitFilePath = !hasUrlScheme && !/[\u0000-\u001f\u007f]/.test(trimmed)
    && hasKnownFileExtension(localPath)
  if (isFilePathTarget(localPath) || explicitFilePath) {
    // Bare paths may carry percent-encoded octets (e.g. %20 for a space) since
    // that's the only CommonMark-valid way to fit one in an unbracketed link
    // destination — decode before handing off, mirroring resolveFileUrlPath above.
    try {
      return { kind: 'file', path: decodeURIComponent(localPath) }
    } catch {
      return { kind: 'file', path: localPath }
    }
  }

  return { kind: 'url', url: trimmed }
}

/**
 * Backward-compatible classifier for tests and existing callers that only need the kind.
 */
export function classifyMarkdownLinkTarget(target: string): 'file' | 'url' {
  return resolveMarkdownLinkTarget(target).kind
}
