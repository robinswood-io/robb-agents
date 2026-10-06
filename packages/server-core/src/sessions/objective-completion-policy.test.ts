import { describe, expect, it } from 'bun:test';
import type { Message, ObjectiveOutcomeDeclaration } from '@craft-agent/core/types';
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions';
import {
  buildObjectiveContractPrompt,
  projectLegacyObjectiveCompletionRequirements,
  transitionObjectiveContract,
} from './objective-contract.ts';
import { extractObjectiveOutcome, validateObjectiveOutcome } from './objective-outcome.ts';
import { classifyObjectiveTerminalState } from './turn-completion.ts';
import { requiresStructuredObjectiveOutcome } from './objective-completion-policy.ts';
import gantt from './__fixtures__/gantt-registered-outcome-20260909.json';

function terminal(objective: ActiveSessionObjective, messages: Message[], final: Message) {
  const extracted = extractObjectiveOutcome(final.content);
  const declaration = final.objectiveOutcome ?? extracted.declaration;
  const validation = validateObjectiveOutcome(declaration, { objective, messages, extractionError: extracted.error });
  return classifyObjectiveTerminalState(final.content, {
    structuredOutcomeRequired: requiresStructuredObjectiveOutcome(objective),
    ...(declaration || extracted.error ? { declaredState: validation.state, structuredOutcomeValid: validation.valid } : {}),
  });
}

describe('registered criteria always govern objective completion', () => {
  it('replays the actual Gantt conclusion without promoting its unparsed JSON comment', () => {
    for (const snapshot of [gantt, JSON.parse(JSON.stringify(gantt))]) {
      const objective = snapshot.objective as ActiveSessionObjective;
      expect(objective.orchestrationMode).toBe('direct');
      expect(objective.requiresExecutionEvidence).toBeUndefined();
      expect(objective.requiresObservationEvidence).toBeUndefined();
      expect(extractObjectiveOutcome(snapshot.final.content).declaration).toBeUndefined();
      expect(requiresStructuredObjectiveOutcome(objective)).toBe(true);
      expect(terminal(objective, [{ id: objective.userMessageId, role: 'user', content: objective.originalText!, timestamp: objective.startedAt }], snapshot.final as Message)).toBe('continue');
    }
  });

  it('preserves ordinary conversations while requiring every existing contract obligation', () => {
    const objective = transitionObjectiveContract({ messageId: 'chat', text: 'Merci pour la réponse.' });
    expect(requiresStructuredObjectiveOutcome(objective)).toBe(false);
    expect(requiresStructuredObjectiveOutcome({ ...objective, acceptanceCriteria: [] })).toBe(false);
    for (const obligation of [
      { orchestrationMode: 'mission' as const }, { requiresExecutionEvidence: true },
      { requiresObservationEvidence: true }, { requiresAcceptanceCriteria: true },
    ]) expect(requiresStructuredObjectiveOutcome({ ...objective, ...obligation })).toBe(true);
    expect(terminal(objective, [], { id: 'answer', role: 'assistant', content: 'Avec plaisir.', timestamp: 2 })).toBe('complete_verified');
  });

  it('teaches the same receipt contract in the prompt as the host requires at completion', () => {
    const prompt = buildObjectiveContractPrompt(gantt.objective as ActiveSessionObjective);
    expect(prompt).toContain('final robb_objective_outcome receipt');
    expect(prompt).toContain('Include all registered check IDs in the final receipt');
    expect(prompt).toContain('gantt-drag-commit-once');
    expect(prompt).toContain('never repeat an external action to repair formatting');
  });

  it.each([
    ['zero', 'Réactive le dev login Zero.'],
    ['silae', "Envoi l'e-mail à benoît"],
  ])('recovers the complete old-schema %s contract without rewriting persisted fields', (_name, text) => {
    const current = transitionObjectiveContract({ messageId: `legacy-${_name}`, text, nowMs: 1 });
    const legacy: ActiveSessionObjective = { ...current, orchestrationMode: 'direct' };
    delete legacy.requiresExecutionEvidence;
    delete legacy.requiresAcceptanceCriteria;
    delete legacy.acceptanceCriteria;
    delete legacy.originalText;
    const legacyMessages: Message[] = [
      { id: legacy.userMessageId, role: 'user', content: text, timestamp: 1 },
    ];

    const projected = projectLegacyObjectiveCompletionRequirements(legacy, text);
    expect(legacy.requiresExecutionEvidence).toBeUndefined();
    expect(legacy.requiresAcceptanceCriteria).toBeUndefined();
    expect(projected).not.toBe(legacy);
    expect(projected).toMatchObject({
      requiresExecutionEvidence: true,
      requiresAcceptanceCriteria: true,
    });
    expect(requiresStructuredObjectiveOutcome(projected)).toBe(true);

    const prompt = buildObjectiveContractPrompt(legacy, legacyMessages);
    expect(prompt).toContain('requires at least one registered target-bound acceptance check');
    expect(prompt).toContain('End every final response with exactly one concise machine-readable HTML comment');

    const declaration: ObjectiveOutcomeDeclaration = {
      state: 'complete_verified',
      criteria: projected.completionCriteria.map(id => ({ id, satisfied: true, evidence: ['assistant-final'] })),
      remainingWork: [],
      blocker: null,
    };
    const final: Message = { id: 'legacy-final', role: 'assistant', content: 'Terminé.', timestamp: 3, objectiveOutcome: declaration };
    const validation = validateObjectiveOutcome(declaration, {
      objective: projected,
      messages: [
        ...legacyMessages,
        final,
      ],
    });
    expect(validation.valid).toBe(false);
    expect(validation.gaps).toContain('Register target-bound acceptance checks with set_completion_criteria before claiming completion');
  });

  it('requires a real matching receipt and observation, without changing the objective or claiming an unobserved result', () => {
    const objective: ActiveSessionObjective = {
      ...transitionObjectiveContract({ messageId: 'status', text: 'Le déplacement reste lent.', nowMs: 1 }),
      acceptanceRegisteredAt: 2,
      acceptanceCriteria: [{ id: 'target-ready', description: 'The requested target is ready.', toolName: 'Read', input: { file_path: '/srv/check.json' }, checks: [{ path: '$.ready', equals: true }] }],
    };
    const observation: Message = { id: 'check', role: 'tool', content: '', timestamp: 3, toolName: 'Read', toolUseId: 'check-call', toolInput: { file_path: '/srv/check.json' }, toolResult: '{"ready":true}', toolExecuted: true, toolStatus: 'completed' };
    const declaration: ObjectiveOutcomeDeclaration = { state: 'complete_verified', criteria: [...objective.completionCriteria, 'target-ready'].map(id => ({ id, satisfied: true, evidence: ['check-call'] })), remainingWork: [], blocker: null };
    const final: Message = { id: 'final', role: 'assistant', content: 'Le résultat est vérifié.', timestamp: 4, objectiveOutcome: declaration };
    const messages: Message[] = [{ id: objective.userMessageId, role: 'user', content: objective.originalText!, timestamp: 1 }, observation, final];
    const before = structuredClone({ objective, messages });
    expect(terminal(objective, messages, { ...final, objectiveOutcome: undefined })).toBe('continue');
    expect(terminal(objective, messages, final)).toBe('complete_verified');
    for (const changes of [{ toolResult: '{"ready":false}' }, { toolExecuted: false }, { toolStatus: 'error' as const }, { toolInput: { file_path: '/srv/other.json' } }]) {
      expect(terminal(objective, [messages[0]!, { ...observation, ...changes }, final], final)).toBe('continue');
    }
    expect({ objective, messages }).toEqual(before);
  });
});
