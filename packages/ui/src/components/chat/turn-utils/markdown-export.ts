import i18n from "i18next";
import type { ActivityItem } from "../TurnCard";
import { getActivitySummary } from './turn-summary.ts';
import type { AssistantTurn } from './turn-types.ts';

/**
 * Format an AssistantTurn as markdown for detailed viewing in Monaco
 * Shows full tool inputs, results, and response
 */
export function formatTurnAsMarkdown(turn: AssistantTurn): string {
  const lines: string[] = []

  // Header with intent if available
  if (turn.intent) {
    lines.push(`# ${turn.intent}`)
  } else {
    lines.push('# Turn Details')
  }
  lines.push('')

  // Summary
  const summary = getActivitySummary(turn)
  lines.push(`**Status:** ${turn.isComplete ? 'Complete' : 'In Progress'} · ${summary}`)
  lines.push('')

  // Activities section
  if (turn.activities.length > 0) {
    lines.push('---')
    lines.push('')
    lines.push('## Activities')
    lines.push('')

    for (const activity of turn.activities) {
      if (activity.type === 'intermediate') {
        // Intermediate text (thinking/commentary)
        lines.push(`### 💭 Commentary`)
        lines.push('')
        if (activity.content) {
          lines.push(activity.content)
        }
        lines.push('')
      } else if (activity.toolName) {
        // Tool call
        const statusEmoji = activity.status === 'completed' ? '✅' :
                           activity.status === 'error' ? '❌' :
                           activity.status === 'running' ? '⏳' : '⏸️'

        lines.push(`### ${statusEmoji} ${activity.toolName}`)
        lines.push('')

        // Intent if available
        if (activity.intent) {
          lines.push(`> ${activity.intent}`)
          lines.push('')
        }

        if (activity.status === 'checkpoint') {
          lines.push(`**Execution:** ${i18n.t('turnCard.notExecutedAutoResume')}`)
          lines.push('')
        }

        // Input
        if (activity.toolInput && Object.keys(activity.toolInput).length > 0) {
          lines.push('**Input:**')
          lines.push('```json')
          lines.push(JSON.stringify(activity.toolInput, null, 2))
          lines.push('```')
          lines.push('')
        }

        // Result/Output
        if (activity.content) {
          lines.push('**Result:**')
          // Check if result looks like JSON
          const trimmed = activity.content.trim()
          if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
              const parsed = JSON.parse(trimmed)
              lines.push('```json')
              lines.push(JSON.stringify(parsed, null, 2))
              lines.push('```')
            } catch {
              // Not valid JSON, show as text
              lines.push('```')
              lines.push(activity.content)
              lines.push('```')
            }
          } else {
            lines.push('```')
            lines.push(activity.content)
            lines.push('```')
          }
          lines.push('')
        }

        // Error if present
        if (activity.error) {
          lines.push('**Error:**')
          lines.push('```')
          lines.push(activity.error)
          lines.push('```')
          lines.push('')
        }
      }
    }
  }

  // Response section
  if (turn.response?.text) {
    lines.push('---')
    lines.push('')
    lines.push('## Response')
    lines.push('')
    lines.push(turn.response.text)
  }

  return lines.join('\n')
}

/**
 * Format a single ActivityItem as markdown for detailed viewing in Monaco
 */
export function formatActivityAsMarkdown(activity: ActivityItem): string {
  const lines: string[] = []

  if (activity.type === 'intermediate') {
    // Commentary/thinking
    lines.push('# Commentary')
    lines.push('')
    if (activity.content) {
      lines.push(activity.content)
    }
    return lines.join('\n')
  }

  // Tool activity
  const statusEmoji = activity.status === 'completed' ? '✅' :
                     activity.status === 'error' ? '❌' :
                     activity.status === 'running' ? '⏳' : '⏸️'

  lines.push(`# ${statusEmoji} ${activity.toolName || 'Tool'}`)
  lines.push('')

  // Intent if available
  if (activity.intent) {
    lines.push(`> ${activity.intent}`)
    lines.push('')
  }

  if (activity.status === 'checkpoint') {
    lines.push(`**Execution:** ${i18n.t('turnCard.notExecutedAutoResume')}`)
    lines.push('')
  }

  // Input
  if (activity.toolInput && Object.keys(activity.toolInput).length > 0) {
    lines.push('## Input')
    lines.push('')
    lines.push('```json')
    lines.push(JSON.stringify(activity.toolInput, null, 2))
    lines.push('```')
    lines.push('')
  }

  // Result/Output
  if (activity.content) {
    lines.push('## Result')
    lines.push('')
    // Check if result looks like JSON
    const trimmed = activity.content.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed)
        lines.push('```json')
        lines.push(JSON.stringify(parsed, null, 2))
        lines.push('```')
      } catch {
        // Not valid JSON, show as text
        lines.push('```')
        lines.push(activity.content)
        lines.push('```')
      }
    } else {
      lines.push('```')
      lines.push(activity.content)
      lines.push('```')
    }
    lines.push('')
  }

  // Error if present
  if (activity.error) {
    lines.push('## Error')
    lines.push('')
    lines.push('```')
    lines.push(activity.error)
    lines.push('```')
  }

  return lines.join('\n')
}
