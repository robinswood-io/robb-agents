export interface TransferSummaryMessage {
  type: 'user' | 'assistant'
  content: string
}

export const TRANSFER_SUMMARY_INPUT_MAX_CHARS = 32_000
export const TRANSFER_SUMMARY_FALLBACK_MAX_CHARS = 12_000

const MAX_MESSAGE_CHARS = 8_000

function truncateContent(content: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (content.length <= maxChars) return content
  const omissionMarker = '\n… [contenu intermédiaire omis] …\n'
  if (maxChars <= omissionMarker.length + 2) return content.slice(0, maxChars)
  const payloadChars = maxChars - omissionMarker.length
  const headChars = Math.floor(payloadChars * 0.4)
  const tailChars = payloadChars - headChars
  const tail = tailChars > 0 ? content.slice(-tailChars) : ''
  return `${content.slice(0, headChars)}${omissionMarker}${tail}`
}

/**
 * Keep a small chronological sample for provider handoffs. The first user
 * objective and the most recent final exchanges carry substantially more
 * continuity value than replaying an entire multi-megabyte transcript.
 */
export function selectTransferSummaryMessages(
  messages: TransferSummaryMessage[],
  maxChars = TRANSFER_SUMMARY_INPUT_MAX_CHARS,
): TransferSummaryMessage[] {
  if (maxChars <= 0 || messages.length === 0) return []

  const firstUserIndex = messages.findIndex(message => message.type === 'user')
  const selected = new Map<number, TransferSummaryMessage>()
  let remaining = maxChars

  const add = (index: number): boolean => {
    if (index < 0 || selected.has(index) || remaining <= 0) return false
    const content = truncateContent(messages[index]!.content, Math.min(MAX_MESSAGE_CHARS, remaining))
    if (!content) return false
    selected.set(index, { type: messages[index]!.type, content })
    remaining -= content.length
    return true
  }

  if (firstUserIndex >= 0) add(firstUserIndex)

  for (let index = messages.length - 1; index >= 0 && remaining > 0; index--) {
    add(index)
  }

  return [...selected.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, message]) => message)
}

export function buildExtractiveTransferSummary(
  messages: TransferSummaryMessage[],
  maxChars = TRANSFER_SUMMARY_FALLBACK_MAX_CHARS,
): string | null {
  const selected = selectTransferSummaryMessages(messages, maxChars)
  if (selected.length === 0) return null

  const body = selected
    .map(message => `${message.type === 'user' ? 'Utilisateur' : 'Assistant'}:\n${message.content}`)
    .join('\n\n')

  return [
    'Résumé extractif local de continuité (aucune nouvelle action n’est prouvée par ce texte).',
    'Vérifier l’état réel avant de reprendre une action ou une mutation externe.',
    body,
  ].join('\n\n')
}
