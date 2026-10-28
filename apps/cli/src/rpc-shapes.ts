
// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export interface CliWorkspace {
  id: string
  name?: string
  rootPath?: string
  path?: string
}

export interface CliSkill { slug: string; name?: string }

export interface CliCreatedSource { slug?: string; config?: { slug: string } }

export interface CliAutomationTestResult {
  actions?: Array<{ success?: boolean; error?: string; statusCode?: number }>
}

interface CliWebhookHistoryEntry {
  ok: boolean
  ts: number
  webhook: { method: string; url?: string }
}

function isCliRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function requireListResponse(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected a list in the RPC response')
  return value
}

export function isWebhookHistoryEntry(value: unknown): value is CliWebhookHistoryEntry {
  return isCliRecord(value) && typeof value["ok"] === 'boolean' && typeof value["ts"] === 'number'
    && isCliRecord(value["webhook"]) && typeof value["webhook"]["method"] === 'string'
    && (value["webhook"]["url"] === undefined || typeof value["webhook"]["url"] === 'string')
}

export function cliMessageText(value: unknown): string {
  if (!isCliRecord(value)) return ''
  if (typeof value["content"] === 'string') return value["content"]
  if (!Array.isArray(value["content"])) return ''
  return value["content"].filter((block: unknown): block is { type: 'text'; text: string } =>
    isCliRecord(block) && block["type"] === 'text' && typeof block["text"] === 'string')
    .map(block => block.text).join(' ')
}

function isCliWorkspace(value: unknown): value is CliWorkspace {
  return isCliRecord(value) && typeof value['id'] === 'string' && value['id'].length > 0
    && ['name', 'rootPath', 'path'].every(key => !(key in value) || typeof value[key] === 'string')
}
export function requireWorkspaceResponse(value: unknown): CliWorkspace {
  if (!isCliWorkspace(value)) throw new Error('Invalid workspace in RPC response')
  return value
}
export function requireWorkspaceList(value: unknown): CliWorkspace[] {
  return requireListResponse(value).map(requireWorkspaceResponse)
}
