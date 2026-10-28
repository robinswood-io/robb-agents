import { isJsonObject, isUnknownArray, parseJsonObject } from '@craft-agent/shared/utils/json'

// ============================================================================
// Individual Tool Parsers
// ============================================================================

export interface ReadResult {
  content: string
  numLines?: number
  startLine?: number
  totalLines?: number
}

/**
 * Parse Read tool JSON result to extract file content and metadata.
 */
export function parseReadResult(rawContent: string): ReadResult {
  try {
    const parsed = parseJsonObject(rawContent)
    const file = parsed['file']
    if (isJsonObject(file) && typeof file['content'] === 'string') {
      return {
        content: file['content'],
        ...(typeof file['numLines'] === 'number' ? { numLines: file['numLines'] } : {}),
        ...(typeof file['startLine'] === 'number' ? { startLine: file['startLine'] } : {}),
        ...(typeof file['totalLines'] === 'number' ? { totalLines: file['totalLines'] } : {}),
      }
    }
  } catch {
    // Retain the original output when it is not a structured Read result.
  }
  return { content: rawContent }
}

export interface BashResult {
  output: string
  exitCode?: number
}

/**
 * Parse Bash tool JSON result to extract output and exit code.
 */
export function parseBashResult(rawContent: string): BashResult {
  try {
    const parsed = parseJsonObject(rawContent)
    if (typeof parsed['stdout'] === 'string' || typeof parsed['stderr'] === 'string') {
      const stdout = typeof parsed['stdout'] === 'string' ? parsed['stdout'] : ''
      const stderr = typeof parsed['stderr'] === 'string' ? parsed['stderr'] : ''
      const exitCode = parsed['interrupted'] === true ? 130 : parsed['exitCode']
      return {
        output: stdout + (stderr ? `\n${stderr}` : ''),
        ...(typeof exitCode === 'number' ? { exitCode } : {}),
      }
    }
  } catch {
    // Not JSON, try to extract exit code from text
    const exitMatch = rawContent.match(/Exit code: (\d+)/)
    if (exitMatch && exitMatch[1]) {
      return { output: rawContent, exitCode: parseInt(exitMatch[1], 10) }
    }
  }
  return { output: rawContent }
}

export interface GrepResult {
  output: string
  description: string
  command: string
}

/**
 * Parse Grep tool JSON result to extract search results.
 */
export function parseGrepResult(
  rawContent: string,
  pattern: string,
  searchPath: string,
  outputMode: string
): GrepResult {
  let output = rawContent
  let description = `Search for "${pattern}"`

  try {
    const parsed = parseJsonObject(rawContent)
    if (typeof parsed['content'] === 'string') {
      output = parsed['content']
      if (typeof parsed['numFiles'] === 'number') {
        const lines = typeof parsed['numLines'] === 'number' ? parsed['numLines'] : 0
        description = `Search for "${pattern}" (${parsed['numFiles']} files, ${lines} lines)`
      }
    } else if (isUnknownArray(parsed['filenames']) && parsed['filenames'].every((name): name is string => typeof name === 'string')) {
      output = parsed['filenames'].join('\n')
      description = `Search for "${pattern}" (${parsed['filenames'].length} files)`
    }
  } catch {
    // Not JSON, use as plain text
  }

  const command = `grep "${pattern}" ${searchPath} --${outputMode}`
  return { output, description, command }
}

export interface GlobResult {
  output: string
  description: string
  command: string
}

/**
 * Parse Glob tool JSON result to extract file list.
 */
export function parseGlobResult(
  rawContent: string,
  pattern: string,
  searchPath: string
): GlobResult {
  let output = rawContent
  let description = `Find files matching "${pattern}"`

  try {
    const parsed: unknown = JSON.parse(rawContent)
    if (isJsonObject(parsed) && isUnknownArray(parsed['filenames']) && parsed['filenames'].every((name): name is string => typeof name === 'string')) {
      output = parsed['filenames'].join('\n')
      const truncated = parsed['truncated'] === true ? ' (truncated)' : ''
      const count = typeof parsed['numFiles'] === 'number' ? parsed['numFiles'] : parsed['filenames'].length
      description = `Find files matching "${pattern}" (${count} files${truncated})`
    } else if (isUnknownArray(parsed) && parsed.every((name): name is string => typeof name === 'string')) {
      output = parsed.join('\n')
      description = `Find files matching "${pattern}" (${parsed.length} matches)`
    }
  } catch {
    // Not JSON, use as plain text
  }

  const command = `glob "${pattern}" in ${searchPath}`
  return { output, description, command }
}

/**
 * Parse WebSearch tool result to format embedded JSON links properly.
 * Converts raw JSON arrays in "Links: [...]" to formatted markdown lists.
 * Handles multiple Links sections in a single result.
 */
export function parseWebSearchResult(rawContent: string): string {
  let result = ''
  let cursor = 0
  const marker = 'Links: '

  while (cursor < rawContent.length) {
    const markerIndex = rawContent.indexOf(marker, cursor)
    if (markerIndex === -1) return result + rawContent.slice(cursor)
    const arrayStart = markerIndex + marker.length
    if (rawContent[arrayStart] !== '[') {
      result += rawContent.slice(cursor, arrayStart)
      cursor = arrayStart
      continue
    }

    const arrayEnd = findJsonArrayEnd(rawContent, arrayStart)
    if (arrayEnd === -1 || (rawContent[arrayEnd] !== '\n' && arrayEnd !== rawContent.length)) {
      result += rawContent.slice(cursor, arrayStart + 1)
      cursor = arrayStart + 1
      continue
    }

    const jsonArray = rawContent.slice(arrayStart, arrayEnd)
    let replacement: string
    try {
      const parsed: unknown = JSON.parse(jsonArray)
      if (!isWebSearchLinkArray(parsed)) throw new Error('Invalid links payload')

      // Format as markdown list with domain prefix
      const linksList = parsed.map(link => {
        const domain = new URL(link.url).hostname.replace(/^www\./, '')
        return `- [${domain} - ${link.title}](${link.url})`
      }).join('\n')

      replacement = `**Links:**\n${linksList}`
    } catch {
      // If JSON parsing fails, wrap in code block instead
      replacement = `Links:\n\`\`\`json\n${jsonArray}\n\`\`\``
    }

    result += rawContent.slice(cursor, markerIndex) + replacement
    cursor = arrayEnd
  }

  return result
}

function findJsonArrayEnd(value: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < value.length; index += 1) {
    const character = value[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '[') depth += 1
    else if (character === ']') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }

  return -1
}

function isWebSearchLinkArray(value: unknown): value is Array<{ title: string; url: string }> {
  return isUnknownArray(value) && value.every(link => (
    isJsonObject(link)
    && typeof link['title'] === 'string'
    && typeof link['url'] === 'string'
  ))
}
