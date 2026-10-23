import type { Message } from '@craft-agent/core/types';
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions';
import { objectiveReviewBinding } from '../objective-contract.ts';

/** A completed independent review envelope for positive contract/observation fixtures. */
export function scopeReviewFixture(objective: ActiveSessionObjective, messages: readonly Message[], verdict: 'PASS' | 'FAIL' = 'PASS'): Message {
  const receipt = {
    verdict, ...objectiveReviewBinding(objective),
    criteria: [...objective.completionCriteria.filter(id => id !== 'independent-review-passed'),
      ...(objective.acceptanceCriteria ?? []).map(criterion => criterion.id)].map(id => ({ id, passed: verdict === 'PASS' })),
    findings: verdict === 'PASS' ? [] : ['The original request contains an unfinished target absent from the supplied checks.'],
  };
  return {
    id: 'scope-review-result', role: 'tool', content: '', timestamp: Math.max(0, ...messages.map(message => message.timestamp)) + 1,
    toolName: 'mcp__session__wait_sessions', toolUseId: 'scope-review-call', toolStatus: 'completed', toolExecuted: true,
    toolInput: { sessionIds: ['scope-reviewer'] },
    toolResult: JSON.stringify({ outcome: 'completed', sessions: [{ sessionId: 'scope-reviewer', state: 'idle',
      reason: 'complete', finalText: JSON.stringify(receipt), finalTextTruncated: false, changed: true }] }),
  };
}

export function withScopeReview(objective: ActiveSessionObjective, messages: Message[]): Message[] {
  return [...messages, scopeReviewFixture(objective, messages)];
}
