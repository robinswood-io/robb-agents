/**
 * Linear-time text sanitizers for untrusted session and provider content.
 *
 * These helpers deliberately avoid nested regular-expression quantifiers: the
 * input may come from model output, imported sessions, or external providers.
 */

function removeDelimitedBlocks(input: string, opening: string, closing: string): string {
  const lowerInput = input.toLowerCase()
  const lowerOpening = opening.toLowerCase()
  const lowerClosing = closing.toLowerCase()
  const chunks: string[] = []
  let cursor = 0

  while (cursor < input.length) {
    const start = lowerInput.indexOf(lowerOpening, cursor)
    if (start === -1) {
      chunks.push(input.slice(cursor))
      break
    }

    chunks.push(input.slice(cursor, start))
    const end = lowerInput.indexOf(lowerClosing, start + opening.length)
    if (end === -1) break
    cursor = end + closing.length
  }

  return chunks.join('')
}

function removeBracketMentions(input: string): string {
  const prefixes = ['[skill:', '[source:', '[file:', '[folder:'] as const
  const lowerInput = input.toLowerCase()
  const chunks: string[] = []
  let cursor = 0

  while (cursor < input.length) {
    let nextStart = -1
    for (const prefix of prefixes) {
      const candidate = lowerInput.indexOf(prefix, cursor)
      if (candidate !== -1 && (nextStart === -1 || candidate < nextStart)) {
        nextStart = candidate
      }
    }

    if (nextStart === -1) {
      chunks.push(input.slice(cursor))
      break
    }

    chunks.push(input.slice(cursor, nextStart))
    const end = input.indexOf(']', nextStart + 1)
    if (end === -1) {
      chunks.push(input.slice(nextStart))
      break
    }
    cursor = end + 1
  }

  return chunks.join('')
}

/** Remove angle-bracket tags without attempting to parse HTML with a regexp. */
export function stripAngleBracketTags(input: string): string {
  const chunks: string[] = []
  let cursor = 0

  while (cursor < input.length) {
    const start = input.indexOf('<', cursor)
    if (start === -1) {
      chunks.push(input.slice(cursor))
      break
    }

    chunks.push(input.slice(cursor, start))
    const end = input.indexOf('>', start + 1)
    if (end === -1) break
    cursor = end + 1
  }

  return chunks.join('')
}

/** Collapse all Unicode whitespace runs to a single ASCII space. */
export function collapseWhitespace(input: string): string {
  let result = ''
  let pendingSpace = false

  for (const character of input) {
    if (character.trim().length === 0) {
      pendingSpace = result.length > 0
      continue
    }
    if (pendingSpace) result += ' '
    result += character
    pendingSpace = false
  }

  return result
}

/** Produce plain preview/title text from untrusted message content. */
export function sanitizeMessagePreviewText(content: string): string {
  const withoutBlocks = removeDelimitedBlocks(content, '<edit_request>', '</edit_request>')
  const withoutMentions = removeBracketMentions(withoutBlocks)
  return collapseWhitespace(stripAngleBracketTags(withoutMentions)).trim()
}
