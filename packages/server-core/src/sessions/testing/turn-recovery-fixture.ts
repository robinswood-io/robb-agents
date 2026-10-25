import type { Message } from "@craft-agent/core/types";
import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";



export const message = (
  id: string,
  role: Message['role'],
  options: Partial<Message> = {},
): Message => ({ id, role, content: id, timestamp: 1, ...options });


export const legacyRecovery = (anchor: string, attempt: string, timestamp: number): Message => message(
  `legacy-${attempt}-${timestamp}`,
  'user',
  {
    hidden: true,
    timestamp,
    content: `<automatic_turn_recovery original_user_message_id="${anchor}" attempt="${attempt}">\nLegacy host recovery.\n</automatic_turn_recovery>`,
  },
);


export const legacyTerminal = (timestamp: number): Message => message('legacy-terminal', 'error', {
  timestamp,
  errorCode: 'objective_validation_failed',
  errorCanRetry: true,
  errorDetails: ['legacy validation gap'],
});


export const terminalReconciliationObjective: ActiveSessionObjective = {
  schemaVersion: 1,
  objectiveId: 'objective-1',
  userMessageId: 'user-1',
  lastUserMessageId: 'reconciliation-1',
  terminalReconciliation: { messageId: 'reconciliation-1', timestamp: 2 },
  startedAt: 1,
  budgetBaselineUsd: 0,
  tokenBaseline: 0,
  continuationCount: 1,
  orchestrationMode: 'mission',
  risk: 'standard',
  completionCriteria: [
    'requested-outcome-delivered',
    'relevant-checks-passed',
    'no-safe-work-remaining',
  ],
  requiresAcceptanceCriteria: true,
  acceptanceCriteria: [{
    id: 'report-ready', description: 'Report is ready', toolName: 'Read',
    input: { path: 'report.json' }, checks: [{ path: 'ready', equals: true }],
  }],
  terminalState: 'active',
};


export const activeSafeContinuationObjective = (): ActiveSessionObjective => ({
  ...terminalReconciliationObjective,
  objectiveId: 'objective-continue',
  userMessageId: 'user-continue',
  lastUserMessageId: 'user-continue',
  terminalReconciliation: undefined,
  lastOutcome: {
    state: 'continue',
    criteria: [],
    remainingWork: ['Apply the remaining safe correction', 'Run final verification'],
    blocker: null,
  },
});
