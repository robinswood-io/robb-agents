/** Separate UI automation contracts, condition labels, event presentation and configuration parsing. */
export type { AppEvent, AgentEvent, AutomationTrigger, PromptAction, WebhookAction, AutomationAction, TimeConditionUI, StateConditionUI, LogicalConditionUI, AutomationConditionUI, AutomationListItem, AutomationFilterKind, AutomationListFilter, ExecutionStatus, WebhookDetails, ExecutionEntry, TestState, TestResult } from './types/contracts.ts';
export { APP_EVENTS, AGENT_EVENTS, AUTOMATION_TYPE_TO_FILTER_KIND } from './types/contracts.ts';
export { flattenConditions } from './types/conditions.ts';
export type { EventCategory } from './types/display.ts';
export { EVENT_DISPLAY_NAMES, getEventDisplayName, PERMISSION_DISPLAY_NAMES, getPermissionDisplayName, getEventCategory } from './types/display.ts';
export { parseAutomationsConfig } from './types/config-parser.ts';
