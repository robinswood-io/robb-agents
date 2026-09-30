import type { FileAttachment, SendMessageOptions } from '@craft-agent/shared/protocol'
import type { StoredAttachment } from '@craft-agent/core/types'

/** The redirect transport carries text only. Preserve every other input via the durable FIFO. */
export function canSteerTextPayload(
  attachments?: FileAttachment[],
  storedAttachments?: StoredAttachment[],
  options?: SendMessageOptions,
): boolean {
  if (attachments?.length || storedAttachments?.length) return false
  return !Object.entries(options ?? {}).some(([key, value]) => {
    if (value === undefined || key === 'optimisticMessageId') return false
    if ((key === 'skillSlugs' || key === 'badges') && Array.isArray(value) && value.length === 0) return false
    if (key === 'hidden' && value === false) return false
    return true
  })
}
