import type { Message } from '@craft-agent/core/types';
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions';
import { objectiveReviewBinding } from '../objective-contract.ts';

/** Synthetic read-only reviewer receipt; no provider or target is executed. */
export function scopeReviewFixture(objective: ActiveSessionObjective, messages: readonly Message[], id = 'scope-review'): Message {
  const ids = [...new Set([...objective.completionCriteria,
    ...(objective.acceptanceCriteria ?? []).map(criterion => criterion.id)])];
  return { id, toolUseId: id, role: 'tool', content: '', toolName: 'mcp__session__wait_sessions',
    toolInput: { sessionIds: [`${id}-reviewer`] },
    toolStatus: 'completed', toolExecuted: true, isError: false,
    timestamp: Math.max(objective.acceptanceRegisteredAt ?? 0, ...messages.map(message => message.timestamp)) + 1,
    toolResult: JSON.stringify({ outcome: 'completed', sessions: [{
      sessionId: `${id}-reviewer`, state: 'idle', reason: 'complete', objectiveState: 'complete_verified',
      finalMessageId: `${id}-reviewer-final`,
      finalText: JSON.stringify({ verdict: 'PASS', ...objectiveReviewBinding(objective), findings: [],
        criteria: ids.map(id => ({ id, passed: true })) }),
    }] }),
  };
}
