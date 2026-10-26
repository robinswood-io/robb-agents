import { findMentionMatches } from '@/lib/mentions';
import { getSourceIconSync, getSkillIconSync, EMOJI_ICON_PREFIX } from '@/lib/icon-cache';
import type { LoadedSkill, LoadedSource } from "../../../shared/types";
import type { MentionItemType } from "./mention-menu";


// ============================================================================
// InlineMentionBadge - Compact badge for inline display (static HTML version)
// ============================================================================

// SVG icons as HTML strings (avoiding react-dom/server which doesn't work in browser)
export const SKILL_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>`


export const SOURCE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>`


// File icon (document with folded corner) - matches UserMessageBubble style (12x12, text-muted-foreground)
export const FILE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-muted-foreground"><path d="M10.5 2.5C12.1569 2.5 13.5 3.84315 13.5 5.5V6.1C13.5 6.4716 13.5 6.6574 13.5246 6.81287C13.6602 7.66865 14.3313 8.33983 15.1871 8.47538C15.3426 8.5 15.5284 8.5 15.9 8.5H16.5C18.1569 8.5 19.5 9.84315 19.5 11.5M9 16H15M9 12H10M10.9645 2.5H10.6678C8.64635 2.5 7.63561 2.5 6.84835 2.85692C5.96507 3.25736 5.25736 3.96507 4.85692 4.84835C4.5 5.63561 4.5 6.64635 4.5 8.66781V14C4.5 17.2875 4.5 18.9312 5.40796 20.0376C5.57418 20.2401 5.75989 20.4258 5.96243 20.592C7.06878 21.5 8.71252 21.5 12 21.5C15.2875 21.5 16.9312 21.5 18.0376 20.592C18.2401 20.4258 18.4258 20.2401 18.592 20.0376C19.5 18.9312 19.5 17.2875 19.5 14V11.0355C19.5 10.0027 19.5 9.48628 19.4176 8.99414C19.2671 8.09576 18.9141 7.24342 18.3852 6.50177C18.0955 6.09549 17.7303 5.73032 17 5C16.2697 4.26968 15.9045 3.90451 15.4982 3.6148C14.7566 3.08595 13.9042 2.7329 13.0059 2.58243C12.5137 2.5 11.9973 2.5 10.9645 2.5Z"/></svg>`


// Code file icon (document with < > brackets) - matches UserMessageBubble style (12x12, text-muted-foreground)
export const CODE_FILE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-muted-foreground"><path d="M10.5 2.5C12.1569 2.5 13.5 3.84315 13.5 5.5V6.1C13.5 6.4716 13.5 6.6574 13.5246 6.81287C13.6602 7.66865 14.3313 8.33983 15.1871 8.47538C15.3426 8.5 15.5284 8.5 15.9 8.5H16.5C18.1569 8.5 19.5 9.84315 19.5 11.5M10.5 12.8799C9.70024 13.2985 9.10807 13.8275 8.64232 14.5478C8.51063 14.7515 8.44479 14.8533 8.44489 15.0011C8.44498 15.1488 8.51099 15.2506 8.643 15.4542C9.1095 16.1736 9.70167 16.7028 10.5 17.1225M13.5 12.8799C14.2998 13.2985 14.8919 13.8275 15.3577 14.5478C15.4894 14.7515 15.5552 14.8533 15.5551 15.0011C15.555 15.1488 15.489 15.2506 15.357 15.4542C14.8905 16.1736 14.2983 16.7028 13.5 17.1225M10.9645 2.5H10.6678C8.64635 2.5 7.63561 2.5 6.84835 2.85692C5.96507 3.25736 5.25736 3.96507 4.85692 4.84835C4.5 5.63561 4.5 6.64635 4.5 8.66781V14C4.5 17.2875 4.5 18.9312 5.40796 20.0376C5.57418 20.2401 5.75989 20.4258 5.96243 20.592C7.06878 21.5 8.71252 21.5 12 21.5C15.2875 21.5 16.9312 21.5 18.0376 20.592C18.2401 20.4258 18.4258 20.2401 18.592 20.0376C19.5 18.9312 19.5 17.2875 19.5 14V11.0355C19.5 10.0027 19.5 9.48628 19.4176 8.99414C19.2671 8.09576 18.9141 7.24342 18.3852 6.50177C18.0955 6.09549 17.7303 5.73032 17 5C16.2697 4.26968 15.9045 3.90451 15.4982 3.6148C14.7566 3.08595 13.9042 2.7329 13.0059 2.58243C12.5137 2.5 11.9973 2.5 10.9645 2.5Z"/></svg>`


// Folder icon (open folder) - matches UserMessageBubble style (12x12, text-muted-foreground)
export const FOLDER_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" class="shrink-0 text-muted-foreground"><path d="M20.5 10C20.5 9.07003 20.5 8.60504 20.3978 8.22354C20.1204 7.18827 19.3117 6.37962 18.2765 6.10222C17.895 6 17.43 6 16.5 6H13.1008C12.4742 6 12.1609 6 11.8739 5.91181C11.6824 5.85298 11.5009 5.76572 11.3353 5.65295C11.0871 5.48389 10.8914 5.23926 10.5 4.75L10.4095 4.63693C10.107 4.25881 9.9558 4.06975 9.7736 3.92674C9.54464 3.74703 9.27921 3.61946 8.99585 3.55294C8.77037 3.5 8.52825 3.5 8.04402 3.5C6.60485 3.5 5.88527 3.5 5.32008 3.74178C4.61056 4.0453 4.0453 4.61056 3.74178 5.32008C3.5 5.88527 3.5 6.60485 3.5 8.04402V10M9.46502 20.5H14.535C16.9102 20.5 18.0978 20.5 18.9301 19.8113C19.7624 19.1226 19.9846 17.9559 20.429 15.6227L20.8217 13.5613C21.1358 11.9121 21.2929 11.0874 20.843 10.5437C20.393 10 19.5536 10 17.8746 10H6.12537C4.44643 10 3.60696 10 3.15704 10.5437C2.70713 11.0874 2.8642 11.9121 3.17835 13.5613L3.57099 15.6227C4.01541 17.9559 4.23763 19.1226 5.06992 19.8113C5.90221 20.5 7.08981 20.5 9.46502 20.5Z"/></svg>`


/** Known code file extensions - used to pick code file icon vs generic file icon */
export const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rs', 'go', 'java', 'rb', 'swift', 'kt',
  'c', 'cpp', 'h', 'hpp', 'cs',
  'css', 'scss', 'less', 'html', 'vue', 'svelte',
  'json', 'yaml', 'yml', 'toml', 'xml',
  'sh', 'bash', 'zsh', 'fish',
  'md', 'mdx',
  'sql', 'graphql', 'proto',
])


export function isCodeFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase()
  return ext ? CODE_EXTENSIONS.has(ext) : false
}


export function renderBadgeHTML(
  type: MentionItemType,
  label: string,
  skill?: LoadedSkill,
  source?: LoadedSource,
  workspaceId?: string,
  tooltip?: string
): string {
  // Try to get cached icon first
  let iconHtml = ''
  let cachedIconUrl: string | null = null

  if (type === 'skill' && skill && workspaceId) {
    cachedIconUrl = getSkillIconSync(workspaceId, skill.slug)
  } else if (type === 'source' && source && workspaceId) {
    cachedIconUrl = getSourceIconSync(workspaceId, source.config.slug)
  }

  if (cachedIconUrl) {
    // Check for emoji marker - render as text, not image
    if (cachedIconUrl.startsWith(EMOJI_ICON_PREFIX)) {
      const emoji = cachedIconUrl.slice(EMOJI_ICON_PREFIX.length)
      iconHtml = `<span class="h-[12px] w-[12px] flex items-center justify-center text-[10px] leading-none shrink-0">${emoji}</span>`
    } else {
      // Use cached icon as img (data URL or external URL)
      iconHtml = `<img src="${cachedIconUrl}" class="h-[12px] w-[12px] rounded-[2px] shrink-0" alt="" />`
    }
  } else {
    // Fall back to generic SVG icon based on type
    if (type === 'skill') {
      iconHtml = `<span class="h-[12px] w-[12px] rounded-[2px] bg-foreground/5 flex items-center justify-center text-foreground/50 shrink-0">${SKILL_ICON_SVG}</span>`
    } else if (type === 'source') {
      iconHtml = `<span class="h-[12px] w-[12px] rounded-[2px] bg-foreground/5 flex items-center justify-center text-foreground/50 shrink-0">${SOURCE_ICON_SVG}</span>`
    } else if (type === 'file') {
      // Pick code file or generic file icon based on extension (no container, icon carries its own classes)
      iconHtml = isCodeFile(label) ? CODE_FILE_ICON_SVG : FILE_ICON_SVG
    } else if (type === 'folder') {
      iconHtml = FOLDER_ICON_SVG
    }
  }

  const escapedLabel = label.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const titleAttr = tooltip ? ` title="${tooltip.replace(/"/g, '&quot;')}"` : ''

  // Line height is increased when badges are present (see hasMentions in component)
  // Use transform for upward shift - doesn't affect layout flow (works even at start of line)
  return `<span contenteditable="false" data-mention="true"${titleAttr} class="mention-badge inline-flex items-center gap-1 h-[22px] px-1.5 mx-1 rounded-[5px] bg-background shadow-minimal text-[12px] text-foreground select-none [&_*]:selection:bg-transparent selection:bg-transparent" style="vertical-align: middle; transform: translateY(-1px)">${iconHtml}<span class="truncate max-w-[200px]">${escapedLabel}</span></span>`
}


// ============================================================================
// Convert text with mentions to HTML
// ============================================================================

export function textToHTML(
  text: string,
  skills: LoadedSkill[],
  sources: LoadedSource[],
  workspaceId?: string
): string {
  if (!text) return ''

  const skillSlugs = skills.map(s => s.slug)
  const sourceSlugs = sources.map(s => s.config.slug)
  const matches = findMentionMatches(text, skillSlugs, sourceSlugs)

  // Escape HTML in text
  const escapeHTML = (str: string) => str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')

  if (matches.length === 0) {
    return escapeHTML(text)
  }

  let html = ''
  let lastIndex = 0

  // If first match starts at position 0, prepend zero-width space for contenteditable cursor fix
  if (matches[0].startIndex === 0) {
    html += '\u200B'
  }

  for (const match of matches) {
    // Add escaped text before this mention
    if (match.startIndex > lastIndex) {
      html += escapeHTML(text.slice(lastIndex, match.startIndex))
    }

    // Determine label and data for badge
    let label = match.id
    let skill: LoadedSkill | undefined
    let source: LoadedSource | undefined
    let tooltip: string | undefined

    if (match.type === 'skill') {
      skill = skills.find(s => s.slug === match.id)
      label = skill?.metadata.name || match.id
    } else if (match.type === 'source') {
      source = sources.find(s => s.config.slug === match.id)
      label = source?.config.name || match.id
    } else if (match.type === 'file') {
      // Show filename as badge label, full path as tooltip
      label = match.id.split('/').pop() || match.id
      tooltip = match.id
    } else if (match.type === 'folder') {
      // Show folder name as badge label, full path as tooltip
      label = match.id.split('/').pop() || match.id
      tooltip = match.id
    }

    // Render badge with data-mention-text storing the original text
    const badgeHtml = renderBadgeHTML(match.type, label, skill, source, workspaceId, tooltip)
    // Add data-mention-text attribute to store original text for extraction
    const withMentionText = badgeHtml.replace(
      'data-mention="true"',
      `data-mention="true" data-mention-text="${match.fullMatch.replace(/"/g, '&quot;')}"`
    )
    html += withMentionText
    // Zero-width space after badge ensures cursor can be placed after the last badge
    html += '\u200B'

    lastIndex = match.startIndex + match.fullMatch.length
  }

  // Add remaining text after last mention
  if (lastIndex < text.length) {
    html += escapeHTML(text.slice(lastIndex))
  }

  return html
}


// ============================================================================
// Check if mentions have changed (for determining if we need to re-render HTML)
// ============================================================================

export function getMentionSignature(text: string, skillSlugs: string[], sourceSlugs: string[]): string {
  const matches = findMentionMatches(text, skillSlugs, sourceSlugs)
  return matches.map(m => `${m.type}:${m.id}:${m.startIndex}`).join('|')
}
