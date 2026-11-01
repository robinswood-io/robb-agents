import type { PermissionMode } from "../../../../shared/types";
import type { ThinkingLevel } from "@craft-agent/shared/agent/thinking-levels";

// ============================================================================
// Automation System Types (mirrored from packages/shared/src/automations/types.ts)
// ============================================================================

export type AppEvent =
  | 'LabelAdd'
  | 'LabelRemove'
  | 'LabelConfigChange'
  | 'PermissionModeChange'
  | 'FlagChange'
  | 'TodoStateChange'
  | 'SessionStatusChange'
  | 'SchedulerTick'

export type AgentEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Notification'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PermissionRequest'
  | 'Setup'

export type AutomationTrigger = AppEvent | AgentEvent

export const APP_EVENTS: AppEvent[] = [
  'LabelAdd', 'LabelRemove', 'LabelConfigChange',
  'PermissionModeChange', 'FlagChange', 'TodoStateChange', 'SessionStatusChange', 'SchedulerTick'
]

export const AGENT_EVENTS: AgentEvent[] = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification',
  'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Stop',
  'SubagentStart', 'SubagentStop', 'PreCompact', 'PermissionRequest', 'Setup'
]

export interface PromptAction {
  type: 'prompt'
  prompt: string
  /** LLM connection slug override for the spawned session */
  llmConnection?: string
  /** Model ID override for the spawned session */
  model?: string
  /** Thinking level override for the spawned session */
  thinkingLevel?: ThinkingLevel
}

export interface WebhookAction {
  type: 'webhook'
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  headers?: Record<string, string>
  bodyFormat?: 'json' | 'form' | 'raw'
  body?: unknown
  captureResponse?: boolean
  auth?: { type: 'basic'; username: string; password: string } | { type: 'bearer'; token: string }
}

export type AutomationAction = PromptAction | WebhookAction

// ============================================================================
// Conditions (mirrored from packages/shared/src/automations/types.ts)
// ============================================================================

export interface TimeConditionUI {
  condition: 'time'
  after?: string
  before?: string
  weekday?: string[]
  timezone?: string
}

export interface StateConditionUI {
  condition: 'state'
  field: string
  value?: unknown
  from?: unknown
  to?: unknown
  contains?: string
  not_value?: unknown
}

export interface LogicalConditionUI {
  condition: 'and' | 'or' | 'not'
  conditions: AutomationConditionUI[]
}

export type AutomationConditionUI = TimeConditionUI | StateConditionUI | LogicalConditionUI

// ============================================================================
// List Item (flattened from automations.json for display)
// ============================================================================

export interface AutomationListItem {
  /** Stable 6-char hex ID from automations.json, with fallback to event+index for legacy configs */
  id: string
  /** The event this automation listens to */
  event: AutomationTrigger
  /** Index of this matcher within its event array in automations.json (for write-back) */
  matcherIndex: number
  /** Display name (user-set or auto-derived) */
  name: string
  /** Human-readable summary */
  summary: string
  /** Whether this automation is enabled */
  enabled: boolean
  /** Regex matcher (if any) */
  matcher?: string
  /** Cron expression (SchedulerTick only) */
  cron?: string
  /** IANA timezone for cron */
  timezone?: string
  /** Permission mode */
  permissionMode?: PermissionMode
  /** Labels for prompt sessions */
  labels?: string[]
  /** Conditions that must pass before actions run */
  conditions?: AutomationConditionUI[]
  /** The actions this automation performs */
  actions: AutomationAction[]
  /**
   * Optional Telegram forum-topic name. When set, sessions spawned by this
   * matcher are bound to a topic of this name in the workspace's paired
   * supergroup (created on first use).
   */
  telegramTopic?: string
  /** Timestamp of last execution (ms since epoch) */
  lastExecutedAt?: number
}

// ============================================================================
// Filter
// ============================================================================

export type AutomationFilterKind = 'all' | 'app' | 'agent' | 'scheduled'

export interface AutomationListFilter {
  kind: AutomationFilterKind
}

/** Maps task type (from route) to AutomationFilterKind for the list panel */
export const AUTOMATION_TYPE_TO_FILTER_KIND: Record<string, AutomationFilterKind> = {
  scheduled: 'scheduled',
  event: 'app',
  agentic: 'agent',
}

// ============================================================================
// Execution History
// ============================================================================

export type ExecutionStatus = 'success' | 'error' | 'blocked'

export interface WebhookDetails {
  method: string
  url: string
  statusCode: number
  durationMs: number
  attempts?: number
  error?: string
  responseBody?: string
}

export interface ExecutionEntry {
  id: string
  automationId: string
  event: AutomationTrigger
  status: ExecutionStatus
  /** Duration in milliseconds */
  duration: number
  /** Timestamp in ms since epoch */
  timestamp: number
  /** Error message (if status === 'error') */
  error?: string
  /** Truncated action summary */
  actionSummary?: string
  /** Session ID created by this execution (for deep linking) */
  sessionId?: string
  /** Structured webhook execution details (expandable in timeline) */
  webhookDetails?: WebhookDetails
}

// ============================================================================
// Test Panel
// ============================================================================

export type TestState = 'idle' | 'running' | 'success' | 'error'

export interface TestResult {
  state: TestState
  stderr?: string
  duration?: number
}

// ============================================================================
// automations.json Parser
// ============================================================================

/** Raw automations.json file structure */
export interface AutomationsConfigFile {
  version: number
  automations?: Record<string, AutomationsConfigMatcher[]>
}

type RawAction =
  | { type: 'prompt'; prompt: string; llmConnection?: string; model?: string; thinkingLevel?: ThinkingLevel }
  | { type: 'webhook'; url: string; method?: string; headers?: Record<string, string>; bodyFormat?: 'json' | 'form' | 'raw'; body?: unknown; captureResponse?: boolean; auth?: WebhookAction['auth'] }

export interface AutomationsConfigMatcher {
  id?: string
  name?: string
  matcher?: string
  cron?: string
  timezone?: string
  permissionMode?: PermissionMode
  labels?: string[]
  conditions?: AutomationConditionUI[]
  enabled?: boolean
  actions?: RawAction[]
}
