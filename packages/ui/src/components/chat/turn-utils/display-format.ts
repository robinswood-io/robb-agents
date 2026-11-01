
// ============================================================================
// Formatting Helpers
// ============================================================================

/**
 * Format duration in milliseconds to human-readable string.
 * @example formatDuration(1234) => "1.2s"
 * @example formatDuration(65000) => "1m 5s"
 * @example formatDuration(125000) => "2m+"
 */
export function formatDuration(ms: number): string {
  // Guard against invalid inputs
  if (!Number.isFinite(ms) || ms < 0) {
    return '--'
  }
  const seconds = ms / 1000
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`
  }
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.round(seconds % 60)
  if (minutes >= 2) {
    return `${minutes}m+`
  }
  return `${minutes}m ${remainingSeconds}s`
}

/**
 * Format token count to human-readable string.
 * @example formatTokens(500) => "500"
 * @example formatTokens(1500) => "1.5k"
 * @example formatTokens(15000) => "15k"
 */
export function formatTokens(count: number): string {
  // Guard against invalid inputs
  if (!Number.isFinite(count) || count < 0) {
    return '0'
  }
  count = Math.floor(count) // Tokens are integers
  if (count < 1000) {
    return count.toString()
  }
  const k = count / 1000
  if (k < 10) {
    return `${k.toFixed(1)}k`
  }
  return `${Math.round(k)}k`
}
