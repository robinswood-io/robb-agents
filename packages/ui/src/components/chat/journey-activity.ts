import { AGENT_RUNTIME_ACTIVITY, isAgentRuntimeActivity, type Message } from '@craft-agent/core'
import type { TodoItem } from './TurnCard'

export interface JourneyActivity {
  title?: string
  detail?: string
  source?: 'plan' | 'commentary' | 'tool' | 'status'
  observedAt?: number
  completedSteps: number
  totalSteps: number
}

const PLAN_TOOL = /^(?:(?:functions\.)|mcp__session__|session__)?(?:TodoWrite|todo_write|update_plan)$/i
const COORDINATION_TOOL = /^(?:mcp__session__|session__)?(?:send_agent_message|spawn_session|wait_sessions|list_sessions|get_session_info|list_background_tasks)$/
const GENERIC_UPDATE = /^(?:(?:je\s+)?(?:continue|poursuis|travaille|vérifie)|(?:i(?:'m| am)?\s+)?(?:continuing|working|checking)|en cours|working on it|one moment|un instant)[.!…\s]*$/i
const COORDINATION_UPDATE = /\b(?:dispatch(?:ing|ed)?|spawn(?:ing|ed)?|delegat(?:e|ing|ed)|waiting (?:for|on)|retry(?:ing)?|reconnect(?:ing)?|rout(?:e|ing)|d[ée]l[èe]gu\w*|attend\w*|relanc\w*|reconnect\w*)\b.{0,80}\b(?:agents?|sessions?|transport|providers?|fournisseurs?|runtime|subprocess|sous-processus|MCP|tokens?)\b/i

/** Plain, bounded display text. Never read command arguments, results or payloads. */
export function safeActivityText(value: unknown, maxLength = 220): string | undefined {
  if (typeof value !== 'string') return undefined
  let text = value
    .replace(/-----BEGIN [^-]+-----[\s\S]*?(?:-----END [^-]+-----|$)/g, '•••')
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_\-.]+/gi, '•••')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16})\b/g, '•••')
    .replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '•••')
    .replace(/\bhttps?:\/\/[^\s<>]+/gi, url => {
      try { return new URL(url).hostname } catch { return '•••' }
    })
    .replace(/\bdata:[^\s]+/gi, '•••')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^[\s#>*-]+/gm, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // Protocol envelopes and serialized commands are not human progress updates.
  if (!text || /(?:host_objective_contract|objective_outcome|tool_use_id|"(?:command|arguments|tool_calls)"\s*:)/i.test(text)
    || /^(?:\{|\[|curl\s|sudo\s|export\s|bash\s|sh\s|powershell\s)/i.test(text)) return undefined
  if (text.length > maxLength) text = `${text.slice(0, maxLength - 1).trimEnd()}…`
  return text
}

function publicActivity(message: Message): boolean {
  return !message.hidden && !message.internalOrigin && !message.parentToolUseId
}

/** Describe only the current scoped transcript and its last confirmed plan. */
export function describeJourneyActivity(messages: Message[], steps: TodoItem[]): JourneyActivity {
  const counts = {
    completedSteps: steps.filter(step => step.status === 'completed').length,
    totalSteps: steps.length,
  }
  const ordered = [...messages].sort((a, b) => a.timestamp - b.timestamp)
  // An earlier response or accepted follow-up is a boundary: its commentary
  // and unfinished tool records cannot describe the next provider turn.
  let boundary = -1
  for (let index = ordered.length - 1; index >= 0; index--) {
    const message = ordered[index]!
    if (publicActivity(message) && (
      (message.role === 'user' && !message.isQueued && !message.isPending)
      || (message.role === 'assistant' && !message.isIntermediate && !message.isStreaming && !message.isPending)
    )) {
      boundary = index
      break
    }
  }
  const recent = ordered.slice(boundary + 1)
  let latest: Message | undefined
  for (let index = recent.length - 1; index >= 0; index--) {
    if (publicActivity(recent[index]!)) {
      latest = recent[index]
      break
    }
  }
  // Only host-owned fixed labels and the existing typed compaction status are
  // eligible. Arbitrary provider status strings remain out of user progress.
  const runtimeActivity = latest?.role === 'status'
    ? latest.statusType === 'compacting' ? AGENT_RUNTIME_ACTIVITY.preparingContext
      : isAgentRuntimeActivity(latest.content) ? latest.content : undefined
    : undefined
  const activeStep = steps.find(step => step.status === 'in_progress')
  const planText = activeStep && (safeActivityText(activeStep.activeForm) ?? safeActivityText(activeStep.content))
  let commentary: string | undefined
  let toolText: string | undefined
  let observedAt = 0
  for (const message of [...recent].reverse()) {
    if (!publicActivity(message)) continue
    if (!commentary && message.role === 'assistant' && message.isIntermediate
      && !message.isPending && !message.isStreaming) {
      const text = safeActivityText(message.content)
      if (text && !GENERIC_UPDATE.test(text) && !COORDINATION_UPDATE.test(text)) {
        commentary = text
        observedAt = Math.max(observedAt, message.timestamp)
      }
    }
    if (!commentary && message.role === 'tool' && PLAN_TOOL.test(message.toolName ?? '')
      && message.toolStatus === 'completed' && !message.isError && !message.toolCheckpoint
      && !message.isPending && !message.isStreaming
      && message.toolExecuted !== false && !!message.toolResult?.trim()) {
      commentary = safeActivityText(message.toolInput?.explanation)
      if (commentary) observedAt = Math.max(observedAt, message.timestamp)
    }
    if (!toolText && message.role === 'tool' && message.toolStatus === 'executing'
      && !message.isError && !message.toolCheckpoint && message.toolExecuted !== false
      && !PLAN_TOOL.test(message.toolName ?? '') && !COORDINATION_TOOL.test(message.toolName ?? '')) {
      toolText = safeActivityText(message.toolIntent)
        ?? safeActivityText(message.toolDisplayName)
        ?? safeActivityText(message.toolDisplayMeta?.displayName)
      if (toolText) observedAt = Math.max(observedAt, message.timestamp)
    }
    if (commentary && toolText) break
  }
  const title = commentary ?? planText ?? toolText ?? runtimeActivity
  const detail = commentary ? toolText ?? planText : planText ? toolText : undefined
  if (runtimeActivity && latest) observedAt = Math.max(observedAt, latest.timestamp)
  return {
    ...counts,
    ...(title ? { title, source: commentary ? 'commentary' as const : planText ? 'plan' as const : toolText ? 'tool' as const : 'status' as const } : {}),
    ...(detail && detail !== title ? { detail } : {}),
    ...(observedAt ? { observedAt } : {}),
  }
}
