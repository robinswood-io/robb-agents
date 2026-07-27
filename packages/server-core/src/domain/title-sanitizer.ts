/**
 * Title sanitization utility.
 * Extracted to a separate file to allow unit testing without importing
 * Electron main process modules.
 */
import { sanitizeMessagePreviewText } from '@craft-agent/shared/utils/text-sanitization'

/**
 * Sanitize message content for use as session title.
 * Strips XML blocks (e.g. <edit_request>), bracket mentions, and normalizes whitespace.
 */
export function sanitizeForTitle(content: string): string {
  return sanitizeMessagePreviewText(content)
}
