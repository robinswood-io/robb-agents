import type { Message, ObjectiveOutcomeDeclaration, ObjectiveAcceptanceCriterion } from "@craft-agent/core/types";
import { transitionObjectiveContract } from "../objective-contract.ts";
import { registerObjectiveAcceptanceCriteria } from "../objective-acceptance-criteria.ts";



export const criterion: ObjectiveAcceptanceCriterion = {
  id: 'timer-active', description: 'The authorized timer is active on the requested host',
  toolName: 'mcp__ops__get_timer', input: { host: 'dev', timer: 'cleanup' },
  checks: [{ path: 'enabled', equals: true }, { path: 'nextRunScheduled', equals: true }],
};

export const root: Message = { id: 'u1', role: 'user', content: 'Active et vérifie le minuteur.', timestamp: 1 };

export const objective = registerObjectiveAcceptanceCriteria(transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }), [criterion], 2);

export const observation: Message = {
  id: 'm1', toolUseId: 't1', role: 'tool', content: '', toolName: criterion.toolName,
  toolStatus: 'completed', toolExecuted: true, timestamp: 4,
  toolInput: { host: 'dev', timer: 'cleanup' }, toolResult: '{"enabled":true,"nextRunScheduled":true}',
};

export const receipt: ObjectiveOutcomeDeclaration = {
  state: 'complete_verified', blocker: null, remainingWork: [],
  criteria: [
    { id: 'timer-active', satisfied: true, evidence: ['t1'] },
    ...objective.completionCriteria.map(id => ({ id, satisfied: true, evidence: [id === 'relevant-checks-passed' ? 't1' : 'assistant-final'] })),
  ],
};
