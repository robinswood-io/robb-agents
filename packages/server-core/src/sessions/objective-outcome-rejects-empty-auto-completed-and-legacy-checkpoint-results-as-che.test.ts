import { describe, expect, it } from "bun:test";
import type { Message } from "@craft-agent/core/types";
import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { extractObjectiveOutcome, hasCurrentObjectiveIndependentReviewPass, validateObjectiveOutcome } from "./objective-outcome.ts";
import { objectiveReviewBinding } from "./objective-contract.ts";
import { messages, objective, receipt } from "./testing/objective-outcome-fixture.ts";

describe('objective outcome receipt', () => {
  const contentReview: Message = {
    id: 'content-review', role: 'tool', content: '', timestamp: 2,
    toolName: 'mcp__session__call_llm', toolUseId: 'content-review-1', toolStatus: 'completed',
    toolExecuted: true,
    toolResult: JSON.stringify({
      verdict: 'PASS', criteria: [{ id: 'relevant-checks-passed', passed: true }], findings: [],
    }),
  };

  const contentMessages: Message[] = [
    { id: 'u1', role: 'user', content: 'Améliore le texte : en présentiel en Écosse du 5 au 20 octobre.', timestamp: 1 },
    contentReview,
  ];

  const contentReceipt = extractObjectiveOutcome(
    `Texte amélioré.\n<!-- robb_objective_outcome ${JSON.stringify(receipt({
      criteria: receipt().criteria.map(criterion => ({
        ...criterion,
        evidence: criterion.id === 'relevant-checks-passed' ? ['content-review-1'] : ['assistant-final'],
      })),
    }))} -->`,
  ).declaration;

  it('rejects empty, auto-completed and legacy-checkpoint results as checks', () => {
    const invalidChecks: Message[] = [
      {
        id: 'empty', role: 'tool', content: 'Read', timestamp: 4,
        toolName: 'Read', toolUseId: 'empty-check', toolStatus: 'completed', toolExecuted: true,
        toolResult: '',
      },
      {
        id: 'auto', role: 'tool', content: 'Read', timestamp: 4,
        toolName: 'Read', toolUseId: 'auto-check', toolStatus: 'completed',
      },
      {
        id: 'legacy', role: 'tool', content: '', timestamp: 4,
        toolName: 'Read', toolUseId: 'legacy-check', toolStatus: 'completed',
        toolResult: 'Cost guard checkpoint: tool call reached the safety lease.',
      },
    ];
    for (const invalidCheck of invalidChecks) {
      const declaration = extractObjectiveOutcome(
        `Ok\n<!-- robb_objective_outcome ${JSON.stringify(receipt({
          criteria: [
            { id: 'requested-outcome-delivered', satisfied: true, evidence: ['assistant-final'] },
            { id: 'relevant-checks-passed', satisfied: true, evidence: [invalidCheck.toolUseId] },
            { id: 'no-safe-work-remaining', satisfied: true, evidence: ['assistant-final'] },
          ],
        }))} -->`,
      ).declaration;
      const validation = validateObjectiveOutcome(declaration, {
        objective,
        messages: [messages[0]!, messages[1]!, invalidCheck],
      });
      expect(validation.state).toBe('continue');
      expect(validation.gaps).toContain('criterion lacks observed evidence: relevant-checks-passed');
    }
  });

  it('accepts substantive read-only validation from generic SSH and SQL tools', () => {
    for (const check of [
      {
        id: 'ssh-read', role: 'tool', content: '', timestamp: 4,
        toolName: 'ssh_execute', toolUseId: 'ssh-check', toolStatus: 'completed', toolExecuted: true,
        toolInput: { command: 'cat /srv/app/config.json' }, toolResult: '{"enabled":true}',
      },
      {
        id: 'sql-read', role: 'tool', content: '', timestamp: 4,
        toolName: 'mcp__database__execute_query', toolUseId: 'sql-check', toolStatus: 'completed',
        toolExecuted: true,
        toolInput: { query: 'SELECT status FROM jobs WHERE id = 42' }, toolResult: '[{"status":"ready"}]',
      },
    ] satisfies Message[]) {
      const declaration = extractObjectiveOutcome(
        `Ok\n<!-- robb_objective_outcome ${JSON.stringify(receipt({
          criteria: [
            { id: 'requested-outcome-delivered', satisfied: true, evidence: ['assistant-final'] },
            { id: 'relevant-checks-passed', satisfied: true, evidence: [check.toolUseId] },
            { id: 'no-safe-work-remaining', satisfied: true, evidence: ['assistant-final'] },
          ],
        }))} -->`,
      ).declaration;
      expect(validateObjectiveOutcome(declaration, {
        objective,
        messages: [messages[0]!, messages[1]!, check],
      })).toEqual({ state: 'complete_verified', valid: true, gaps: [] });
    }
  });

  it('rejects a checkpointed mutation as execution evidence', () => {
    const checkpointed = [{ ...messages[0] }, {
      ...messages[1],
      toolExecuted: false,
    }] as Message[];
    const declaration = extractObjectiveOutcome(
      `Ok\n<!-- robb_objective_outcome ${JSON.stringify(receipt())} -->`,
    ).declaration;
    const validation = validateObjectiveOutcome(declaration, {
      objective,
      messages: checkpointed,
      executionEvidenceMissing: true,
    });
    expect(validation.state).toBe('continue');
    expect(validation.gaps).toContain('required execution evidence is missing');
  });

  it('does not accept assistant prose as check evidence', () => {
    const declaration = extractObjectiveOutcome(
      `Ok\n<!-- robb_objective_outcome ${JSON.stringify(receipt({
        criteria: [
          { id: 'requested-outcome-delivered', satisfied: true, evidence: ['assistant-final'] },
          { id: 'relevant-checks-passed', satisfied: true, evidence: ['assistant-final'] },
          { id: 'no-safe-work-remaining', satisfied: true, evidence: ['assistant-final'] },
        ],
      }))} -->`,
    ).declaration;
    expect(validateObjectiveOutcome(declaration, { objective, messages }).gaps)
      .toContain('criterion lacks observed evidence: relevant-checks-passed');
  });

  it('accepts a substantive content check without asking its reviewer to certify delivery', () => {
    expect(validateObjectiveOutcome(contentReceipt, {
      objective, messages: contentMessages,
    })).toEqual({ state: 'complete_verified', valid: true, gaps: [] });
  });

  it('explains the exact missing review criterion instead of retrying unrelated wording checks', () => {
    const review = {
      ...contentReview,
      toolResult: JSON.stringify({
        verdict: 'PASS', criteria: [{ id: 'dates-and-location', passed: true }], findings: [],
      }),
    };
    const validation = validateObjectiveOutcome(contentReceipt, {
      objective, messages: [contentMessages[0]!, review],
    });
    expect(validation.valid).toBe(false);
    expect(validation.gaps).toContain('criterion lacks observed evidence: relevant-checks-passed');
    expect(validation.gaps).toContain('Cited review receipt is missing exact host criterion IDs: relevant-checks-passed. Review the existing deliverable and return those IDs; do not repeat its external actions.');
  });

  it('does not use content-only review to relax execution, observation or registered acceptance requirements', () => {
    for (const requirements of [
      { requiresExecutionEvidence: true },
      { requiresObservationEvidence: true },
      { requiresAcceptanceCriteria: true },
      { evidenceRequirement: 'authoritative-sources-before-mutation' as const },
      { completionCriteria: [...objective.completionCriteria, 'independent-review-passed' as const] },
      { acceptanceCriteria: [{ id: 'published', description: 'Public target exists', toolName: 'Read',
        input: { file_path: '/tmp/published' }, checks: [{ path: '$text', equals: 'published' }] }] },
    ]) {
      const validation = validateObjectiveOutcome(contentReceipt, {
        objective: { ...objective, ...requirements }, messages: contentMessages,
      });
      expect(validation.valid).toBe(false);
      expect(validation.gaps).toContain('criterion lacks observed evidence: relevant-checks-passed');
    }
  });

  it('retains full review requirements after a mutation even when a persisted objective has no evidence flags', () => {
    for (const ordered of [
      [messages[0]!, messages[1]!, contentReview],
      [messages[0]!, contentReview, messages[1]!],
    ]) {
      expect(validateObjectiveOutcome(contentReceipt, { objective, messages: ordered }).gaps)
        .toContain('criterion lacks observed evidence: relevant-checks-passed');
    }
  });

  it('does not infer a response-only objective from missing legacy evidence flags or a missing original request', () => {
    for (const content of ['Implémente le changement.', 'Vérifie la publication.', '']) {
      expect(validateObjectiveOutcome(contentReceipt, {
        objective, messages: [{ ...contentMessages[0]!, content }, contentReview],
      }).gaps).toContain('criterion lacks observed evidence: relevant-checks-passed');
    }
  });

  it('never treats failed, non-executed or prose reviews as content check evidence', () => {
    for (const changes of [
      { toolExecuted: false },
      { toolStatus: 'error' as const, isError: true },
      { toolResult: 'PASS: the wording is correct.' },
      { toolResult: JSON.stringify({ verdict: 'FAIL', criteria: [{ id: 'relevant-checks-passed', passed: true }], findings: [] }) },
      { toolResult: JSON.stringify({ verdict: 'PASS', criteria: [{ id: 'relevant-checks-passed', passed: false }], findings: [] }) },
      { toolResult: JSON.stringify({ verdict: 'PASS', criteria: [{ id: 'relevant-checks-passed', passed: true }], findings: ['Wrong dates'] }) },
    ]) {
      expect(validateObjectiveOutcome(contentReceipt, {
        objective, messages: [contentMessages[0]!, { ...contentReview, ...changes }],
      }).gaps).toContain('criterion lacks observed evidence: relevant-checks-passed');
    }
  });

  it('accepts independent review evidence only from a complete structured PASS receipt', () => {
    const highStakesObjective: ActiveSessionObjective = {
      ...objective,
      risk: 'high-stakes',
      completionCriteria: [...objective.completionCriteria, 'independent-review-passed'],
    };
    const outcome = receipt({
      criteria: [
        ...receipt().criteria,
        { id: 'independent-review-passed', satisfied: true, evidence: ['review-1'] },
      ],
    });
    const declaration = extractObjectiveOutcome(
      `Ok\n<!-- robb_objective_outcome ${JSON.stringify(outcome)} -->`,
    ).declaration;
    const unstructuredReview: Message = {
      id: 'review-message', role: 'tool', content: '', timestamp: 3,
      toolName: 'mcp__session__call_llm', toolUseId: 'review-1', toolStatus: 'completed',
      toolResult: 'Looks good to me.',
    };
    expect(validateObjectiveOutcome(declaration, {
      objective: highStakesObjective,
      messages: [...messages, unstructuredReview],
    }).state).toBe('continue');

    const structuredReview: Message = {
      ...unstructuredReview,
      toolName: 'mcp__security__reviewer',
      toolResult: JSON.stringify({
        verdict: 'PASS',
        criteria: objective.completionCriteria.map(id => ({ id, passed: true })),
        findings: [],
      }),
    };
    const sameConnectionCallLlm = {
      ...structuredReview,
      toolName: 'mcp__session__call_llm',
      toolInput: { model: highStakesObjective.model ?? 'same-session-model' },
    };
    expect(validateObjectiveOutcome(declaration, {
      objective: highStakesObjective,
      messages: [...messages, sameConnectionCallLlm],
    }).gaps).toContain('criterion lacks observed evidence: independent-review-passed');
    expect(validateObjectiveOutcome(declaration, {
      objective: highStakesObjective,
      messages: [...messages, structuredReview],
    }).state).toBe('complete_verified');
    expect(hasCurrentObjectiveIndependentReviewPass(
      highStakesObjective,
      [...messages, structuredReview],
      structuredReview.timestamp,
    )).toBe(true);
    expect(hasCurrentObjectiveIndependentReviewPass(
      highStakesObjective,
      [...messages, structuredReview],
      structuredReview.timestamp + 1,
    )).toBe(false);
    const initialTerminalReviewObjective: ActiveSessionObjective = {
      ...highStakesObjective,
      acceptanceRegisteredAt: structuredReview.timestamp + 1,
      acceptanceRegisteredRevision: 'terminal-close',
      terminalReconciliation: {
        messageId: 'terminal-close',
        timestamp: structuredReview.timestamp,
        initialAcceptanceRegistrationRequired: true,
      },
    };
    const prematureReview = validateObjectiveOutcome(declaration, {
      objective: initialTerminalReviewObjective,
      messages: [...messages, structuredReview],
    });
    expect(prematureReview.state).toBe('continue');
    expect(prematureReview.gaps).toContain('criterion lacks observed evidence: independent-review-passed');
    expect(validateObjectiveOutcome(declaration, {
      objective: initialTerminalReviewObjective,
      messages: [...messages, {
        ...structuredReview,
        id: 'review-message-after-registration',
        toolUseId: 'review-1',
        timestamp: initialTerminalReviewObjective.acceptanceRegisteredAt!,
      }],
    }).state).toBe('complete_verified');

    const mutatingReview = {
      ...structuredReview,
      toolName: 'mcp__ops__review_and_update',
      toolInput: { file_path: '/tmp/app.ts' },
    };
    const mutatingValidation = validateObjectiveOutcome(declaration, {
      objective: highStakesObjective,
      messages: [...messages, mutatingReview],
    });
    expect(mutatingValidation.state).toBe('continue');
    expect(mutatingValidation.gaps).toContain('criterion lacks observed evidence: independent-review-passed');
  });

  it('accepts a requested delegated review envelope only for the complete current contract', () => {
    const reviewedObjective: ActiveSessionObjective = {
      ...objective, completionCriteria: [...objective.completionCriteria, 'independent-review-passed'],
    };
    const declaration = extractObjectiveOutcome(`Vérifié\n<!-- robb_objective_outcome ${JSON.stringify(receipt({
      criteria: [...receipt().criteria, { id: 'independent-review-passed', satisfied: true, evidence: ['wait-review'] }],
    }))} -->`).declaration;
    const review = { ...objectiveReviewBinding(reviewedObjective), verdict: 'PASS', findings: [],
      criteria: objective.completionCriteria.map(id => ({ id, passed: true })) };
    const reviewerFinalMessageId = 'msg-1789696901350-ac8dc51e3b062469960c0d6ad1a4b524';
    const snapshot = { sessionId: 'reviewer', state: 'idle', reason: 'complete',
      finalMessageId: reviewerFinalMessageId, finalText: JSON.stringify(review) };
    const wait: Message = { id: 'wait-message', role: 'tool', content: '', timestamp: 5,
      toolName: 'mcp__session__wait_sessions', toolUseId: 'wait-review', toolStatus: 'completed', toolExecuted: true,
      toolInput: { sessionIds: ['reviewer'] }, toolResult: JSON.stringify({ outcome: 'completed', sessions: [snapshot] }) };
    expect(validateObjectiveOutcome(declaration, { objective: reviewedObjective, messages: [...messages, wait] }).valid).toBe(true);
    const childMessageDeclaration = extractObjectiveOutcome(`Vérifié\n<!-- robb_objective_outcome ${JSON.stringify(receipt({
      criteria: [...receipt().criteria, {
        id: 'independent-review-passed', satisfied: true, evidence: [reviewerFinalMessageId],
      }],
    }))} -->`).declaration;
    expect(validateObjectiveOutcome(childMessageDeclaration, {
      objective: reviewedObjective, messages: [...messages, wait],
    }).valid).toBe(true);
    for (const changed of [
      { objectiveId: 'old-objective' }, { acceptanceSha256: 'old-version' }, { verdict: 'FAIL' },
      { findings: ['Missing result'] }, { criteria: [{ id: 'relevant-checks-passed', passed: true }] },
    ]) {
      const toolResult = JSON.stringify({ outcome: 'completed', sessions: [{ ...snapshot, finalText: JSON.stringify({ ...review, ...changed }) }] });
      expect(validateObjectiveOutcome(declaration, { objective: reviewedObjective, messages: [...messages, { ...wait, toolResult }] }).valid).toBe(false);
    }
    for (const changes of [{ toolExecuted: false }, { toolInput: { sessionIds: ['another-reviewer'] } }, { toolResult: JSON.stringify(review) }]) {
      expect(validateObjectiveOutcome(declaration, { objective: reviewedObjective, messages: [...messages, { ...wait, ...changes }] }).valid).toBe(false);
    }
    const laterMutation: Message = { ...messages[1]!, id: 'later-edit', toolUseId: 'later-edit', timestamp: 6 };
    expect(validateObjectiveOutcome(declaration, { objective: reviewedObjective, messages: [...messages, wait, laterMutation] }).valid).toBe(false);
  });

  it('invalidates a PASS review when a later mutation changes the deliverable', () => {
    const highStakesObjective: ActiveSessionObjective = {
      ...objective,
      risk: 'high-stakes',
      completionCriteria: [...objective.completionCriteria, 'independent-review-passed'],
    };
    const structuredReview: Message = {
      id: 'review-message', role: 'tool', content: '', timestamp: 4,
      toolName: 'mcp__session__call_llm', toolUseId: 'review-1', toolStatus: 'completed',
      toolExecuted: true,
      toolResult: JSON.stringify({
        verdict: 'PASS',
        criteria: objective.completionCriteria.map(id => ({ id, passed: true })),
        findings: [],
      }),
    };
    const laterMutation: Message = {
      id: 'later-edit', role: 'tool', content: '', timestamp: 5,
      toolName: 'Edit', toolUseId: 'edit-2', toolStatus: 'completed', toolExecuted: true,
      toolInput: { file_path: '/tmp/app.ts', new_string: 'changed after review' },
      toolResult: 'updated',
    };
    const laterCheck: Message = {
      id: 'later-check', role: 'tool', content: '', timestamp: 6,
      toolName: 'Read', toolUseId: 'check-2', toolStatus: 'completed', toolExecuted: true,
      toolInput: { file_path: '/tmp/app.ts' }, toolResult: 'verified later content',
    };
    const outcome = receipt({
      criteria: [
        { id: 'requested-outcome-delivered', satisfied: true, evidence: ['assistant-final'] },
        { id: 'relevant-checks-passed', satisfied: true, evidence: ['check-2'] },
        { id: 'no-safe-work-remaining', satisfied: true, evidence: ['assistant-final'] },
        { id: 'independent-review-passed', satisfied: true, evidence: ['review-1'] },
      ],
    });
    const declaration = extractObjectiveOutcome(
      `Ok\n<!-- robb_objective_outcome ${JSON.stringify(outcome)} -->`,
    ).declaration;
    const validation = validateObjectiveOutcome(declaration, {
      objective: highStakesObjective,
      messages: [...messages, structuredReview, laterMutation, laterCheck],
    });
    expect(validation.state).toBe('continue');
    expect(validation.gaps).toContain('criterion lacks observed evidence: independent-review-passed');
  });
});
