import { type AutomationListItem, type ExecutionEntry, type TestResult } from "@/components/automations/types";

// ============================================================================
// Mock Data
// ============================================================================

const now = Date.now()

export const mockAutomations: AutomationListItem[] = [
  {
    id: 'automation-1',
    event: 'SchedulerTick',
    matcherIndex: 0,
    name: 'Daily Weather Report',
    summary: 'Weekdays at 9:00 AM',
    enabled: true,
    cron: '0 9 * * 1-5',
    timezone: 'Europe/Budapest',
    actions: [{ type: 'prompt', prompt: 'Run the @weather skill and give me today\'s forecast for Budapest' }],
    labels: ['Scheduled', 'weather'],
    permissionMode: 'safe',
    lastExecutedAt: now - 120_000, // 2 minutes ago
  },
  {
    id: 'automation-2',
    event: 'LabelAdd',
    matcherIndex: 0,
    name: 'Urgent Label Notification',
    summary: 'When "urgent" label is added',
    enabled: true,
    matcher: '^urgent$',
    actions: [{ type: 'prompt', prompt: 'Send a macOS notification: "Urgent task flagged!"' }],
    permissionMode: 'allow-all',
    lastExecutedAt: now - 300_000, // 5 minutes ago
  },
  {
    id: 'automation-3',
    event: 'PreToolUse',
    matcherIndex: 0,
    name: 'Git Pre-commit Check',
    summary: 'Before any Bash tool use',
    enabled: false,
    matcher: 'Bash',
    actions: [{ type: 'prompt', prompt: 'Run git diff --cached --check and report any issues' }],
    permissionMode: 'safe',
  },
  {
    id: 'automation-4',
    event: 'LabelAdd',
    matcherIndex: 1,
    name: 'Label Change Logger',
    summary: 'Logs all label additions',
    enabled: true,
    actions: [{ type: 'prompt', prompt: 'Log the label change: "$CRAFT_LABEL was added" to ~/label-log.txt' }],
    permissionMode: 'allow-all',
    lastExecutedAt: now - 3600_000, // 1 hour ago
  },
  {
    id: 'automation-5',
    event: 'SchedulerTick',
    matcherIndex: 1,
    name: 'Hourly Health Check',
    summary: 'Every hour',
    enabled: true,
    cron: '0 * * * *',
    actions: [
      { type: 'prompt', prompt: 'Check the health of https://api.example.com/health and report status' },
      { type: 'prompt', prompt: 'Analyze the health check result and alert if there are issues' },
    ],
    labels: ['Monitoring'],
    lastExecutedAt: now - 900_000, // 15 minutes ago
  },
  {
    id: 'automation-6',
    event: 'PostToolUse',
    matcherIndex: 0,
    name: 'Build Artifact Logger',
    summary: 'After Bash tool completes',
    enabled: true,
    matcher: 'Bash',
    actions: [{ type: 'prompt', prompt: 'Log that tool $TOOL_NAME completed to ~/build-log.txt' }],
    lastExecutedAt: now - 172800_000, // 2 days ago
  },
  {
    id: 'automation-7',
    event: 'SessionStart',
    matcherIndex: 0,
    name: 'Welcome Prompt',
    summary: 'Greet on new session',
    enabled: true,
    actions: [{ type: 'prompt', prompt: 'Welcome! Check if there are any pending @linear issues assigned to me.' }],
    labels: ['Onboarding'],
    lastExecutedAt: now - 7200_000, // 2 hours ago
  },
  {
    id: 'automation-8',
    event: 'PostToolUseFailure',
    matcherIndex: 0,
    name: 'Error Alert',
    summary: 'Notify on tool failures',
    enabled: true,
    actions: [{ type: 'prompt', prompt: 'Send an error notification: tool $TOOL_NAME failed' }],
    permissionMode: 'allow-all',
    lastExecutedAt: now - 86400_000, // 1 day ago
  },
  {
    id: 'automation-9',
    event: 'SessionStatusChange',
    matcherIndex: 0,
    name: 'Done after 9 AM (priority)',
    summary: 'When status → done, if after 9 AM and has priority label',
    enabled: true,
    matcher: '^done$',
    conditions: [
      { condition: 'time', after: '09:00', timezone: 'Europe/Budapest' },
      {
        condition: 'or',
        conditions: [
          { condition: 'state', field: 'labels', contains: 'priority' },
          { condition: 'state', field: 'labels', contains: 'invoices' },
        ],
      },
    ],
    actions: [{ type: 'prompt', prompt: 'Session $CRAFT_SESSION_NAME was marked as done. Summarise what was accomplished.' }],
    lastExecutedAt: now - 600_000,
  },
  {
    id: 'automation-10',
    event: 'SchedulerTick',
    matcherIndex: 2,
    name: 'Morning AI News (Weekdays)',
    summary: 'Daily at 9:00 AM, weekdays only',
    enabled: true,
    cron: '0 9 * * *',
    timezone: 'Europe/Budapest',
    conditions: [
      { condition: 'time', weekday: ['mon', 'tue', 'wed', 'thu', 'fri'], timezone: 'Europe/Budapest' },
    ],
    labels: ['Scheduled', 'ai-news'],
    actions: [{ type: 'prompt', prompt: 'Run the @ai-news skill and summarize today\'s AI developments' }],
    lastExecutedAt: now - 86400_000,
  },
]

export const mockExecutions: ExecutionEntry[] = [
  { id: 'ex-1', automationId: 'automation-1', event: 'SchedulerTick', status: 'success', duration: 42, timestamp: now - 120_000, actionSummary: 'prompt → @weather forecast' },
  { id: 'ex-2', automationId: 'automation-4', event: 'LabelAdd', status: 'success', duration: 8, timestamp: now - 300_000, actionSummary: 'echo "[...] Added: urgent"' },
  { id: 'ex-3', automationId: 'automation-5', event: 'SchedulerTick', status: 'error', duration: 1200, timestamp: now - 900_000, error: 'Connection refused' },
  { id: 'ex-4', automationId: 'automation-3', event: 'PreToolUse', status: 'blocked', duration: 0, timestamp: now - 3600_000, actionSummary: 'git diff --cached --check' },
  { id: 'ex-5', automationId: 'automation-1', event: 'SchedulerTick', status: 'success', duration: 38, timestamp: now - 86400_000, actionSummary: 'prompt → @weather forecast' },
  { id: 'ex-6', automationId: 'automation-6', event: 'PostToolUse', status: 'success', duration: 5, timestamp: now - 172800_000, actionSummary: 'echo "[...] Tool completed: Bash"' },
  // Webhook entries with expandable details
  {
    id: 'ex-7', automationId: 'automation-1', event: 'SessionStatusChange', status: 'success', duration: 45, timestamp: now - 60_000,
    actionSummary: 'Webhook POST http://localhost:8888/status-change',
    webhookDetails: { method: 'POST', url: 'http://localhost:8888/status-change', statusCode: 200, durationMs: 45, responseBody: '{"ok":true,"received":"status-change"}' },
  },
  {
    id: 'ex-8', automationId: 'automation-1', event: 'SessionStatusChange', status: 'error', duration: 3200, timestamp: now - 600_000,
    actionSummary: 'Webhook POST https://api.example.com/notify (2 attempts)',
    webhookDetails: { method: 'POST', url: 'https://api.example.com/notify', statusCode: 502, durationMs: 3200, attempts: 2, error: 'Bad Gateway' },
  },
  {
    id: 'ex-9', automationId: 'automation-1', event: 'LabelAdd', status: 'success', duration: 120, timestamp: now - 1800_000,
    actionSummary: 'Webhook PUT https://hooks.slack.com/services/T.../B.../xxx',
    webhookDetails: { method: 'PUT', url: 'https://hooks.slack.com/services/T.../B.../xxx', statusCode: 200, durationMs: 120, responseBody: 'ok' },
  },
]

export const mockWebhookExecutions: ExecutionEntry[] = mockExecutions.filter(e => !!e.webhookDetails)

export const testResultSuccess: TestResult = {
  state: 'success',
  duration: 42,
}

export const testResultError: TestResult = {
  state: 'error',
  stderr: 'Failed to create session: Connection refused',
  duration: 1200,
}

export const testResultRunning: TestResult = {
  state: 'running',
}
