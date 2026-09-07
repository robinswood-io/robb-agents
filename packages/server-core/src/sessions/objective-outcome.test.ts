import { describe, expect, it } from 'bun:test';
import type { Message } from '@craft-agent/core/types';
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions';
import { extractObjectiveOutcome, validateObjectiveOutcome } from './objective-outcome.ts';

const objective: ActiveSessionObjective = {
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

const messages: Message[] = [
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

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    state: 'complete_verified',
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

describe('objective outcome receipt', () => {
  it('extracts a final JSON receipt and removes it from visible prose', () => {
    const extracted = extractObjectiveOutcome(
      `Terminé et vérifié.\n<!-- robb_objective_outcome ${JSON.stringify(receipt())} -->`,
    );
    expect(extracted.visibleContent).toBe('Terminé et vérifié.');
    expect(extracted.declaration?.state).toBe('complete_verified');
    expect(extracted.error).toBeUndefined();
  });

  it('rejects malformed, duplicate, or non-final receipts', () => {
    expect(extractObjectiveOutcome('Réponse <!-- robb_objective_outcome nope -->').error).toContain('malformed');
    const marker = `<!-- robb_objective_outcome ${JSON.stringify(receipt())} -->`;
    expect(extractObjectiveOutcome(`${marker}\ntexte après`).error).toContain('final');
    expect(extractObjectiveOutcome(`${marker}\n${marker}`).error).toContain('multiple');
  });

  it('accepts completion only when every criterion references observed evidence', () => {
    const declaration = extractObjectiveOutcome(
      `Ok\n<!-- robb_objective_outcome ${JSON.stringify(receipt())} -->`,
    ).declaration;
    expect(validateObjectiveOutcome(declaration, { objective, messages })).toEqual({
      state: 'complete_verified', valid: true, gaps: [],
    });
    const invented = extractObjectiveOutcome(
      `Ok\n<!-- robb_objective_outcome ${JSON.stringify(receipt({
        criteria: [
          { id: 'requested-outcome-delivered', satisfied: true, evidence: ['assistant-final'] },
          { id: 'relevant-checks-passed', satisfied: true, evidence: ['invented-tool-id'] },
          { id: 'no-safe-work-remaining', satisfied: true, evidence: ['assistant-final'] },
        ],
      }))} -->`,
    ).declaration;
    expect(validateObjectiveOutcome(invented, { objective, messages }).state).toBe('continue');
  });

  it('never treats a successful mutation itself as relevant-checks evidence', () => {
    const declaration = extractObjectiveOutcome(
      `Ok\n<!-- robb_objective_outcome ${JSON.stringify(receipt({
        criteria: [
          { id: 'requested-outcome-delivered', satisfied: true, evidence: ['assistant-final'] },
          { id: 'relevant-checks-passed', satisfied: true, evidence: ['edit-1'] },
          { id: 'no-safe-work-remaining', satisfied: true, evidence: ['assistant-final'] },
        ],
      }))} -->`,
    ).declaration;
    const validation = validateObjectiveOutcome(declaration, {
      objective,
      messages: messages.slice(0, 2),
    });
    expect(validation.state).toBe('continue');
    expect(validation.gaps).toContain('criterion lacks observed evidence: relevant-checks-passed');
  });

  it('requires the check to execute after the latest mutation', () => {
    const reordered: Message[] = [messages[0]!, messages[2]!, messages[1]!];
    const declaration = extractObjectiveOutcome(
      `Ok\n<!-- robb_objective_outcome ${JSON.stringify(receipt())} -->`,
    ).declaration;
    const validation = validateObjectiveOutcome(declaration, { objective, messages: reordered });
    expect(validation.state).toBe('continue');
    expect(validation.gaps).toContain('criterion lacks observed evidence: relevant-checks-passed');
  });

  it('invalidates earlier checks for compound-name mutations and never treats them as checks', () => {
    for (const [toolName, toolUseId] of [
      ['mcp__crm__search_and_delete', 'compound-delete'],
      ['api_check_and_publish', 'compound-publish'],
      ['mcp__storage__search_and_upload', 'compound-upload'],
      ['mcp__settings__get_and_set', 'compound-set'],
    ]) {
      const compoundMutation: Message = {
        id: `${toolUseId}-message`, role: 'tool', content: '', timestamp: 4,
        toolName, toolUseId, toolStatus: 'completed', toolExecuted: true,
        toolResult: 'Mutation completed with one affected resource',
      };
      for (const evidence of ['check-1', toolUseId]) {
        const declaration = extractObjectiveOutcome(
          `Ok\n<!-- robb_objective_outcome ${JSON.stringify(receipt({
            criteria: [
              { id: 'requested-outcome-delivered', satisfied: true, evidence: ['assistant-final'] },
              { id: 'relevant-checks-passed', satisfied: true, evidence: [evidence] },
              { id: 'no-safe-work-remaining', satisfied: true, evidence: ['assistant-final'] },
            ],
          }))} -->`,
        ).declaration;
        const validation = validateObjectiveOutcome(declaration, {
          objective,
          messages: [...messages, compoundMutation],
        });
        expect(validation.state).toBe('continue');
        expect(validation.gaps).toContain('criterion lacks observed evidence: relevant-checks-passed');
      }
    }
  });

  it('does not promote an unknown compound tool to check evidence through a read-like token', () => {
    const ambiguousTool: Message = {
      id: 'ambiguous-message', role: 'tool', content: '', timestamp: 4,
      toolName: 'mcp__pipeline__get_and_process', toolUseId: 'ambiguous-check',
      toolStatus: 'completed', toolExecuted: true,
      toolResult: 'Processed and returned a detailed resource representation',
    };
    const declaration = extractObjectiveOutcome(
      `Ok\n<!-- robb_objective_outcome ${JSON.stringify(receipt({
        criteria: [
          { id: 'requested-outcome-delivered', satisfied: true, evidence: ['assistant-final'] },
          { id: 'relevant-checks-passed', satisfied: true, evidence: ['ambiguous-check'] },
          { id: 'no-safe-work-remaining', satisfied: true, evidence: ['assistant-final'] },
        ],
      }))} -->`,
    ).declaration;
    const validation = validateObjectiveOutcome(declaration, {
      objective,
      messages: [messages[0]!, messages[1]!, ambiguousTool],
    });
    expect(validation.state).toBe('continue');
    expect(validation.gaps).toContain('criterion lacks observed evidence: relevant-checks-passed');
  });

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
      toolResult: JSON.stringify({
        verdict: 'PASS',
        criteria: objective.completionCriteria.map(id => ({ id, passed: true })),
        findings: [],
      }),
    };
    expect(validateObjectiveOutcome(declaration, {
      objective: highStakesObjective,
      messages: [...messages, structuredReview],
    }).state).toBe('complete_verified');
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

  it('requires an observed blocker receipt and never accepts policy as a human blocker', () => {
    const blockedMessages: Message[] = [...messages, {
      id: 'auth-1',
      role: 'auth-request',
      content: 'OAuth requires MFA.',
      timestamp: 3,
      authRequestId: 'request-1',
      authRequestType: 'oauth',
      authStatus: 'pending',
    }];
    const blocked = extractObjectiveOutcome(
      `MFA requis.\n<!-- robb_objective_outcome ${JSON.stringify(receipt({
        state: 'blocked_human',
        criteria: [],
        remainingWork: ['Terminer après MFA'],
        blocker: { kind: 'mfa', description: 'Code MFA requis', evidence: ['request-1'] },
      }))} -->`,
    ).declaration;
    expect(validateObjectiveOutcome(blocked, { objective, messages: blockedMessages }).state).toBe('blocked_human');
    if (blocked?.blocker) blocked.blocker.kind = 'policy';
    expect(validateObjectiveOutcome(blocked, { objective, messages: blockedMessages }).state).toBe('continue');
  });

  it('never accepts the user objective itself as blocker evidence', () => {
    const blocked = extractObjectiveOutcome(
      `Blocage.\n<!-- robb_objective_outcome ${JSON.stringify(receipt({
        state: 'blocked_human',
        criteria: [],
        remainingWork: ['Attendre'],
        blocker: { kind: 'credential', description: 'Identifiant requis', evidence: ['u1'] },
      }))} -->`,
    ).declaration;
    const validation = validateObjectiveOutcome(blocked, { objective, messages });
    expect(validation.state).toBe('continue');
    expect(validation.gaps).toContain(
      'blocker evidence does not reference a matching host-observed blocker',
    );
  });
});
