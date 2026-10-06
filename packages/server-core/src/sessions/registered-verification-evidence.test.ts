import { describe, expect, it } from 'bun:test';
import type { Message, ObjectiveOutcomeDeclaration } from '@craft-agent/core/types';
import { transitionObjectiveContract } from './objective-contract.ts';
import { registerObjectiveAcceptanceCriteria } from './objective-acceptance-criteria.ts';
import { validateObjectiveOutcome } from './objective-outcome.ts';

describe('registered verification evidence for delivered decks and remote status reports', () => {
  const root: Message = { id: 'user', role: 'user', content: 'Prépare le livrable et vérifie le résultat.', timestamp: 1 };
  const commands = [
    "python3 '/tmp/session/data/verify_plc_deck.py'",
    "python3 '/tmp/session/data/verify_plc_render.py'",
    "ssh -i /home/operator/.ssh/id_ed25519 -o BatchMode=yes user@staging.example 'cd /srv/release-verification && python3 verify.py --scope live'",
  ];
  for (const command of commands) it(`uses the exact registered invocation: ${command.split(' ')[0]}`, () => {
    const objective = registerObjectiveAcceptanceCriteria(transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }), [{
      id: 'verified-result', description: 'The requested artifact or target passes its exact check', toolName: 'Bash',
      input: { command }, checks: [{ path: '$.passed', equals: true }],
    }], 2);
    const result: Message = { id: 'observation', toolUseId: 'tool-id', role: 'tool', content: '', timestamp: 4,
      toolStatus: 'completed', toolExecuted: true, toolName: 'Bash', toolInput: { command }, toolResult: '{"passed":true}' };
    const receipt: ObjectiveOutcomeDeclaration = { state: 'complete_verified', blocker: null, remainingWork: [],
      criteria: [...objective.completionCriteria.map(id => ({ id, satisfied: true,
        evidence: [id === 'relevant-checks-passed' ? result.id : 'assistant-final'] })),
      { id: 'verified-result', satisfied: true, evidence: [result.id] }],
    };
    const validate = (messages: Message[], obj = objective) => validateObjectiveOutcome(receipt, { objective: obj, messages });
    expect(validate([root, result]).valid).toBe(true);
    for (const changes of [
      { toolExecuted: false }, { isError: true }, { toolResult: '{"passed":false}' }, { timestamp: 0 },
      { toolInput: { command: command.replace('verify', 'verify_other') } },
      { toolInput: { command: command.replace('/srv/release-verification', '/srv/other-release') + ' --other-target' } },
      { toolInput: { command: command.replace('staging.example', 'other.example') + ' --other-target' } },
    ]) expect(validate([root, { ...result, ...changes }]).valid).toBe(false);
    expect(validate([root, result], { ...objective, acceptanceCriteria: [] }).valid).toBe(false);
    const mutation: Message = { ...result, id: 'write', toolUseId: 'write-id', timestamp: 5, toolName: 'Edit',
      toolInput: { file_path: '/tmp/target' }, toolResult: 'Changed target' };
    expect(validate([root, result, mutation]).valid).toBe(false);
    expect(validate([root, mutation, { ...result, timestamp: 6 }]).valid).toBe(true);
  });
});
