import type { Message } from "@craft-agent/core/types";
import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";



export const objective: ActiveSessionObjective = {
  schemaVersion: 1,
  userMessageId: 'u1',
  startedAt: 1,
  budgetBaselineUsd: 0,
  tokenBaseline: 0,
  continuationCount: 0,
  orchestrationMode: 'mission',
  risk: 'standard',
  completionCriteria: ['requested-outcome-delivered', 'relevant-checks-passed', 'no-safe-work-remaining'],
  terminalState: 'active',
};


export const messages: Message[] = [
  { id: 'u1', role: 'user', content: 'Implémente puis vérifie.', timestamp: 1 },
  {
    id: 'tool-1', role: 'tool', content: '', timestamp: 2,
    toolName: 'Edit', toolUseId: 'edit-1', toolStatus: 'completed', toolExecuted: true,
    toolInput: { file_path: '/tmp/app.ts', new_string: 'fixed' }, toolResult: 'updated',
  },
  {
    id: 'tool-2', role: 'tool', content: '', timestamp: 3,
    toolName: 'Read', toolUseId: 'check-1', toolStatus: 'completed', toolExecuted: true,
    toolInput: { file_path: '/tmp/app.ts' }, toolResult: 'verified fixed content',
  },
];


export const activeAuthorizationExpiry = (startedAt: number): string => (
  new Date(startedAt + 60 * 60 * 1_000).toISOString()
);


export function receipt(overrides: Record<string, unknown> = {}) {
  return {
    state: 'complete_verified' as const,
    criteria: [
      { id: 'requested-outcome-delivered', satisfied: true, evidence: ['assistant-final'] },
      { id: 'relevant-checks-passed', satisfied: true, evidence: ['check-1'] },
      { id: 'no-safe-work-remaining', satisfied: true, evidence: ['assistant-final'] },
    ],
    remainingWork: [],
    blocker: null,
    ...overrides,
  };
}
