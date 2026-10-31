/**
 * Automation UI Types
 *
 * UI-specific types for the automations components.
 *
 * ARCHITECTURE NOTE: These types are mirrored from packages/shared/src/automations/types.ts.
 * The renderer runs in a browser context and CANNOT import from @craft-agent/shared,
 * which uses Node.js APIs (crypto, fs, etc.). Additionally, the automations package is not
 * exported as a package entry point. These types must be manually kept in sync.
 * See apps/electron/CLAUDE.md "Common Mistake: Node.js APIs in Renderer".
 */
import { computeNextRuns } from "../utils";
import { DEFAULT_WEBHOOK_METHOD } from "../constants";
import type { AutomationAction, AutomationListItem, AutomationTrigger, AutomationsConfigFile, AutomationsConfigMatcher } from './contracts.ts';
import { AGENT_EVENTS, APP_EVENTS } from './contracts.ts';
import { getEventDisplayName } from './display.ts';

/** Derive a human-readable name from task actions and event */
function deriveAutomationName(event: string, matcher: AutomationsConfigMatcher): string {
  if (matcher.name) return matcher.name
  const allActions = matcher.actions ?? []
  const firstAction = allActions[0]
  if (!firstAction) return getEventDisplayName(event as AutomationTrigger)

  if (firstAction.type === 'webhook') {
    const label = `Webhook ${firstAction.method ?? DEFAULT_WEBHOOK_METHOD} ${firstAction.url}`
    return label.length > 40 ? label.slice(0, 40) + '...' : label
  }

  // Extract @skill mentions or use first ~40 chars
  const mentionMatch = firstAction.prompt.match(/@(\S+)/)
  if (mentionMatch) return `${mentionMatch[1]} prompt`
  return firstAction.prompt.length > 40
    ? firstAction.prompt.slice(0, 40) + '...'
    : firstAction.prompt
}

/** Derive a summary line from the matcher/cron/event */
function deriveAutomationSummary(event: string, matcher: AutomationsConfigMatcher): string {
  if (matcher.cron) {
    const runs = computeNextRuns(matcher.cron, 1)
    if (runs.length > 0) {
      const next = runs[0]!
      const tz = matcher.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
      const tzCity = tz.split('/').pop()?.replace(/_/g, ' ') ?? tz
      const formatted = next.toLocaleString('en-US', {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: tz,
      })
      return `Next run: ${formatted} (${tzCity})`
    }
    const tz = matcher.timezone ? ` (${matcher.timezone})` : ''
    return `Cron: ${matcher.cron}${tz}`
  }
  if (matcher.matcher) {
    return `Matches: ${matcher.matcher}`
  }
  return `On ${getEventDisplayName(event as AutomationTrigger)}`
}

/**
 * Parse an automations.json file into a flat list of AutomationListItem[].
 * Each matcher entry under each event becomes one item.
 */
export function parseAutomationsConfig(json: unknown): AutomationListItem[] {
  if (!json || typeof json !== 'object') return []
  const config = json as AutomationsConfigFile
  const eventMap = config.automations
  if (!eventMap || typeof eventMap !== 'object') return []

  const allEvents = [...APP_EVENTS, ...AGENT_EVENTS] as string[]
  const items: AutomationListItem[] = []
  let index = 0

  for (const [eventName, matchers] of Object.entries(eventMap)) {
    if (!Array.isArray(matchers)) continue
    const event = (allEvents.includes(eventName) ? eventName : eventName) as AutomationTrigger

    for (const [matcherIdx, matcher] of matchers.entries()) {
      const rawActions = matcher.actions
      if (!rawActions || !Array.isArray(rawActions) || rawActions.length === 0) continue

      const actions: AutomationAction[] = rawActions
        .filter((a): a is AutomationAction => a.type === 'prompt' || a.type === 'webhook')
      if (actions.length === 0) continue

      const rawTopic = (matcher as { telegramTopic?: unknown }).telegramTopic
      const telegramTopic =
        typeof rawTopic === 'string' && rawTopic.trim().length > 0 ? rawTopic.trim() : undefined

      items.push({
        id: matcher.id ?? `${eventName}-${index}`,
        event,
        matcherIndex: matcherIdx,
        name: deriveAutomationName(eventName, matcher),
        summary: deriveAutomationSummary(eventName, matcher),
        enabled: matcher.enabled !== false,
        ...(matcher.matcher !== undefined ? { matcher: matcher.matcher } : {}),
        ...(matcher.cron !== undefined ? { cron: matcher.cron } : {}),
        ...(matcher.timezone !== undefined ? { timezone: matcher.timezone } : {}),
        ...(matcher.permissionMode !== undefined ? { permissionMode: matcher.permissionMode } : {}),
        ...(matcher.labels !== undefined ? { labels: matcher.labels } : {}),
        ...(matcher.conditions !== undefined ? { conditions: matcher.conditions } : {}),
        actions,
        ...(telegramTopic !== undefined ? { telegramTopic: telegramTopic } : {}),
      })
      index++
    }
  }

  return items
}
