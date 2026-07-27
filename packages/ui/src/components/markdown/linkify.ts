import LinkifyIt from 'linkify-it'
import { hasKnownFileExtension } from '../../lib/file-classification'

/**
 * Linkify - URL and file path detection for markdown preprocessing
 *
 * Uses linkify-it (12M downloads/week) for battle-tested URL detection,
 * plus custom regex for local file paths.
 */

// Initialize linkify-it with default settings (fuzzy URLs, emails enabled)
const linkify = new LinkifyIt()

function isAsciiLetterOrDigit(character: string): boolean {
  return (character >= 'a' && character <= 'z')
    || (character >= 'A' && character <= 'Z')
    || (character >= '0' && character <= '9')
}

function isHexDigit(character: string | undefined): boolean {
  return character !== undefined && (
    (character >= '0' && character <= '9')
    || (character.toLowerCase() >= 'a' && character.toLowerCase() <= 'f')
  )
}

function pathCharacterWidth(text: string, index: number): number {
  const character = text[index]
  if (!character) return 0
  if (isAsciiLetterOrDigit(character) || ['_', '-', '.', '/', '@', '~'].includes(character)) return 1
  if (character === '%' && isHexDigit(text[index + 1]) && isHexDigit(text[index + 2])) return 3
  return 0
}

function isPathStart(text: string, index: number): boolean {
  const character = text[index]
  if (!character) return false
  if (character === '/' || isAsciiLetterOrDigit(character) || character === '_') return true
  if (character === '~') return text[index + 1] === '/'
  if (character === '.') {
    return text[index + 1] === '/'
      || (text[index + 1] === '.' && text[index + 2] === '/')
  }
  return false
}

function isPathStartBoundary(character: string | undefined): boolean {
  return character === undefined || character.trim().length === 0 || ['(', '[', '{', '<'].includes(character)
}

function isPathEndBoundary(character: string | undefined): boolean {
  return character === undefined || character.trim().length === 0 || [')', ']', '}', '.', ',', ':', ';', '!', '?', '>'].includes(character)
}

function trimPathEnd(text: string, start: number, end: number): number {
  let candidateEnd = end
  while (candidateEnd > start && text[candidateEnd - 1] === '.') candidateEnd -= 1
  return candidateEnd
}

interface DetectedLink {
  type: 'url' | 'email' | 'file'
  text: string
  url: string
  start: number
  end: number
}

interface CodeRange {
  start: number
  end: number
}

function findFilePathCandidates(text: string): DetectedLink[] {
  const paths: DetectedLink[] = []
  let cursor = 0

  while (cursor < text.length) {
    if (!isPathStartBoundary(text[cursor - 1]) || !isPathStart(text, cursor)) {
      cursor += 1
      continue
    }

    let end = cursor
    while (end < text.length) {
      const consumed = pathCharacterWidth(text, end)
      if (consumed === 0) break
      end += consumed
    }

    const candidateEnd = hasKnownFileExtension(text.slice(cursor, end))
      ? end
      : trimPathEnd(text, cursor, end)
    const candidate = text.slice(cursor, candidateEnd)
    if (hasKnownFileExtension(candidate) && isPathEndBoundary(text[candidateEnd])) {
      paths.push({
        type: 'file',
        text: candidate,
        url: candidate,
        start: cursor,
        end: candidateEnd,
      })
    }

    cursor = Math.max(end, cursor + 1)
  }

  return paths
}

/**
 * Find all code block and inline code ranges in text
 * These ranges should be excluded from link detection
 */
function findCodeRanges(text: string): CodeRange[] {
  const ranges: CodeRange[] = []

  // Find fenced code blocks (```...```)
  const fencedRegex = /```[\s\S]*?```/g
  let match
  while ((match = fencedRegex.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }

  // Find inline code (`...`)
  // But skip escaped backticks and code inside fenced blocks
  const inlineRegex = /(?<!`)`(?!`)([^`\n]+)`(?!`)/g
  while ((match = inlineRegex.exec(text)) !== null) {
    const pos = match.index
    // Check if this is inside a fenced block
    const insideFenced = ranges.some(r => pos >= r.start && pos < r.end)
    if (!insideFenced) {
      ranges.push({ start: pos, end: pos + match[0].length })
    }
  }

  return ranges
}

/**
 * Check if a position is inside any code range
 */
function isInsideCode(pos: number, ranges: CodeRange[]): boolean {
  return ranges.some(r => pos >= r.start && pos < r.end)
}

/**
 * Find all markdown link ranges in text: both [text](...) and [text][ref] patterns.
 * Returns ranges covering the entire link syntax so any URL detected within
 * these spans is skipped by preprocessLinks() — preventing nested/broken links.
 */
function findMarkdownLinkRanges(text: string): CodeRange[] {
  const ranges: CodeRange[] = []

  // Match [text](url) — inline links
  const inlineLinkRegex = /\[(?:[^\[\]]|\\\[|\\\])*\]\([^)]*\)/g
  let match
  while ((match = inlineLinkRegex.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }

  // Match [text][ref] — reference links
  const refLinkRegex = /\[(?:[^\[\]]|\\\[|\\\])*\]\[[^\]]*\]/g
  while ((match = refLinkRegex.exec(text)) !== null) {
    // Avoid duplicates with inline links that already matched
    const r = { start: match.index, end: match.index + match[0].length }
    const alreadyCovered = ranges.some(existing => rangesOverlap(existing, r))
    if (!alreadyCovered) {
      ranges.push(r)
    }
  }

  return ranges
}

/**
 * Check if a position falls inside any markdown link range
 */
function isInsideMarkdownLink(pos: number, ranges: CodeRange[]): boolean {
  return ranges.some(r => pos >= r.start && pos < r.end)
}

/**
 * Check if ranges overlap
 */
function rangesOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end
}

/**
 * Detect all links (URLs, emails, file paths) in text
 */
export function detectLinks(text: string): DetectedLink[] {
  const links: DetectedLink[] = []

  // 1. Detect URLs and emails with linkify-it
  const urlMatches = linkify.match(text) || []
  // linkify-it doesn't strip trailing asterisks from bold/italic markdown,
  // which causes broken links when URLs are wrapped like **url** or *url*
  // Note: _ and ~ are valid URL chars so we only strip *
  const trailingMarkdownRe = /\*+$/
  for (const match of urlMatches) {
    let matchText = match.text
    let matchUrl = match.url
    let matchEnd = match.lastIndex

    const stripped = matchText.replace(trailingMarkdownRe, '')
    if (stripped !== matchText) {
      const diff = matchText.length - stripped.length
      matchText = stripped
      matchUrl = matchUrl.replace(trailingMarkdownRe, '')
      matchEnd -= diff
    }

    links.push({
      type: match.schema === 'mailto:' ? 'email' : 'url',
      text: matchText,
      url: matchUrl,
      start: match.index,
      end: matchEnd
    })
  }

  // 2. Detect file paths with a linear scanner.
  for (const path of findFilePathCandidates(text)) {
    // Check for overlaps with URL matches (URLs take precedence)
    const overlapsUrl = links.some(link => rangesOverlap(path, link))
    if (overlapsUrl) continue
    links.push(path)
  }

  // Sort by position
  return links.sort((a, b) => a.start - b.start)
}

/**
 * Detect placeholder/fabricated URLs that the AI generated without knowing the real URL.
 * These are URLs like `https://github.com/...` or `https://example.com/...`
 * that should be stripped back to inline code instead of rendered as links.
 */
const PLACEHOLDER_URL_PATTERN = /\/\.\.\.(?:[)/\s#?]|$)/

/**
 * Check if a URL looks like a placeholder/fabricated URL.
 * Returns true for URLs containing path segments like `/...`
 */
export function isPlaceholderUrl(url: string): boolean {
  return PLACEHOLDER_URL_PATTERN.test(url)
}

/**
 * Strip markdown links with placeholder URLs back to plain text.
 * Converts `[text](https://github.com/...)` → `text`
 * Respects code blocks — links inside fenced or inline code are not touched.
 */
function stripPlaceholderLinks(text: string): string {
  const codeRanges = findCodeRanges(text)
  let result = ''
  let cursor = 0

  while (cursor < text.length) {
    const openingBracket = text.indexOf('[', cursor)
    if (openingBracket === -1) return result + text.slice(cursor)
    const closingBracket = text.indexOf(']', openingBracket + 1)
    if (closingBracket === -1 || text[closingBracket + 1] !== '(') {
      result += text.slice(cursor, openingBracket + 1)
      cursor = openingBracket + 1
      continue
    }
    const linkText = text.slice(openingBracket + 1, closingBracket)
    const closingParenthesis = text.indexOf(')', closingBracket + 2)
    if (linkText.includes('[') || linkText.includes(']') || closingParenthesis === -1) {
      result += text.slice(cursor, openingBracket + 1)
      cursor = openingBracket + 1
      continue
    }

    const url = text.slice(closingBracket + 2, closingParenthesis)
    const shouldStrip = !isInsideCode(openingBracket, codeRanges)
      && Boolean(linkText.trim())
      && isPlaceholderUrl(url)
    result += text.slice(cursor, openingBracket)
    result += shouldStrip ? linkText : text.slice(openingBracket, closingParenthesis + 1)
    cursor = closingParenthesis + 1
  }

  return result
}

/**
 * Preprocess text to convert raw URLs and file paths into markdown links
 * Skips code blocks and already-linked content
 */
export function preprocessLinks(text: string): string {
  // First pass: strip markdown links with placeholder/fabricated URLs
  // (e.g., AI-generated `[commit](https://github.com/...)` → `\`commit\``)
  text = stripPlaceholderLinks(text)

  // Quick check - if no potential links, return early
  if (!linkify.pretest(text) && findFilePathCandidates(text).length === 0) {
    return text
  }

  const codeRanges = findCodeRanges(text)
  const markdownLinkRanges = findMarkdownLinkRanges(text)
  const links = detectLinks(text)

  if (links.length === 0) return text

  // Build result, converting raw links to markdown links
  let result = ''
  let lastIndex = 0

  for (const link of links) {
    // Skip if inside code block
    if (isInsideCode(link.start, codeRanges)) continue

    // Skip if inside an existing markdown link (text or href portion)
    if (isInsideMarkdownLink(link.start, markdownLinkRanges)) continue

    // Add text before this link
    result += text.slice(lastIndex, link.start)

    // Convert to markdown link
    result += `[${link.text}](${link.url})`

    lastIndex = link.end
  }

  // Add remaining text
  result += text.slice(lastIndex)

  return result
}

/**
 * Test if text contains any detectable links
 * Useful for optimization - skip preprocessing if no links present
 */
export function hasLinks(text: string): boolean {
  return linkify.pretest(text) || findFilePathCandidates(text).length > 0
}

/**
 * Check whether a markdown anchor target should be treated as a local file path.
 * Used by click handlers to route local paths to onFileClick instead of onUrlClick.
 */
export function isFilePathTarget(target: string): boolean {
  const trimmed = target.trim()
  if (!trimmed || ['http:', 'https:', 'mailto:', 'ftp:', 'data:', 'file:'].some(scheme => (
    trimmed.toLowerCase().startsWith(scheme)
  ))) return false

  const candidates = findFilePathCandidates(trimmed)
  return candidates.length === 1 && candidates[0]?.start === 0 && candidates[0]?.end === trimmed.length
}
