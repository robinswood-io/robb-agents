/**
 * Tool Result Parsers
 *
 * Shared utilities for parsing tool results from Claude Code SDK tools.
 * Used by both Electron and viewer apps for consistent overlay display.
 */
import type { ActivityItem } from "../../components/chat/TurnCard";
import { formatToolCommandPreview } from './command-preview.ts';
import type { OverlayCard, OverlayData } from './contracts.ts';
import { parseBashResult, parseGlobResult, parseGrepResult, parseReadResult, parseWebSearchResult } from './results.ts';

// ============================================================================
// Main Extraction Function
// ============================================================================

/**
 * Extract overlay data from an activity item.
 * Returns typed data for rendering the appropriate overlay component.
 */
export function extractOverlayData(activity: ActivityItem): OverlayData | null {
  if (!activity) return null

  const input = activity.toolInput as Record<string, unknown> | undefined
  const rawContent = activity.content || ''
  const toolName = activity.toolName?.toLowerCase() || ''

  // Get file path from various input formats
  const filePath = (input?.file_path as string) || (input?.path as string) || 'file'

  // Read tool → Code overlay (read mode)
  if (toolName === 'read') {
    const parsed = parseReadResult(rawContent)
    return {
      type: 'code',
      filePath,
      content: parsed.content,
      mode: 'read',
      startLine: parsed.startLine,
      totalLines: parsed.totalLines,
      numLines: parsed.numLines,
      error: activity.error,
      // Pass through command if present (Codex reads via shell commands)
      command: input?._command as string | undefined,
    }
  }

  // Write tool → Document overlay for .md/.txt (rendered markdown), Code overlay for everything else
  if (toolName === 'write') {
    const content = (input?.content as string) || rawContent
    const ext = filePath.split('.').pop()?.toLowerCase()
    if (ext === 'md' || ext === 'txt') {
      return {
        type: 'document',
        filePath,
        content,
        toolName: 'Write',
        error: activity.error,
      }
    }
    return {
      type: 'code',
      filePath,
      content,
      mode: 'write',
      error: activity.error,
    }
  }

  // Edit/Write tools are handled directly by the click handler (multi-diff overlay)
  // so they fall through to the generic handler if they reach here

  // Bash tool → Terminal overlay
  if (toolName === 'bash') {
    const parsed = parseBashResult(rawContent)
    return {
      type: 'terminal',
      command: (input?.command as string) || '',
      output: parsed.output,
      exitCode: parsed.exitCode,
      description: (input?.description as string) || activity.displayName || '',
      toolType: 'bash',
      error: activity.error,
    }
  }

  // Grep tool → Terminal overlay
  if (toolName === 'grep') {
    const pattern = (input?.pattern as string) || ''
    const searchPath = (input?.path as string) || '.'
    const outputMode = (input?.output_mode as string) || 'files_with_matches'
    const parsed = parseGrepResult(rawContent, pattern, searchPath, outputMode)
    return {
      type: 'terminal',
      command: parsed.command,
      output: parsed.output,
      description: parsed.description,
      toolType: 'grep',
      error: activity.error,
    }
  }

  // Glob tool → Terminal overlay
  if (toolName === 'glob') {
    const pattern = (input?.pattern as string) || '*'
    const searchPath = (input?.path as string) || '.'
    const parsed = parseGlobResult(rawContent, pattern, searchPath)
    return {
      type: 'terminal',
      command: parsed.command,
      output: parsed.output,
      description: parsed.description,
      toolType: 'glob',
      error: activity.error,
    }
  }

  // WebSearch tool → Document overlay with formatted links
  if (toolName === 'websearch') {
    const formattedContent = parseWebSearchResult(rawContent)
    return {
      type: 'document',
      filePath: 'Web Search Results',
      content: formattedContent,
      toolName: 'WebSearch',
      error: activity.error,
    }
  }

  // LLM Query tool (call_llm) → Document overlay with input prompt + output response
  if (toolName === 'mcp__session__call_llm') {
    const prompt = (input?.prompt as string) || ''
    const model = input?.model as string | undefined
    const systemPrompt = input?.systemPrompt as string | undefined
    const attachments = input?.attachments as unknown[] | undefined
    const outputFormat = input?.outputFormat as string | undefined
    const outputSchema = input?.outputSchema as Record<string, unknown> | undefined

    const sections: string[] = []

    // Input section
    sections.push('## Prompt')

    // Metadata (only show when present)
    const meta: string[] = []
    if (model) meta.push(`**Model:** ${model}`)
    if (systemPrompt) meta.push(`**System Prompt:** ${systemPrompt}`)
    if (outputFormat) meta.push(`**Output Format:** ${outputFormat}`)
    if (outputSchema) meta.push(`**Output Schema:**\n\`\`\`json\n${JSON.stringify(outputSchema, null, 2)}\n\`\`\``)
    if (attachments && attachments.length > 0) {
      const paths = attachments
        .map(a => typeof a === 'string' ? a : (a as { path: string }).path)
        .filter(Boolean)
      if (paths.length > 0) meta.push(`**Attachments:** ${paths.join(', ')}`)
    }
    if (meta.length > 0) {
      sections.push(meta.join('\n\n'))
    }

    sections.push(prompt)

    // Output section
    if (rawContent) {
      sections.push('---')
      sections.push('## Response')
      sections.push(rawContent)
    }

    return {
      type: 'document',
      content: sections.join('\n\n'),
      filePath: 'LLM Query',
      toolName: 'call_llm',
      error: activity.error,
    }
  }

  // Try to detect JSON content for unknown tools (MCP tools, WebFetch, etc.)
  // JSON objects/arrays get interactive tree viewer, other content falls through to generic
  const trimmedContent = rawContent.trim()
  if ((trimmedContent.startsWith('{') && trimmedContent.endsWith('}')) ||
      (trimmedContent.startsWith('[') && trimmedContent.endsWith(']'))) {
    try {
      const parsed = JSON.parse(trimmedContent)
      return {
        type: 'json',
        data: parsed,
        rawContent: trimmedContent,
        title: activity.displayName || activity.toolName || 'JSON Result',
        error: activity.error,
      }
    } catch {
      // Not valid JSON, fall through to generic
    }
  }

  // Fallback for unknown tools - plain text/markdown content
  return {
    type: 'generic',
    content: rawContent || (input ? JSON.stringify(input, null, 2) : ''),
    title: activity.displayName || activity.toolName || 'Activity',
    error: activity.error,
  }
}

/**
 * Extract one or more overlay cards from an activity.
 *
 * Current cards:
 * - Input: toolInput (when present)
 * - Output: parsed tool result/content (when meaningful)
 *
 * This intentionally returns an array to support future card types
 * without changing the overlay contract.
 */
export function extractOverlayCards(activity: ActivityItem): OverlayCard[] {
  if (!activity) return []

  const cards: OverlayCard[] = []
  const input = activity.toolInput as Record<string, unknown> | undefined
  const hasInput = !!input && Object.keys(input).length > 0

  // Input card (JSON-first, generic fallback)
  let inputJson = ''
  const commandPreview = formatToolCommandPreview(activity.toolName, input)
  if (hasInput) {
    try {
      inputJson = JSON.stringify(input, null, 2)
      cards.push({
        id: 'input',
        label: 'Input',
        commandPreview,
        data: {
          type: 'json',
          data: input,
          rawContent: inputJson,
          title: `${activity.displayName || activity.toolName || 'Tool'} Input`,
        },
      })
    } catch {
      cards.push({
        id: 'input',
        label: 'Input',
        commandPreview,
        data: {
          type: 'generic',
          content: String(input),
          title: `${activity.displayName || activity.toolName || 'Tool'} Input`,
        },
      })
    }
  }

  // Output card (always present for consistent Input/Output UX)
  const output = extractOverlayData(activity)
  const rawContent = (activity.content || '').trim()
  const isInputMirrorFallback =
    hasInput &&
    rawContent.length === 0 &&
    output?.type === 'generic' &&
    !!inputJson &&
    output.content.trim() === inputJson.trim()

  const outputData: OverlayData = isInputMirrorFallback
    ? {
        type: 'generic',
        content: 'No output captured for this tool call.',
        title: `${activity.displayName || activity.toolName || 'Tool'} Output`,
        error: activity.error,
      }
    : (output || {
      type: 'generic',
      content: rawContent || 'No output captured for this tool call.',
      title: `${activity.displayName || activity.toolName || 'Tool'} Output`,
      error: activity.error,
    })

  cards.push({
    id: 'output',
    label: 'Output',
    data: outputData,
  })

  // Last-resort fallback (kept for defensive safety)
  if (cards.length === 0) {
    cards.push({
      id: 'output',
      label: 'Output',
      data: {
        type: 'generic',
        content: 'No output captured for this tool call.',
        title: activity.displayName || activity.toolName || 'Activity',
        error: activity.error,
      },
    })
  }

  return cards
}
