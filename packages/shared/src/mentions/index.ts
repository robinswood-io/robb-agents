/**
 * Mention Parsing Utilities
 *
 * Pure string-parsing functions for [bracket] mentions in chat messages.
 * No renderer/browser dependencies — safe to use in any context.
 *
 * Mention types:
 * - Skills:  [skill:slug] or [skill:workspaceId:slug]
 * - Sources: [source:slug]
 * - Files:   [file:path]
 * - Folders: [folder:path]
 */

// Simple path join that works in both Node and browser contexts.
// Cannot use node:path here — this module is imported by the Vite renderer.
function joinPath(base: string, relative: string): string {
  const sep = base.includes('\\') ? '\\' : '/'
  return base.endsWith(sep) ? base + relative : base + sep + relative
}

export type MentionTokenType = 'skill' | 'source' | 'file' | 'folder'

export interface MentionToken {
  type: MentionTokenType
  value: string
  start: number
  end: number
}

function isMentionSlug(value: string): boolean {
  return value.length > 0 && [...value].every(character => (
    (character >= 'a' && character <= 'z')
    || (character >= 'A' && character <= 'Z')
    || (character >= '0' && character <= '9')
    || character === '_'
    || character === '-'
  ))
}

function isWorkspaceId(value: string): boolean {
  return value.length > 0 && [...value].every(character => (
    isMentionSlug(character) || character === ' ' || character === '.'
  ))
}

function parseBracketMention(content: string, start: number, end: number): MentionToken | null {
  const separator = content.indexOf(':')
  if (separator === -1) return null

  const type = content.slice(0, separator)
  const body = content.slice(separator + 1)
  if (type === 'source' && isMentionSlug(body)) return { type, value: body, start, end }
  if ((type === 'file' || type === 'folder') && body.length > 0) return { type, value: body, start, end }
  if (type !== 'skill') return null

  const workspaceSeparator = body.lastIndexOf(':')
  const slug = workspaceSeparator === -1 ? body : body.slice(workspaceSeparator + 1)
  const workspaceId = workspaceSeparator === -1 ? null : body.slice(0, workspaceSeparator)
  if (!isMentionSlug(slug)) return null
  if (workspaceId !== null && (!isWorkspaceId(workspaceId) || workspaceId.includes(':'))) return null
  return { type, value: slug, start, end }
}

export function findMentionTokens(text: string): MentionToken[] {
  const mentions: MentionToken[] = []
  let cursor = 0

  while (cursor < text.length) {
    const openingBracket = text.indexOf('[', cursor)
    if (openingBracket === -1) break
    const closingBracket = text.indexOf(']', openingBracket + 1)
    if (closingBracket === -1) break

    const mention = parseBracketMention(
      text.slice(openingBracket + 1, closingBracket),
      openingBracket,
      closingBracket + 1,
    )
    if (mention) {
      mentions.push(mention)
      cursor = closingBracket + 1
    } else {
      cursor = openingBracket + 1
    }
  }

  return mentions
}

function replaceBracketMentions(
  text: string,
  replace: (mention: MentionToken) => string | null,
): string {
  let result = ''
  let cursor = 0

  for (const mention of findMentionTokens(text)) {
    const replacement = replace(mention)
    if (replacement === null) continue
    result += text.slice(cursor, mention.start) + replacement
    cursor = mention.end
  }

  return result + text.slice(cursor)
}

// ============================================================================
// Constants
// ============================================================================

// Workspace ID character class for regex: word chars, spaces (NOT newlines), hyphens, dots
// Using literal space instead of \s to avoid matching newlines which would break parsing
export const WS_ID_CHARS = '[\\w .-]'

// ============================================================================
// Types
// ============================================================================

export interface ParsedMentions {
  /** Skill slugs mentioned via [skill:slug] */
  skills: string[]
  /** Invalid skill slugs mentioned but not found in availableSkillSlugs */
  invalidSkills: string[]
  /** Source slugs mentioned via [source:slug] */
  sources: string[]
  /** File paths mentioned via [file:path] */
  files: string[]
  /** Folder paths mentioned via [folder:path] */
  folders: string[]
}

// ============================================================================
// Parsing Functions
// ============================================================================

/**
 * Parse all mentions from message text
 *
 * @param text - The message text to parse
 * @param availableSkillSlugs - Valid skill slugs to match against
 * @param availableSourceSlugs - Valid source slugs to match against
 * @returns Parsed mentions by type
 *
 * @example
 * parseMentions('[skill:commit] [source:linear]', ['commit'], ['linear'])
 * // Returns: { skills: ['commit'], sources: ['linear'] }
 */
export function parseMentions(
  text: string,
  availableSkillSlugs: string[],
  availableSourceSlugs: string[]
): ParsedMentions {
  const result: ParsedMentions = {
    skills: [],
    invalidSkills: [],
    sources: [],
    files: [],
    folders: [],
  }

  for (const mention of findMentionTokens(text)) {
    if (mention.type === 'source') {
      if (availableSourceSlugs.includes(mention.value) && !result.sources.includes(mention.value)) {
        result.sources.push(mention.value)
      }
    } else if (mention.type === 'skill') {
      const target = availableSkillSlugs.includes(mention.value) ? result.skills : result.invalidSkills
      if (!target.includes(mention.value)) target.push(mention.value)
    } else if (mention.type === 'file' && !result.files.includes(mention.value)) {
      result.files.push(mention.value)
    } else if (mention.type === 'folder' && !result.folders.includes(mention.value)) {
      result.folders.push(mention.value)
    }
  }

  return result
}

/**
 * Strip all mentions from text, replacing skill/source mentions with their slug.
 *
 * @param text - The message text with mentions
 * @returns Text with skill/source mentions replaced by their slug
 *
 * @deprecated Prefer resolveSkillMentions + resolveSourceMentions for richer output.
 */
export function stripAllMentions(text: string): string {
  return replaceBracketMentions(text, mention => (
    mention.type === 'source' || mention.type === 'skill' ? mention.value : null
  ))
    // Note: [file:...] and [folder:...] are NOT stripped — they are content
    // that gets resolved to absolute paths by resolveFileMentions().
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Resolve skill mentions to semantic markers with display names.
 *
 * [skill:datadog-api]           → [Mentioned skill: Datadog API (slug: datadog-api)]
 * [skill:My Workspace:commit]   → [Mentioned skill: Git Commit (slug: commit)]
 *
 * Skills not found in the map fall back to the slug as display name.
 *
 * @param text - The message text with skill mentions
 * @param skillNames - Map of slug → display name (from loaded skill metadata)
 */
export function resolveSkillMentions(
  text: string,
  skillNames: Map<string, string>
): string {
  return replaceBracketMentions(text, mention => {
    if (mention.type !== 'skill') return null
    const name = skillNames.get(mention.value) || mention.value
    return `[Mentioned skill: ${name} (slug: ${mention.value})]`
  })
}

/**
 * Resolve source mentions to semantic markers.
 *
 * [source:github] → [Mentioned source: github]
 *
 * @param text - The message text with source mentions
 */
export function resolveSourceMentions(text: string): string {
  return replaceBracketMentions(text, mention => (
    mention.type === 'source' ? `[Mentioned source: ${mention.value}]` : null
  ))
}

/**
 * Resolve file and folder mentions to semantic markers with absolute paths.
 *
 * [file:src/index.ts]       → [Mentioned file: index.ts (at /Users/me/project/src/index.ts)]
 * [folder:src/components]   → [Mentioned folder: components (at /Users/me/project/src/components)]
 * [file:/tmp/test.txt]      → [Mentioned file: test.txt (at /tmp/test.txt)]
 *
 * The semantic wrapper signals to the agent that the user explicitly referenced
 * this file/folder and it should be proactively read. This matches the
 * [Attached file: ...] pattern used by drag-and-drop attachments.
 *
 * Leaves other mention types ([skill:...], [source:...]) untouched.
 */
export function resolveFileMentions(text: string, workingDirectory: string): string {
  return replaceBracketMentions(text, mention => {
    if (mention.type !== 'file' && mention.type !== 'folder') return null
    const resolved = mention.value.startsWith('/') || mention.value.startsWith('~')
      ? mention.value
      : joinPath(workingDirectory, mention.value)
    const name = mention.value.split('/').pop() || mention.value
    return `[Mentioned ${mention.type}: ${name} (at ${resolved})]`
  })
}
