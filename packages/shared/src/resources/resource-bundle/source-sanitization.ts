import type { FolderSourceConfig } from "../../sources/types.ts";

// ============================================================
// Source Config Sanitization
// ============================================================

/**
 * Fields to strip from source configs on export.
 *
 * Runtime state fields are always removed.
 * Known secret-bearing fields are removed with warnings.
 */

/** Strip runtime auth/status state from a source config */
export function sanitizeSourceConfig(config: FolderSourceConfig): { config: FolderSourceConfig; warnings: string[] } {
  const warnings: string[] = []

  // Deep clone to avoid mutating the original
  const sanitized: FolderSourceConfig = structuredClone(config)

  // --- Runtime state: always remove ---
  sanitized.isAuthenticated = false
  delete sanitized.connectionError
  delete sanitized.lastTestedAt

  // Determine if source requires auth
  const authType = sanitized.mcp?.authType || sanitized.api?.authType
  if (authType && authType !== 'none') {
    sanitized.connectionStatus = 'needs_auth'
  } else {
    delete sanitized.connectionStatus
  }

  // --- Known secret fields: always remove ---
  if (sanitized.api?.googleOAuthClientSecret) {
    delete sanitized.api.googleOAuthClientSecret
    warnings.push(`Source '${config.slug}': stripped googleOAuthClientSecret`)
  }

  // --- MCP env vars: may contain tokens ---
  if (sanitized.mcp?.env && Object.keys(sanitized.mcp.env).length > 0) {
    delete sanitized.mcp.env
    warnings.push(`Source '${config.slug}': stripped mcp.env (may contain secrets)`)
  }

  // --- Headers: potentially secret, remove with warning ---
  if (sanitized.mcp?.headers && Object.keys(sanitized.mcp.headers).length > 0) {
    delete sanitized.mcp.headers
    warnings.push(`Source '${config.slug}': stripped mcp.headers (may contain auth tokens)`)
  }

  if (sanitized.api?.defaultHeaders && Object.keys(sanitized.api.defaultHeaders).length > 0) {
    delete sanitized.api.defaultHeaders
    warnings.push(`Source '${config.slug}': stripped api.defaultHeaders (may contain auth tokens)`)
  }

  return { config: sanitized, warnings }
}

// ============================================================
// Export
// ============================================================

/**
 * Portable resource bundles must not carry credential stores or private keys.
 * Hidden files are already skipped by collectDirectoryFiles; this list covers
 * common non-hidden filenames that may otherwise be accidentally committed.
 */
export const SENSITIVE_RESOURCE_FILE_NAMES = new Set([
  'credentials.json',
  'credential.json',
  'secrets.json',
  'secret.json',
  'tokens.json',
  'token.json',
  'auth.json',
  'oauth.json',
])

export const SENSITIVE_RESOURCE_FILE_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.kdbx']

export const PROTECTED_SOURCE_OVERLAY_MARKER = '.robb-source-overlay.json'

export const SOURCE_TRANSACTION_LOCK_PREFIX = '.robb-source-transaction-'

export const PROTECTED_SOURCE_TRANSACTION_SLUG = 'google-contacts'

export const RESOURCE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
