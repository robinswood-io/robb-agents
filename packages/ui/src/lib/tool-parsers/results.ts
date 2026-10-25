
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
    const parsed = JSON.parse(rawContent)
    if (parsed.file) {
      return {
        content: parsed.file.content || '',
        numLines: parsed.file.numLines,
        startLine: parsed.file.startLine,
        totalLines: parsed.file.totalLines,
      }
    }
  } catch {
    // Not JSON, use as plain text
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
    const parsed = JSON.parse(rawContent)
    if (parsed.stdout !== undefined || parsed.stderr !== undefined) {
      const stdout = parsed.stdout || ''
      const stderr = parsed.stderr || ''
      return {
        output: stdout + (stderr ? `\n${stderr}` : ''),
        exitCode: parsed.interrupted ? 130 : parsed.exitCode,
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
    const parsed = JSON.parse(rawContent)
    if (parsed.content !== undefined) {
      output = parsed.content || ''
      if (parsed.numFiles !== undefined) {
        description = `Search for "${pattern}" (${parsed.numFiles} files, ${parsed.numLines || 0} lines)`
      }
    } else if (parsed.filenames) {
      // files_with_matches mode returns filenames array
      output = parsed.filenames.join('\n')
      description = `Search for "${pattern}" (${parsed.filenames.length} files)`
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
    const parsed = JSON.parse(rawContent)
    if (parsed.filenames && Array.isArray(parsed.filenames)) {
      // Standard Glob result format: { filenames: [...], numFiles, durationMs, truncated }
      output = parsed.filenames.join('\n')
      const truncated = parsed.truncated ? ' (truncated)' : ''
      description = `Find files matching "${pattern}" (${parsed.numFiles || parsed.filenames.length} files${truncated})`
    } else if (Array.isArray(parsed)) {
      // Simple array format
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
  return Array.isArray(value) && value.every(link => (
    typeof link === 'object'
    && link !== null
    && 'title' in link
    && typeof link.title === 'string'
    && 'url' in link
    && typeof link.url === 'string'
  ))
}
