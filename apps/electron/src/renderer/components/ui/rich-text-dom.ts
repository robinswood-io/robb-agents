export interface EscapeCompositionEventLike {
  key?: string
  isComposing?: boolean
  nativeEvent?: {
    isComposing?: boolean
  }
}


/**
 * Returns true when Escape is pressed while IME composition is active.
 *
 * Uses both local composition state and event-level composing flags for
 * browser/runtime compatibility.
 */
export function isEscapeDuringComposition(
  event: EscapeCompositionEventLike,
  isComposingRefActive: boolean
): boolean {
  if (event.key !== 'Escape') return false
  return Boolean(isComposingRefActive || event.isComposing || event.nativeEvent?.isComposing)
}


// ============================================================================
// Helper: Extract plain text from contenteditable
// ============================================================================

export function getTextFromElement(element: HTMLElement): string {
  // A single BR is the browser's empty caret placeholder.
  if (element.innerHTML === '<br>') return ''

  let text = ''

  // isTopLevel: true for direct children of the contenteditable root
  function processNode(node: Node, isTopLevel: boolean = false) {
    if (node.nodeType === Node.TEXT_NODE) {
      // Filter out zero-width spaces (used for contenteditable cursor fix)
      text += (node.textContent || '').replace(/\u200B/g, '')
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement

      // Skip mention badges - they shouldn't contribute additional text
      if (el.getAttribute('data-mention') === 'true') {
        // Get the mention text from data attribute
        const mentionText = el.getAttribute('data-mention-text')
        if (mentionText) {
          text += mentionText
        }
        return // Don't process children
      }

      // Handle line breaks
      if (el.tagName === 'BR') {
        text += '\n'
      } else if (el.tagName === 'DIV' && text.length > 0 && !text.endsWith('\n')) {
        // DIVs in contenteditable normally represent line breaks.
        // HOWEVER: When typing before a badge at position 0, browsers wrap the
        // typed character in a <div>, creating: <div>typed</div><span badge>
        // This is NOT a user-intended line break - it's browser behavior.
        // We detect this by checking if a top-level DIV is immediately followed
        // by a mention badge sibling. If so, skip adding the newline.
        if (isTopLevel) {
          // Check if this DIV is followed by a mention badge at top level.
          // Skip over ZWS-only text nodes - browser may preserve them between
          // the DIV wrapper and the badge span.
          let nextSibling: Node | null = el.nextSibling
          while (
            nextSibling?.nodeType === Node.TEXT_NODE &&
            nextSibling.textContent?.replace(/\u200B/g, '') === ''
          ) {
            nextSibling = nextSibling.nextSibling
          }
          const isBrowserWrapper =
            (nextSibling as HTMLElement)?.getAttribute?.('data-mention') === 'true'
          if (!isBrowserWrapper) {
            text += '\n'
          }
          // If it IS followed by a badge, don't add newline - just process children
        } else {
          // Nested DIVs are always treated as line breaks
          text += '\n'
        }
      }

      // Process children (no longer top-level)
      Array.from(el.childNodes).forEach(child => {
        processNode(child, false)
      })
    }
  }

  // Process direct children as top-level nodes
  Array.from(element.childNodes).forEach(child => {
    processNode(child, true)
  })

  return text
}


// ============================================================================
// Helper: Get cursor position in text model
// ============================================================================

export function getCursorPosition(element: HTMLElement, fallback: number = 0): number {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return fallback

  const range = selection.getRangeAt(0)

  // Create a range from start of element to cursor
  const preRange = document.createRange()
  preRange.selectNodeContents(element)
  preRange.setEnd(range.startContainer, range.startOffset)

  // Get text length before cursor, excluding badge content
  const fragment = preRange.cloneContents()
  const div = document.createElement('div')
  div.appendChild(fragment)
  return getTextFromElement(div).length
}


// ============================================================================
// Helper: Set cursor position in contenteditable
// ============================================================================

export function setCursorPosition(element: HTMLElement, targetPosition: number): void {
  const selection = window.getSelection()
  if (!selection) return

  let currentPos = 0

  function findPosition(node: Node): { node: Node; offset: number } | null {
    if (node.nodeType === Node.TEXT_NODE) {
      const rawText = node.textContent || ''
      // Filter out zero-width spaces to match text model (ZWS is a DOM-only artifact)
      const textWithoutZWS = rawText.replace(/\u200B/g, '')
      const modelLength = textWithoutZWS.length

      if (currentPos + modelLength >= targetPosition) {
        // Calculate actual DOM offset accounting for zero-width spaces
        const modelOffset = targetPosition - currentPos
        let domOffset = 0
        let modelCount = 0
        while (modelCount < modelOffset && domOffset < rawText.length) {
          if (rawText[domOffset] !== '\u200B') {
            modelCount++
          }
          domOffset++
        }
        // Skip any trailing ZWS at the target position
        while (domOffset < rawText.length && rawText[domOffset] === '\u200B') {
          domOffset++
        }
        return { node, offset: domOffset }
      }
      currentPos += modelLength
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement

      // Skip mention badge internals - treat as atomic
      if (el.getAttribute('data-mention') === 'true') {
        const mentionText = el.getAttribute('data-mention-text') || ''
        const mentionLength = mentionText.length
        if (currentPos + mentionLength >= targetPosition) {
          // Position cursor after the badge
          return { node: el.parentNode!, offset: Array.from(el.parentNode!.childNodes).indexOf(el) + 1 }
        }
        currentPos += mentionLength
        return null
      }

      // Handle BR
      if (el.tagName === 'BR') {
        currentPos += 1
        if (currentPos >= targetPosition) {
          return { node: el.parentNode!, offset: Array.from(el.parentNode!.childNodes).indexOf(el) + 1 }
        }
        return null
      }

      for (const child of el.childNodes) {
        const result = findPosition(child)
        if (result) return result
      }
    }
    return null
  }

  const result = findPosition(element)

  if (result) {
    const range = document.createRange()
    range.setStart(result.node, result.offset)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
  } else {
    // Position at end
    const range = document.createRange()
    range.selectNodeContents(element)
    range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
  }
}
