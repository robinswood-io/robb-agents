import { describe, expect, it } from 'bun:test';
import type { Message, ObjectiveAcceptanceCriterion } from '@craft-agent/core/types';
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions';
import {
  extractObjectiveOutcome,
  hasCurrentObjectiveIndependentReviewPass,
  validateObjectiveOutcome,
} from './objective-outcome.ts';
import { objectiveReviewBinding } from './objective-contract.ts';
import { registerObjectiveAcceptanceCriteria } from './objective-acceptance-criteria.ts';

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

const activeAuthorizationExpiry = (startedAt: number): string => (
  new Date(startedAt + 60 * 60 * 1_000).toISOString()
);

function receipt(overrides: Record<string, unknown> = {}) {
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

  it('canonicalizes equivalent reviewer-style booleans without bypassing host evidence checks', () => {
    const equivalent = receipt({ criteria: receipt().criteria.map(({ satisfied, ...item }) => ({ ...item, passed: satisfied })) });
    const extracted = extractObjectiveOutcome(`Bilan.\n<!-- robb_objective_outcome ${JSON.stringify(equivalent)} -->`);
    expect(extracted.error).toBeUndefined();
    expect(extracted.declaration).toEqual(receipt());
    expect(validateObjectiveOutcome(extracted.declaration, { objective, messages }).valid).toBe(true);
    expect(validateObjectiveOutcome(extracted.declaration, { objective, messages: messages.slice(0, 2) }).valid).toBe(false);
    const falseCriterion = receipt({ criteria: equivalent.criteria.map((item, index) => index === 1 ? { ...item, passed: false } : item) });
    const falseDeclaration = extractObjectiveOutcome(`<!-- robb_objective_outcome ${JSON.stringify(falseCriterion)} -->`).declaration;
    expect(falseDeclaration?.criteria[1]?.satisfied).toBe(false);
    expect(validateObjectiveOutcome(falseDeclaration, { objective, messages }).valid).toBe(false);
  });

  it('rejects conflicting or non-boolean compatibility fields with a precise field path', () => {
    for (const fields of [{ satisfied: true, passed: false }, { satisfied: false, passed: true }, { passed: 'true' }, { satisfied: 'true', passed: true }]) {
      const malformed = receipt({ criteria: [{ id: 'relevant-checks-passed', evidence: ['check-1'], ...fields }] });
      const extracted = extractObjectiveOutcome(`<!-- robb_objective_outcome ${JSON.stringify(malformed)} -->`);
      expect(extracted.declaration).toBeUndefined();
      expect(extracted.error).toContain('criteria[0]');
    }
  });

  it('describes host-resolved aliases consistently in malformed evidence diagnostics', () => {
    const malformedCriterion = extractObjectiveOutcome(`<!-- robb_objective_outcome ${JSON.stringify(receipt({
      criteria: [{ id: 'relevant-checks-passed', satisfied: true, evidence: 'tool:Bash' }],
    }))} -->`);
    expect(malformedCriterion.error).toContain('observed tool/message IDs or host-resolved tool aliases');
    const malformedBlocker = extractObjectiveOutcome(`<!-- robb_objective_outcome ${JSON.stringify(receipt({
      state: 'blocked_human', criteria: [], remainingWork: ['Attendre'],
      blocker: { kind: 'credential', description: 'Identifiant requis', evidence: 'tool:Bash' },
    }))} -->`);
    expect(malformedBlocker.error).toContain('observed tool/message IDs or host-resolved tool aliases');
  });

  it('identifies an unsupported blocker without inventing a supported blocker or evidence', () => {
    const extracted = extractObjectiveOutcome(`Bilan conservé.\n<!-- robb_objective_outcome ${JSON.stringify(receipt({
      state: 'blocked_human', blocker: { kind: 'source_audio_unavailable', description: 'Source missing', evidence: ['check-1'] },
    }))} -->`);
    expect(extracted.visibleContent).toBe('Bilan conservé.');
    expect(extracted.declaration).toBeUndefined();
    expect(extracted.error).toContain('blocker.kind must be one of:');
    expect(extracted.error).toContain('observed blocker evidence');
    expect(validateObjectiveOutcome(extracted.declaration, { objective, messages }).valid).toBe(false);
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

  it('accepts only internally consistent, concrete continuation receipts', () => {
    const valid = receipt({
      state: 'continue', criteria: [],
      remainingWork: ['Run the final verification against /tmp/app.ts'], blocker: null,
    });
    expect(validateObjectiveOutcome(valid, { objective, messages })).toEqual({
      state: 'continue', valid: true, gaps: [],
    });
    for (const remainingWork of [['Continue'], ['Faire le nécessaire'], ['next step'], ['Attendre']]) {
      const validation = validateObjectiveOutcome(receipt({
        state: 'continue', criteria: [], remainingWork, blocker: null,
      }), { objective, messages });
      expect(validation.valid).toBe(false);
      expect(validation.gaps).toContain('continue requires concrete, non-placeholder remainingWork');
    }
    const blocker = validateObjectiveOutcome(receipt({
      state: 'continue', criteria: [], remainingWork: ['Run the final verification'],
      blocker: { kind: 'credential', description: 'Credential required', evidence: ['old-error'] },
    }), { objective, messages });
    expect(blocker.valid).toBe(false);
    expect(blocker.gaps).toContain('continue requires blocker:null');
  });

  it('preserves a revalidated continuation when a legacy final omits its receipt', () => {
    const prior = extractObjectiveOutcome(`<!-- robb_objective_outcome ${JSON.stringify(receipt({
      state: 'continue', criteria: [],
      remainingWork: ['Run the final verification against /tmp/app.ts'], blocker: null,
    }))} -->`).declaration!;
    const withPrior = { ...objective, lastOutcome: prior };
    expect(validateObjectiveOutcome(undefined, {
      objective: withPrior, messages, preservedContinueOnLegacyBudget: true,
    })).toEqual({
      state: 'continue', valid: true, gaps: [], effectiveDeclaration: prior,
      preservedFromPriorOutcome: true,
    });
    expect(validateObjectiveOutcome(undefined, { objective: withPrior, messages }).valid).toBe(false);
    expect(validateObjectiveOutcome(undefined, {
      objective: withPrior, messages, preservedContinueOnLegacyBudget: true,
      extractionError: 'malformed objective receipt',
    }).gaps).toContain('malformed objective receipt');
  });

  it('rejects stale or terminal prior outcomes when a legacy final omits its receipt', () => {
    const prior = extractObjectiveOutcome(`<!-- robb_objective_outcome ${JSON.stringify(receipt({
      state: 'continue', criteria: [
        { id: 'relevant-checks-passed', satisfied: true, evidence: ['check-1'] },
      ], remainingWork: ['Run the final verification against /tmp/app.ts'], blocker: null,
    }))} -->`).declaration!;
    const stale = validateObjectiveOutcome(undefined, {
      objective: { ...objective, lastOutcome: prior },
      messages: messages.slice(0, 2), preservedContinueOnLegacyBudget: true,
    });
    expect(stale.valid).toBe(false);
    expect(stale.gaps).toContain('missing structured objective outcome receipt');
    expect(validateObjectiveOutcome(undefined, {
      objective: { ...objective, lastOutcome: receipt() },
      messages, preservedContinueOnLegacyBudget: true,
    }).valid).toBe(false);
  });

  it('requires blocked_human instead of continue for wholly passive external waits', () => {
    for (const remainingWork of [
      ['Attendre la réponse d’AGIRIS'],
      ['Recevoir la validation du client', 'Attendre son autorisation externe'],
      ['Vérifier si AGIRIS a répondu'],
      ['Check whether the vendor replied'],
      ['Attendre la réponse d’AGIRIS', 'Appliquer ensuite la configuration validée'],
      ['Wait for the vendor response', 'Then apply the approved configuration'],
      ['Wait for the vendor response'],
      ['Await external approval'],
      ['Await customer approval for deployment'],
      ['Wait for the client response about the application'],
      ['Attendre le retour du client sur le site'],
    ]) {
      const validation = validateObjectiveOutcome(receipt({
        state: 'continue', criteria: [], remainingWork, blocker: null,
      }), { objective, messages });
      expect(validation.valid).toBe(false);
      expect(validation.gaps).toContain(
        'continue cannot represent a passive external wait; use blocked_human with matching host-observed blocker evidence',
      );
    }

    for (const remainingWork of [
      ['Demander la validation au client'],
      ['Vérifier le déploiement', 'Appliquer ensuite la configuration validée'],
      ['Attendre la réponse d’AGIRIS', 'Exécuter maintenant un contrôle local indépendant'],
      ['Attendre que le serveur de staging réponde'],
      ['Wait for the API response'],
      ['Check whether the endpoint replied'],
      ['Vérifier si le pipeline de déploiement est terminé', 'Tester ensuite la version servie'],
      ['Wait for the GitHub Actions build', 'Then verify the deployed endpoint'],
      ['Contrôler si la synchronisation automatique a fini'],
    ]) {
      expect(validateObjectiveOutcome(receipt({
        state: 'continue', criteria: [], remainingWork, blocker: null,
      }), { objective, messages })).toEqual({ state: 'continue', valid: true, gaps: [] });
    }
  });

  it('accepts honest execution-pending continuations while preserving mutation gates and criterion checks', () => {
    const continuation = receipt({
      state: 'continue', criteria: [], remainingWork: ['Run the final verification'], blocker: null,
    });
    expect(validateObjectiveOutcome(continuation, {
      objective, messages, executionEvidenceMissing: true,
    })).toEqual({ state: 'continue', valid: true, gaps: [] });

    const gated = validateObjectiveOutcome(continuation, {
      objective, messages, evidenceGap: 'the staged target was not observed', executionEvidenceMissing: true,
    });
    expect(gated).toEqual({ state: 'continue', valid: true, gaps: [] });
    expect(gated.gaps).not.toContain('required execution evidence is missing');

    const invented = validateObjectiveOutcome(receipt({
      state: 'continue', remainingWork: ['Run the final verification'], blocker: null,
      criteria: [{ id: 'relevant-checks-passed', satisfied: true, evidence: ['invented-check'] }],
    }), { objective, messages });
    expect(invented.valid).toBe(false);
    expect(invented.gaps).toContain('criterion lacks observed evidence: relevant-checks-passed');
    const observed = validateObjectiveOutcome(receipt({
      state: 'continue', remainingWork: ['Inspect the staging user interface'], blocker: null,
      criteria: [{ id: 'relevant-checks-passed', satisfied: true, evidence: ['check-1'] }],
    }), { objective, messages });
    expect(observed.valid).toBe(true);

    expect(validateObjectiveOutcome(receipt({
      state: 'continue', remainingWork: ['Inspect the staging user interface'], blocker: null,
      criteria: [{ id: 'invented-criterion', satisfied: false, evidence: [] }],
    }), { objective, messages }).valid).toBe(false);

    const copiedTerminalCriterion = validateObjectiveOutcome(receipt({
      state: 'continue', remainingWork: ['Inspect the staging user interface'], blocker: null,
      criteria: [{ id: 'no-safe-work-remaining', satisfied: true, evidence: ['assistant-final'] }],
    }), { objective, messages });
    expect(copiedTerminalCriterion).toMatchObject({
      state: 'continue', valid: true, gaps: [],
      effectiveDeclaration: {
        state: 'continue',
        criteria: [{ id: 'no-safe-work-remaining', satisfied: false, evidence: [] }],
      },
    });
  });

  it('rejects the PLC claim that a confirmation was already requested without a current host handoff', () => {
    const plcCheckpoint = receipt({
      state: 'continue',
      criteria: [{ id: 'no-safe-work-remaining', satisfied: true, evidence: ['assistant-final'] }],
      remainingWork: [
        'Attendre l’ouverture de l’accès et le contrat technique ISAGRI.',
        'Recevoir la confirmation d’envoi déjà demandée.',
        'Exécuter l’extraction ISAGRI réelle, la rapprocher de SharePoint et obtenir une revue indépendante PASS.',
      ],
      blocker: null,
    });
    const missing = validateObjectiveOutcome(plcCheckpoint, { objective, messages });
    expect(missing.valid).toBe(false);
    expect(missing.gaps).toContain(
      'remainingWork claims a pending human confirmation, but no structured question, authentication flow, or permission request is pending',
    );

    const pending = validateObjectiveOutcome(plcCheckpoint, {
      objective, messages, pendingHumanConfirmation: true,
    });
    expect(pending.valid).toBe(true);
    expect(pending.effectiveDeclaration?.criteria).toEqual([
      { id: 'no-safe-work-remaining', satisfied: false, evidence: [] },
    ]);

    for (const remainingWork of [
      ['Obtenir la confirmation du déploiement via l’API'],
      ['Await authorization from the OAuth endpoint'],
      ['Recevoir la validation du pipeline de CI'],
      ['Attendre la validation du pipeline CI déjà demandée'],
      ['Wait for the deployment approval already requested by the CI pipeline'],
      ['Recevoir la confirmation du job déjà demandée'],
      ['Vérifier la validation pending dans GitHub Actions'],
      ['Await the requested CI pipeline validation'],
      ['The deployment validation remains pending'],
    ]) {
      expect(validateObjectiveOutcome(receipt({
        state: 'continue', criteria: [], remainingWork, blocker: null,
      }), { objective, messages })).toEqual({ state: 'continue', valid: true, gaps: [] });
    }

    for (const remainingWork of [
      ['Obtenir la validation du client'],
      ['Wait for user approval'],
      ['Attendre l’autorisation externe'],
      ['Attendre la validation du client déjà demandée dans le pipeline CI'],
      ['Wait for external approval already requested by the deployment job'],
      ['Recevoir la confirmation d’envoi demandée'],
      ['Recevoir la confirmation d’envoi sollicitée'],
      ['Await the requested send confirmation'],
      ['Wait for the confirmation we requested'],
      ['La confirmation d’envoi reste attendue'],
      ['Wait for the confirmation we requested from the API'],
      ['Recevoir la confirmation d’envoi demandée via l’API Gmail'],
      ['La confirmation demandée pour le service reste attendue'],
      ['Wait for the deployment approval already requested'],
      ['Attendre l’autorisation du déploiement déjà demandée'],
      ['Wait for the confirmation we requested from the client through the CI pipeline'],
    ]) {
      expect(validateObjectiveOutcome(receipt({
        state: 'continue', criteria: [], remainingWork, blocker: null,
      }), { objective, messages }).gaps).toContain(
        'remainingWork claims a pending human confirmation, but no structured question, authentication flow, or permission request is pending',
      );
    }

    for (const remainingWork of [
      ['Implement the requested approval workflow'],
      ['Documenter le flux de validation sollicité'],
    ]) {
      expect(validateObjectiveOutcome(receipt({
        state: 'continue', criteria: [], remainingWork, blocker: null,
      }), { objective, messages })).toEqual({ state: 'continue', valid: true, gaps: [] });
    }
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

  it('preserves verified completion after an internal handoff without treating that handoff as evidence', () => {
    for (const toolName of ['send_agent_message', 'session__send_agent_message', 'mcp__session__send_agent_message']) {
      const handoff: Message = {
        id: 'handoff', role: 'tool', content: '', timestamp: 4,
        toolName, toolUseId: 'delivery-1', toolStatus: 'completed', toolExecuted: true,
        toolInput: { sessionId: 'parent', message: 'Vérification réussie' }, toolResult: '{"status":"queued"}',
      };
      const declaration = extractObjectiveOutcome(
        `Vérifié\n<!-- robb_objective_outcome ${JSON.stringify(receipt())} -->`,
      ).declaration;
      expect(validateObjectiveOutcome(declaration, { objective, messages: [...messages, handoff] }).valid).toBe(true);
      for (const id of ['requested-outcome-delivered', 'relevant-checks-passed']) {
        const transportOnly = extractObjectiveOutcome(
          `Vérifié\n<!-- robb_objective_outcome ${JSON.stringify(receipt({
            criteria: receipt().criteria.map(criterion => criterion.id === id
              ? { ...criterion, evidence: ['delivery-1'] } : criterion),
          }))} -->`,
        ).declaration;
        expect(validateObjectiveOutcome(transportOnly, { objective, messages: [...messages, handoff] }).valid).toBe(false);
      }
      const externalMutation = { ...handoff, toolName: 'mcp__crm__send_agent_message' };
      expect(validateObjectiveOutcome(declaration, { objective, messages: [...messages, externalMutation] }).valid).toBe(false);
    }
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

  it('keeps a PASS current across exact SSH reads, SSH history and internal delivery', () => {
    const remoteCriterion: ObjectiveAcceptanceCriterion = {
      id: 'remote-state',
      description: 'The exact remote deployment verifier passes',
      toolName: 'mcp__rbw-servers__ssh_execute',
      input: { server: 'dev', cwd: '/srv/app', command: './scripts/verify-deployment.sh --json' },
      checks: [{ path: 'ready', equals: true }],
    };
    const reviewedObjective = registerObjectiveAcceptanceCriteria({
      ...objective,
      risk: 'high-stakes',
      completionCriteria: [...objective.completionCriteria, 'independent-review-passed'],
    }, [remoteCriterion], 2);
    const remoteRead: Message = {
      id: 'remote-read-before-review', role: 'tool', content: '', timestamp: 3,
      toolName: remoteCriterion.toolName, toolUseId: 'remote-read-before-review',
      toolStatus: 'completed', toolExecuted: true,
      toolInput: structuredClone(remoteCriterion.input), toolResult: '{"ready":true}',
    };
    const review: Message = {
      id: 'independent-review', role: 'tool', content: '', timestamp: 4,
      toolName: 'mcp__security__reviewer', toolUseId: 'independent-review',
      toolStatus: 'completed', toolExecuted: true,
      toolResult: JSON.stringify({
        ...objectiveReviewBinding(reviewedObjective),
        verdict: 'PASS',
        criteria: [
          ...reviewedObjective.completionCriteria.filter(id => id !== 'independent-review-passed'),
          remoteCriterion.id,
        ].map(id => ({ id, passed: true })),
        findings: [],
      }),
    };
    const latestRemoteRead: Message = {
      ...remoteRead,
      id: 'remote-read-after-review', toolUseId: 'remote-read-after-review', timestamp: 5,
    };
    const sshHistory: Message = {
      id: 'ssh-history', role: 'tool', content: '', timestamp: 6,
      toolName: 'mcp__rbw-servers__ssh_history', toolUseId: 'ssh-history',
      toolStatus: 'completed', toolExecuted: true, toolResult: '{"commands":[]}',
    };
    const delivery: Message = {
      id: 'delivery', role: 'tool', content: '', timestamp: 7,
      toolName: 'mcp__session__send_agent_message', toolUseId: 'delivery',
      toolStatus: 'completed', toolExecuted: true,
      toolInput: { sessionId: 'parent', message: 'PASS' }, toolResult: '{"status":"queued"}',
    };
    const declaration = receipt({ criteria: [
      { id: 'requested-outcome-delivered', satisfied: true, evidence: ['assistant-final'] },
      { id: 'relevant-checks-passed', satisfied: true, evidence: ['remote-read-after-review'] },
      { id: 'no-safe-work-remaining', satisfied: true, evidence: ['assistant-final'] },
      { id: 'independent-review-passed', satisfied: true, evidence: ['independent-review'] },
      { id: remoteCriterion.id, satisfied: true, evidence: ['remote-read-after-review'] },
    ] });
    expect(validateObjectiveOutcome(declaration, {
      objective: reviewedObjective,
      messages: [messages[0]!, remoteRead, review, latestRemoteRead, sshHistory, delivery],
    })).toMatchObject({ valid: true, state: 'complete_verified', gaps: [] });
  });

  it('accepts native Bash aliases only after the host observed matching check evidence', () => {
    const aliases = ['tool:Bash', 'tool:bash', 'tool:functions.bash'];
    for (const toolName of ['Bash', 'bash', 'functions.bash']) {
      const bashCheck: Message = {
        ...messages[2]!, id: `check-${toolName}`, toolUseId: `call-${toolName}`, toolName,
        toolInput: { command: 'cat /tmp/app.ts' }, toolResult: 'verified fixed content', timestamp: 4,
      };
      for (const evidence of aliases) {
        const declaration = receipt({ criteria: receipt().criteria.map(criterion => criterion.id === 'relevant-checks-passed'
          ? { ...criterion, evidence: [evidence] }
          : criterion) });
        expect(validateObjectiveOutcome(declaration, { objective, messages: [...messages, bashCheck] }).valid).toBe(true);
      }
      const unsupportedCase = receipt({ criteria: receipt().criteria.map(criterion => criterion.id === 'relevant-checks-passed'
        ? { ...criterion, evidence: ['tool:BASH'] }
        : criterion) });
      expect(validateObjectiveOutcome(unsupportedCase, { objective, messages: [...messages, bashCheck] }).valid).toBe(false);
    }
    const aliasOnly = receipt({ criteria: receipt().criteria.map(criterion => criterion.id === 'relevant-checks-passed'
      ? { ...criterion, evidence: ['tool:Bash'] }
      : criterion) });
    expect(validateObjectiveOutcome(aliasOnly, { objective, messages }).valid).toBe(false);
    expect(validateObjectiveOutcome(aliasOnly, { objective, messages: [...messages, {
      ...messages[2]!, id: 'foreign-bash', toolUseId: 'foreign-bash', toolName: 'mcp__other__bash', timestamp: 4,
    }] }).valid).toBe(false);
    const firstBash = { ...messages[2]!, id: 'bash-first', toolUseId: 'bash-first', toolName: 'Bash',
      toolInput: { command: 'cat /tmp/app.ts' }, timestamp: 4 };
    const secondBash = { ...firstBash, id: 'bash-second', toolUseId: 'bash-second', toolName: 'functions.bash', timestamp: 5 };
    expect(validateObjectiveOutcome(aliasOnly, { objective, messages: [...messages, firstBash, secondBash] }).valid).toBe(false);
    const concrete = receipt({ criteria: receipt().criteria.map(criterion => criterion.id === 'relevant-checks-passed'
      ? { ...criterion, evidence: ['bash-second'] }
      : criterion) });
    expect(validateObjectiveOutcome(concrete, { objective, messages: [...messages, firstBash, secondBash] }).valid).toBe(true);
  });

  it('keeps non-native tool aliases exact and rejects ambiguous aliases', () => {
    const connectorCheck: Message = {
      ...messages[2]!, id: 'connector-check', toolUseId: 'connector-call', timestamp: 4,
      toolName: 'mcp__ops__get_status', toolInput: { host: 'staging' }, toolResult: '{"ready":true}',
    };
    const aliasReceipt = receipt({ criteria: receipt().criteria.map(criterion => criterion.id === 'relevant-checks-passed'
      ? { ...criterion, evidence: ['tool:mcp__ops__get_status'] }
      : criterion) });
    expect(validateObjectiveOutcome(aliasReceipt, { objective, messages: [...messages, connectorCheck] }).valid).toBe(true);
    const wrongCase = receipt({ criteria: receipt().criteria.map(criterion => criterion.id === 'relevant-checks-passed'
      ? { ...criterion, evidence: ['tool:MCP__OPS__GET_STATUS'] }
      : criterion) });
    expect(validateObjectiveOutcome(wrongCase, { objective, messages: [...messages, connectorCheck] }).valid).toBe(false);
    const duplicate = { ...connectorCheck, id: 'connector-check-2', toolUseId: 'connector-call-2', timestamp: 5 };
    expect(validateObjectiveOutcome(aliasReceipt, { objective, messages: [...messages, connectorCheck, duplicate] }).valid).toBe(false);
    const concrete = receipt({ criteria: receipt().criteria.map(criterion => criterion.id === 'relevant-checks-passed'
      ? { ...criterion, evidence: ['connector-call-2'] }
      : criterion) });
    expect(validateObjectiveOutcome(concrete, { objective, messages: [...messages, connectorCheck, duplicate] }).valid).toBe(true);
  });

  it('scopes native Bash blocker aliases to a host-observed blocker of the declared type', () => {
    const failedBash: Message = {
      id: 'permission-error', role: 'tool', content: '', timestamp: 4,
      toolName: 'Bash', toolUseId: 'permission-call', toolStatus: 'error', toolExecuted: true,
      isError: true, toolInput: { command: 'cat /restricted/state' }, toolResult: 'Permission denied',
    };
    for (const toolName of ['Bash', 'bash', 'functions.bash']) {
      for (const evidence of ['tool:Bash', 'tool:bash', 'tool:functions.bash']) {
        const blocked = receipt({
          state: 'blocked_human', criteria: [], remainingWork: ['Obtenir l’autorisation externe'],
          blocker: { kind: 'external_authorization', description: 'Autorisation requise', evidence: [evidence] },
        });
        expect(validateObjectiveOutcome(blocked, {
          objective, messages: [...messages, { ...failedBash, toolName }],
        }).state).toBe('blocked_human');
        expect(validateObjectiveOutcome(blocked, { objective, messages }).state).toBe('continue');
      }
    }
    const wrongKind = receipt({
      state: 'blocked_human', criteria: [], remainingWork: ['Fournir un identifiant'],
      blocker: { kind: 'credential', description: 'Identifiant requis', evidence: ['tool:Bash'] },
    });
    expect(validateObjectiveOutcome(wrongKind, { objective, messages: [...messages, failedBash] }).state).toBe('continue');
    expect(validateObjectiveOutcome(wrongKind, { objective, messages: [...messages, {
      ...failedBash, isError: false, toolStatus: 'completed', toolResult: 'verified fixed content',
    }] }).state).toBe('continue');
    const blockedAlias = receipt({
      state: 'blocked_human', criteria: [], remainingWork: ['Obtenir l’autorisation externe'],
      blocker: { kind: 'external_authorization', description: 'Autorisation requise', evidence: ['tool:Bash'] },
    });
    const secondFailure = { ...failedBash, id: 'permission-error-2', toolUseId: 'permission-call-2',
      toolName: 'functions.bash', timestamp: 5 };
    expect(validateObjectiveOutcome(blockedAlias, {
      objective, messages: [...messages, failedBash, secondFailure],
    }).state).toBe('continue');
    const blockedConcrete = receipt({
      state: 'blocked_human', criteria: [], remainingWork: ['Obtenir l’autorisation externe'],
      blocker: { kind: 'external_authorization', description: 'Autorisation requise', evidence: ['permission-call-2'] },
    });
    expect(validateObjectiveOutcome(blockedConcrete, {
      objective, messages: [...messages, failedBash, secondFailure],
    }).state).toBe('blocked_human');

    const connectorFailure = { ...failedBash, id: 'connector-denied', toolUseId: 'connector-denied-call',
      toolName: 'mcp__ops__graph_request' };
    const connectorBlocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: ['Obtenir l’autorisation externe'],
      blocker: { kind: 'external_authorization', description: 'Autorisation requise', evidence: ['tool:mcp__ops__graph_request'] },
    });
    expect(validateObjectiveOutcome(connectorBlocked, {
      objective, messages: [...messages, connectorFailure],
    }).state).toBe('blocked_human');
    const connectorWrongCase = receipt({
      state: 'blocked_human', criteria: [], remainingWork: ['Obtenir l’autorisation externe'],
      blocker: { kind: 'external_authorization', description: 'Autorisation requise', evidence: ['tool:MCP__OPS__GRAPH_REQUEST'] },
    });
    expect(validateObjectiveOutcome(connectorWrongCase, {
      objective, messages: [...messages, connectorFailure],
    }).state).toBe('continue');
    const duplicateConnectorFailure = { ...connectorFailure, id: 'connector-denied-2',
      toolUseId: 'connector-denied-call-2', timestamp: 5 };
    expect(validateObjectiveOutcome(connectorBlocked, {
      objective, messages: [...messages, connectorFailure, duplicateConnectorFailure],
    }).state).toBe('continue');
    const connectorConcrete = receipt({
      state: 'blocked_human', criteria: [], remainingWork: ['Obtenir l’autorisation externe'],
      blocker: { kind: 'external_authorization', description: 'Autorisation requise', evidence: ['connector-denied-call-2'] },
    });
    expect(validateObjectiveOutcome(connectorConcrete, {
      objective, messages: [...messages, connectorFailure, duplicateConnectorFailure],
    }).state).toBe('blocked_human');
  });

  it('retires a credential blocker only after the same tool request succeeds', () => {
    const credentialFailure: Message = {
      id: 'credential-error', role: 'tool', content: '', timestamp: 4,
      toolName: 'mcp__crm__get_account', toolUseId: 'credential-call', toolStatus: 'error',
      toolExecuted: true, isError: true,
      toolInput: { account: 'primary', request: { fields: ['status', 'owner'], includeDisabled: false } },
      toolResult: 'Unauthorized: API key missing',
    };
    const blocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: ['Provide the CRM credential'],
      blocker: { kind: 'credential', description: 'CRM credential required', evidence: ['credential-call'] },
    });
    const otherTargetSuccess: Message = {
      ...credentialFailure, id: 'other-success', toolUseId: 'other-call', timestamp: 5,
      toolStatus: 'completed', isError: false,
      toolInput: { account: 'secondary', request: { fields: ['status', 'owner'], includeDisabled: false } },
      toolResult: '{"status":"ready"}',
    };
    expect(validateObjectiveOutcome(blocked, {
      objective, messages: [...messages, credentialFailure, otherTargetSuccess],
    }).state).toBe('blocked_human');

    const sameRequestSuccess: Message = {
      ...otherTargetSuccess, id: 'resolved-success', toolUseId: 'resolved-call', timestamp: 6,
      // Reordered object keys remain the same persisted request.
      toolInput: { request: { includeDisabled: false, fields: ['status', 'owner'] }, account: 'primary' },
    };
    const resolved = validateObjectiveOutcome(blocked, {
      objective, messages: [...messages, credentialFailure, otherTargetSuccess, sameRequestSuccess],
    });
    expect(resolved.state).toBe('continue');
    expect(resolved.gaps).toContain('blocker evidence does not reference a matching host-observed blocker');
  });

  it('requires a fresh blocker observation after a real user relaunch', () => {
    const denied: Message = {
      id: 'stale-policy-denial', role: 'tool', content: '', timestamp: 4,
      toolName: 'mcp__ops__ssh_execute', toolUseId: 'stale-policy-call', toolStatus: 'error',
      toolExecuted: true, isError: true, toolInput: { server: 'dev', command: 'git status --short' },
      toolResult: 'MCP write operations are blocked in Explore. Switch to Ask or Allow All mode.',
    };
    const blocked = receipt({
      state: 'blocked_policy', criteria: [], remainingWork: ['Inspecter de nouveau puis poursuivre'],
      blocker: { kind: 'policy', description: 'Le contrôle a refusé la lecture distante',
        evidence: ['stale-policy-call'] },
    });
    expect(validateObjectiveOutcome(blocked, { objective, messages: [...messages, denied] }).state)
      .toBe('blocked_policy');

    const relaunch: Message = {
      id: 'real-user-relaunch', role: 'user', timestamp: 5,
      content: 'Reprends maintenant et lève les blocages récupérables.',
    };
    const stale = validateObjectiveOutcome(blocked, {
      objective, messages: [...messages, denied, relaunch],
    });
    expect(stale.state).toBe('continue');
    expect(stale.gaps).toContain('blocker evidence does not reference a matching host-observed blocker');

    const hiddenRecovery: Message = {
      ...relaunch, id: 'hidden-recovery', hidden: true,
      content: '<automatic_turn_recovery attempt="1">Continue.</automatic_turn_recovery>',
    };
    expect(validateObjectiveOutcome(blocked, {
      objective, messages: [...messages, denied, hiddenRecovery],
    }).state).toBe('blocked_policy');

    const freshDenial: Message = {
      ...denied, id: 'fresh-policy-denial', toolUseId: 'fresh-policy-call', timestamp: 6,
    };
    const refreshedBlocked = receipt({
      ...blocked,
      blocker: {
        kind: 'policy',
        description: 'Le contrôle a refusé la lecture distante',
        evidence: ['fresh-policy-call'],
      },
    });
    expect(validateObjectiveOutcome(refreshedBlocked, {
      objective, messages: [...messages, denied, relaunch, freshDenial],
    }).state).toBe('blocked_policy');
  });

  it('binds exact negative Gmail evidence to the current external wait (pure-boulder regression)', () => {
    const agirisObjective: ActiveSessionObjective = {
      ...objective,
      originalText: 'On attend surtout que laurent@example.test réponde sur les questions des API et ouvre les accès.',
    };
    const sentRequest: Message = {
      id: 'agiris-request', role: 'tool', content: '', timestamp: 3.5,
      toolName: 'mcp__google-contacts__gmail_send', toolUseId: 'agiris-request-call',
      toolStatus: 'completed', toolExecuted: true, isError: false,
      toolInput: {
        to: 'laurent@example.test',
        subject: 'RE: Compte-rendu de l’échange du 25/08 - Example Org',
        body: 'Merci de confirmer la procédure d’ouverture et les prérequis des accès.',
      },
      toolResult: '{"id":"sent-agiris","labelIds":["SENT"]}',
    };
    const noReply: Message = {
      id: 'gmail-no-reply', role: 'tool', content: '', timestamp: 4,
      toolName: 'mcp__google-contacts__gmail_search_exact', toolUseId: 'gmail-no-reply-call',
      toolStatus: 'completed', toolExecuted: true, isError: false,
      toolInput: {
        query: 'from:(laurent@example.test) subject:(Compte-rendu de l’échange du 25/08 - Example Org) after:2026/09/15',
        maxResults: 5,
      },
      toolResult: 'Aucun message Gmail trouvé pour : « from:(laurent@example.test) subject:(Compte-rendu de l’échange du 25/08 - Example Org) after:2026/09/15 »',
    };
    const blocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: ['Attendre la réponse d’AGIRIS'],
      blocker: { kind: 'external_authorization', description: 'La réponse externe est toujours attendue',
        evidence: ['gmail-no-reply-call'] },
    });
    expect(validateObjectiveOutcome(blocked, {
      objective: agirisObjective, messages: [...messages, sentRequest, noReply],
    })).toEqual({ state: 'blocked_human', valid: true, gaps: [] });

    const directlyBound = {
      ...noReply,
      id: 'gmail-direct-no-reply',
      toolUseId: 'gmail-direct-no-reply-call',
      toolInput: { query: 'from:agiris@example.com newer_than:7d', maxResults: 5 },
      toolResult: 'Aucun message Gmail trouvé pour : « from:agiris@example.com newer_than:7d »',
    };
    expect(validateObjectiveOutcome(receipt({
      ...blocked,
      blocker: { kind: 'external_authorization', description: 'La réponse externe est toujours attendue',
        evidence: ['gmail-direct-no-reply-call'] },
    }), { objective: agirisObjective, messages: [...messages, directlyBound] }).state).toBe('blocked_human');

    for (const candidate of [
      { ...noReply, toolName: 'mcp__other__gmail_search_exact' },
      { ...noReply, toolResult: 'Aucun message Gmail trouvé.' },
      { ...noReply, toolResult: `${noReply.toolResult}\nRéessayez plus tard.` },
      { ...noReply, toolInput: { query: 'from:other@example.com newer_than:7d', maxResults: 5 } },
      { ...noReply, toolResult: '**Recherche Gmail API : « from:agiris@example.com newer_than:7d »**\n_0 message(s) retourné(s) ; lire le message exact avant toute action._' },
    ]) {
      const validation = validateObjectiveOutcome(blocked, {
        objective: agirisObjective, messages: [...messages, sentRequest, candidate],
      });
      expect(validation.state).toBe('continue');
      expect(validation.gaps).toContain(
        'blocker evidence does not reference a matching host-observed blocker',
      );
    }

    const unrelatedObjective: ActiveSessionObjective = {
      ...objective,
      originalText: 'Attendre la réponse de GuardTek sur la clé Analytics.',
    };
    expect(validateObjectiveOutcome(blocked, {
      objective: unrelatedObjective, messages: [...messages, sentRequest, noReply],
    }).state).toBe('continue');

    const genericOverlapObjective: ActiveSessionObjective = {
      ...objective,
      originalText: 'Attendre la réponse de GuardTek au sujet de la production.',
    };
    const wrongProductionSender = {
      ...noReply,
      id: 'gmail-wrong-production-sender',
      toolUseId: 'gmail-wrong-production-sender-call',
      toolInput: { query: 'from:other@example.com subject:production', maxResults: 5 },
      toolResult: 'Aucun message Gmail trouvé pour : « from:other@example.com subject:production »',
    };
    expect(validateObjectiveOutcome(receipt({
      ...blocked,
      blocker: { kind: 'external_authorization', description: 'La réponse externe est toujours attendue',
        evidence: ['gmail-wrong-production-sender-call'] },
    }), { objective: genericOverlapObjective, messages: [...messages, wrongProductionSender] }).state).toBe('continue');

    const invoiceOverlapObjective: ActiveSessionObjective = {
      ...objective,
      originalText: 'Attendre la réponse de GuardTek au sujet de la facture de septembre.',
    };
    const wrongInvoiceSender = {
      ...wrongProductionSender,
      id: 'gmail-wrong-invoice-sender',
      toolUseId: 'gmail-wrong-invoice-sender-call',
      toolInput: { query: 'from:other@example.com subject:facture', maxResults: 5 },
      toolResult: 'Aucun message Gmail trouvé pour : « from:other@example.com subject:facture »',
    };
    expect(validateObjectiveOutcome(receipt({
      ...blocked,
      blocker: { kind: 'external_authorization', description: 'La réponse externe est toujours attendue',
        evidence: ['gmail-wrong-invoice-sender-call'] },
    }), { objective: invoiceOverlapObjective, messages: [...messages, wrongInvoiceSender] }).state).toBe('continue');

    const replyFound: Message = {
      ...noReply, id: 'gmail-reply-found', toolUseId: 'gmail-reply-found-call', timestamp: 5,
      toolResult: '**Recherche Gmail API : « from:agiris@example.com newer_than:7d »**\n_1 message(s) retourné(s) ; lire le message exact avant toute action._',
    };
    expect(validateObjectiveOutcome(blocked, {
      objective: agirisObjective, messages: [...messages, sentRequest, noReply, replyFound],
    }).state).toBe('continue');
  });

  it('accepts connector machine-code evidence for a missing API key', () => {
    const missingKey: Message = {
      id: 'guardtek-key-missing', role: 'tool', content: '', timestamp: 4,
      toolName: 'mcp__atria__atria_guardtek_visits', toolUseId: 'guardtek-key-call',
      toolStatus: 'error', toolExecuted: true, isError: true,
      toolInput: { startDate: '2026-09-01', endDate: '2026-09-15' },
      toolResult: '{"ok":false,"error":"guardtek_analytics_api_key_missing"}',
    };
    const blocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: ['Configurer la clé GuardTek Analytics'],
      blocker: { kind: 'credential', description: 'Clé GuardTek Analytics requise',
        evidence: ['guardtek-key-call'] },
    });
    expect(validateObjectiveOutcome(blocked, { objective, messages: [...messages, missingKey] }).state)
      .toBe('blocked_human');
  });

  it('accepts an exact host policy denial and retires it after the same request succeeds', () => {
    const denied: Message = {
      id: 'explore-denied', role: 'tool', content: '', timestamp: 4,
      toolName: 'mcp__ops__ssh_execute', toolUseId: 'explore-call', toolStatus: 'error',
      toolExecuted: true, isError: true, toolInput: { server: 'dev', command: 'bun test' },
      toolResult: 'MCP write operations are blocked in Explore. Switch to Ask or Allow All mode.',
    };
    const blocked = receipt({
      state: 'blocked_policy', criteria: [], remainingWork: [],
      blocker: { kind: 'policy', description: 'Explore blocks the required invocation', evidence: ['tool:mcp__ops__ssh_execute'] },
    });
    expect(validateObjectiveOutcome(blocked, { objective, messages: [...messages, denied] }).state)
      .toBe('blocked_policy');

    const resolved: Message = {
      ...denied, id: 'explore-resolved', toolUseId: 'explore-resolved-call', timestamp: 5,
      toolStatus: 'completed', isError: false, toolResult: '{"ok":true}',
    };
    expect(validateObjectiveOutcome(blocked, { objective, messages: [...messages, denied, resolved] }).state)
      .toBe('continue');
  });

  it('never promotes internal acceptance-contract refusals to terminal policy blockers', () => {
    const immutable: Message = {
      id: 'immutable-contract', role: 'tool', content: '', timestamp: 4,
      toolName: 'mcp__session__set_completion_criteria', toolUseId: 'immutable-contract-call',
      toolStatus: 'error', toolExecuted: true, isError: true,
      toolInput: { criteria: [] },
      toolResult: '[ERROR] The host rejected these criteria: Registered criteria cannot be weakened or replaced.',
    };
    const blocked = receipt({
      state: 'blocked_policy', criteria: [], remainingWork: [],
      blocker: { kind: 'policy', description: 'The immutable host contract cannot be replaced',
        evidence: ['immutable-contract-call'] },
    });
    expect(validateObjectiveOutcome(blocked, { objective, messages: [...messages, immutable] }).state)
      .toBe('continue');

    const repairable = { ...immutable, id: 'repairable-contract', toolUseId: 'repairable-contract-call',
      toolResult: '[ERROR] Invalid set_completion_criteria arguments: Unsupported fields.' };
    expect(validateObjectiveOutcome(blocked, { objective, messages: [...messages, repairable] }).state)
      .toBe('continue');
  });

  it('accepts completed transport receipts that explicitly report pending human authorization', () => {
    const pending: Message = {
      id: 'device-pending', role: 'tool', content: '', timestamp: 4,
      toolName: 'mcp__identity__device_code_poll', toolUseId: 'device-pending-call',
      toolStatus: 'completed', toolExecuted: true, isError: false, toolInput: { requestId: 'auth-1' },
      toolResult: JSON.stringify({ ok: false, pending: true, error: 'authorization_pending',
        message: 'Microsoft sign-in is not completed yet.' }),
    };
    const blocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: [],
      blocker: { kind: 'external_authorization', description: 'Interactive authorization is pending',
        evidence: ['device-pending-call'] },
    });
    expect(validateObjectiveOutcome(blocked, { objective, messages: [...messages, pending] }).state)
      .toBe('blocked_human');

    const machineOnlyPending: Message = {
      ...pending, id: 'machine-only-device-pending', toolUseId: 'machine-only-device-pending-call',
      toolResult: JSON.stringify({ pending: true }),
    };
    const machineOnlyBlocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: [],
      blocker: { kind: 'external_authorization', description: 'Interactive authorization is pending',
        evidence: ['machine-only-device-pending-call'] },
    });
    expect(validateObjectiveOutcome(machineOnlyBlocked, {
      objective, messages: [...messages, machineOnlyPending],
    }).state).toBe('blocked_human');

    for (const [label, toolResult] of [
      ['status', { status: 'authorization_pending' }],
      ['state', { state: 'pending' }],
      ['error', { error: 'authorization_pending' }],
      ['code', { code: 'authentication_pending' }],
      ['negative-transport', { ok: false, error: 'authorization_pending' }],
    ] as const) {
      const statePending: Message = {
        ...pending,
        id: `${label}-device-pending`,
        toolUseId: `${label}-device-pending-call`,
        toolResult: JSON.stringify(toolResult),
      };
      const stateBlocked = receipt({
        state: 'blocked_human', criteria: [], remainingWork: [],
        blocker: { kind: 'external_authorization', description: 'Interactive authorization is pending',
          evidence: [statePending.toolUseId!] },
      });
      expect(validateObjectiveOutcome(stateBlocked, {
        objective, messages: [...messages, statePending],
      }).state).toBe('blocked_human');
    }

    for (const [label, toolResult] of [
      ['false-pending', { pending: false, status: 'authorization_pending' }],
      ['success-status', { pending: true, status: 'authorized' }],
      ['success-state', { pending: true, state: 'completed' }],
      ['mixed-state-error', { status: 'authorized', error: 'authorization_pending' }],
      ['fatal-error', { pending: true, error: 'fatal auth failure' }],
      ['boolean-success', { pending: true, success: true }],
      ['contradictory-booleans', { pending: true, ok: true, success: false }],
    ] as const) {
      const contradictory: Message = {
        ...pending,
        id: `${label}-device-poll`,
        toolUseId: `${label}-device-poll-call`,
        toolResult: JSON.stringify(toolResult),
      };
      const contradictoryBlocked = receipt({
        state: 'blocked_human', criteria: [], remainingWork: [],
        blocker: { kind: 'external_authorization', description: 'Interactive authorization is pending',
          evidence: [contradictory.toolUseId!] },
      });
      expect(validateObjectiveOutcome(contradictoryBlocked, {
        objective, messages: [...messages, contradictory],
      }).state).toBe('continue');
    }

    const statusPending: Message = {
      ...pending,
      id: 'status-cycle-device-pending',
      toolUseId: 'status-cycle-device-pending-call',
      toolResult: JSON.stringify({ status: 'authorization_pending' }),
    };
    const statusBlocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: [],
      blocker: { kind: 'external_authorization', description: 'Interactive authorization is pending',
        evidence: [statusPending.toolUseId!] },
    });
    const statusCompleted: Message = {
      ...statusPending,
      id: 'status-cycle-device-completed',
      toolUseId: 'status-cycle-device-completed-call',
      timestamp: 5,
      toolResult: JSON.stringify({ status: 'authorized' }),
    };
    expect(validateObjectiveOutcome(statusBlocked, {
      objective,
      messages: [...messages, statusPending, {
        ...statusCompleted,
        id: 'other-status-cycle-device-completed',
        toolUseId: 'other-status-cycle-device-completed-call',
        toolInput: { requestId: 'auth-2' },
      }],
    }).state).toBe('blocked_human');
    expect(validateObjectiveOutcome(statusBlocked, {
      objective, messages: [...messages, statusPending, statusCompleted],
    }).state).toBe('continue');

    const unboundPending = {
      ...machineOnlyPending,
      id: 'unbound-device-pending',
      toolUseId: 'unbound-device-pending-call',
      toolInput: {},
    };
    const unboundBlocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: [],
      blocker: { kind: 'external_authorization', description: 'Interactive authorization is pending',
        evidence: ['unbound-device-pending-call'] },
    });
    expect(validateObjectiveOutcome(unboundBlocked, {
      objective, messages: [...messages, unboundPending],
    }).state).toBe('continue');
    const unboundVerbosePending = {
      ...unboundPending,
      id: 'unbound-verbose-device-pending',
      toolUseId: 'unbound-verbose-device-pending-call',
      toolResult: JSON.stringify({
        ok: false,
        error: 'authorization_pending',
        message: 'authorization pending',
      }),
    };
    const unboundVerboseBlocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: [],
      blocker: { kind: 'external_authorization', description: 'Interactive authorization is pending',
        evidence: ['unbound-verbose-device-pending-call'] },
    });
    expect(validateObjectiveOutcome(unboundVerboseBlocked, {
      objective, messages: [...messages, unboundVerbosePending],
    }).state).toBe('continue');

    const completed: Message = {
      ...pending, id: 'device-completed', toolUseId: 'device-completed-call', timestamp: 5,
      toolResult: JSON.stringify({ ok: true, pending: false }),
    };
    for (const [index, toolResult] of [{}, { ok: true }, { status: 'pending' }].entries()) {
      expect(validateObjectiveOutcome(blocked, {
        objective,
        messages: [...messages, pending, {
          ...completed,
          id: `ambiguous-device-completed-${index}`,
          toolUseId: `ambiguous-device-completed-call-${index}`,
          toolResult: JSON.stringify(toolResult),
        }],
      }).state).toBe('blocked_human');
    }
    expect(validateObjectiveOutcome(blocked, { objective, messages: [...messages, pending, completed] }).state)
      .toBe('continue');
  });

  it('accepts a strict successful device-code start receipt as pending external authorization', () => {
    const startedAt = Date.now();
    const started: Message = {
      id: 'device-started', role: 'tool', content: '', timestamp: startedAt,
      toolName: 'mcp__identity__device_code_start', toolUseId: 'device-started-call',
      toolStatus: 'completed', toolExecuted: true, isError: false,
      toolInput: { tenant: 'tenant-1' },
      toolResult: JSON.stringify({
        ok: true,
        verification_uri: 'https://login.microsoft.com/device',
        user_code: 'D949VGHX3',
        expiresAt: activeAuthorizationExpiry(startedAt),
        pollAfterHumanLoginWith: 'device_code_poll',
      }),
    };
    const blocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: [],
      blocker: { kind: 'external_authorization', description: 'Complete Microsoft device login',
        evidence: ['device-started-call'] },
    });
    expect(validateObjectiveOutcome(blocked, { objective, messages: [...messages, started] }).state)
      .toBe('blocked_human');
    const explicitlyPending = {
      ...started,
      id: 'explicitly-pending-device-start',
      toolUseId: 'explicitly-pending-device-start-call',
      toolResult: JSON.stringify({
        ...JSON.parse(started.toolResult!),
        pending: true,
        status: 'authorization_pending',
        error: '',
      }),
    };
    const explicitlyPendingBlocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: [],
      blocker: { kind: 'external_authorization', description: 'Complete Microsoft device login',
        evidence: ['explicitly-pending-device-start-call'] },
    });
    expect(validateObjectiveOutcome(explicitlyPendingBlocked, {
      objective, messages: [...messages, explicitlyPending],
    }).state).toBe('blocked_human');
    const uncorrelatedPoll: Message = {
      id: 'uncorrelated-device-poll', role: 'tool', content: '', timestamp: startedAt + 1,
      toolName: 'mcp__identity__device_code_poll', toolUseId: 'uncorrelated-device-poll-call',
      toolStatus: 'completed', toolExecuted: true, isError: false,
      toolInput: {}, toolResult: JSON.stringify({ ok: true, pending: false }),
    };
    expect(validateObjectiveOutcome(blocked, {
      objective, messages: [...messages, started, uncorrelatedPoll],
    }).state).toBe('blocked_human');

    for (const invalid of [
      { verification_uri: 'http://login.microsoft.com/device' },
      { user_code: '' },
      { pollAfterHumanLoginWith: 'continue' },
      { expiresAt: 'tomorrow' },
      { expiresAt: new Date(startedAt + 25 * 60 * 60 * 1_000).toISOString() },
      { requestId: 'auth-request-1', authRequestId: 'auth-request-2' },
      { success: false },
      { pending: false },
      { error: 'fatal auth failure' },
      { status: 'authorized' },
      { state: 'completed' },
    ]) {
      const malformed: Message = { ...started, id: `malformed-${Object.keys(invalid)[0]}`,
        toolUseId: `malformed-${Object.keys(invalid)[0]}-call`,
        toolResult: JSON.stringify({ ...JSON.parse(started.toolResult!), ...invalid }) };
      expect(validateObjectiveOutcome(blocked, { objective, messages: [...messages, malformed] }).state)
        .toBe('continue');
    }
    const generic = { ...started, id: 'generic-device-start', toolUseId: 'generic-device-start-call',
      toolName: 'mcp__files__read_document' };
    expect(validateObjectiveOutcome(blocked, { objective, messages: [...messages, generic] }).state)
      .toBe('continue');
  });

  it('retires a successful auth start only after its exact correlated poll succeeds', () => {
    const startedAt = Date.now();
    const started: Message = {
      id: 'correlated-device-start', role: 'tool', content: '', timestamp: startedAt,
      toolName: 'mcp__identity__device_code_start', toolUseId: 'correlated-device-start-call',
      toolStatus: 'completed', toolExecuted: true, isError: false,
      toolInput: { tenant: 'tenant-1', requestId: 'auth-request-1' },
      toolResult: JSON.stringify({
        ok: true,
        connectionId: 'identity-connection-1',
        verification_uri: 'https://login.microsoft.com/device',
        user_code: 'D949VGHX3',
        expiresAt: activeAuthorizationExpiry(startedAt),
        pollAfterHumanLoginWith: 'device_code_poll',
      }),
    };
    const blocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: [],
      blocker: { kind: 'external_authorization', description: 'Complete Microsoft device login',
        evidence: ['correlated-device-start-call'] },
    });
    const completedPoll: Message = {
      id: 'correlated-device-poll', role: 'tool', content: '', timestamp: startedAt + 1,
      toolName: 'mcp__identity__device_code_poll', toolUseId: 'correlated-device-poll-call',
      toolStatus: 'completed', toolExecuted: true, isError: false,
      toolInput: { requestId: 'auth-request-1' },
      toolResult: JSON.stringify({ ok: true, pending: false }),
    };
    for (const toolResult of [completedPoll.toolResult, JSON.stringify({ status: 'authorized' })]) {
      expect(validateObjectiveOutcome(blocked, {
        objective, messages: [...messages, started, { ...completedPoll, toolResult }],
      }).state).toBe('continue');
    }
    const resultCorrelatedPoll: Message = {
      ...completedPoll,
      id: 'result-correlated-device-poll',
      toolUseId: 'result-correlated-device-poll-call',
      toolInput: { tenant: 'tenant-1' },
      toolResult: JSON.stringify({ pending: false, requestId: 'auth-request-1' }),
    };
    expect(validateObjectiveOutcome(blocked, {
      objective, messages: [...messages, started, resultCorrelatedPoll],
    }).state).toBe('continue');

    const connectionOnlyPoll = {
      ...completedPoll,
      id: 'connection-only-device-poll',
      toolUseId: 'connection-only-device-poll-call',
      toolInput: { connectionId: 'identity-connection-1' },
    };
    const otherFlowPoll = {
      ...connectionOnlyPoll,
      id: 'other-flow-device-poll',
      toolUseId: 'other-flow-device-poll-call',
      toolInput: { requestId: 'auth-request-2', connectionId: 'identity-connection-1' },
    };
    for (const candidate of [connectionOnlyPoll, otherFlowPoll]) {
      expect(validateObjectiveOutcome(blocked, {
        objective, messages: [...messages, started, candidate],
      }).state).toBe('blocked_human');
    }
    const otherFlowStart = {
      ...started,
      id: 'other-flow-device-start',
      toolUseId: 'other-flow-device-start-call',
      toolInput: { tenant: 'tenant-1', requestId: 'auth-request-2' },
    };
    expect(validateObjectiveOutcome(blocked, {
      objective, messages: [...messages, started, otherFlowStart, otherFlowPoll],
    }).state).toBe('blocked_human');

    const connectionOnlyStart = {
      ...started,
      id: 'connection-only-device-start',
      toolUseId: 'connection-only-device-start-call',
      toolInput: { tenant: 'tenant-1' },
      toolResult: JSON.stringify({
        ...JSON.parse(started.toolResult!),
        connectionId: 'connection-only',
      }),
    };
    const connectionOnlyBlocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: [],
      blocker: { kind: 'external_authorization', description: 'Complete Microsoft device login',
        evidence: ['connection-only-device-start-call'] },
    });
    expect(validateObjectiveOutcome(connectionOnlyBlocked, {
      objective,
      messages: [...messages, connectionOnlyStart, {
        ...connectionOnlyPoll,
        id: 'matching-connection-only-device-poll',
        toolUseId: 'matching-connection-only-device-poll-call',
        toolInput: { connectionId: 'connection-only' },
      }],
    }).state).toBe('continue');

    const conflictingStart = {
      ...started,
      id: 'conflicting-device-start',
      toolUseId: 'conflicting-device-start-call',
      toolResult: JSON.stringify({ ...JSON.parse(started.toolResult!), requestId: 'auth-request-2' }),
    };
    const conflictingBlocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: [],
      blocker: { kind: 'external_authorization', description: 'Complete Microsoft device login',
        evidence: ['conflicting-device-start-call'] },
    });
    expect(validateObjectiveOutcome(conflictingBlocked, {
      objective, messages: [...messages, conflictingStart],
    }).state).toBe('continue');
  });

  it('keeps an auth start blocking after another poll operation or identity succeeds', () => {
    const startedAt = Date.now();
    const started: Message = {
      id: 'bound-device-start', role: 'tool', content: '', timestamp: startedAt,
      toolName: 'mcp__identity__device_code_start', toolUseId: 'bound-device-start-call',
      toolStatus: 'completed', toolExecuted: true, isError: false,
      toolResult: JSON.stringify({
        ok: true,
        request_id: 'auth-request-1',
        verification_uri: 'https://login.microsoft.com/device',
        user_code: 'D949VGHX3',
        expires_at: activeAuthorizationExpiry(startedAt),
        poll_after_human_login_with: 'device_code_poll',
      }),
    };
    const blocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: [],
      blocker: { kind: 'external_authorization', description: 'Complete Microsoft device login',
        evidence: ['bound-device-start-call'] },
    });
    const wrongOperation: Message = {
      id: 'other-auth-poll', role: 'tool', content: '', timestamp: startedAt + 1,
      toolName: 'mcp__identity__oauth_status_check', toolUseId: 'other-auth-poll-call',
      toolStatus: 'completed', toolExecuted: true, isError: false,
      toolInput: { requestId: 'auth-request-1' }, toolResult: JSON.stringify({ ok: true, pending: false }),
    };
    const wrongIdentity: Message = {
      ...wrongOperation, id: 'wrong-device-poll', toolUseId: 'wrong-device-poll-call', timestamp: startedAt + 2,
      toolName: 'mcp__identity__device_code_poll', toolInput: { requestId: 'auth-request-2' },
    };
    const crossDomainIdentity: Message = {
      ...wrongIdentity, id: 'cross-domain-device-poll', toolUseId: 'cross-domain-device-poll-call',
      toolInput: { connectionId: 'auth-request-1' },
    };
    const invalidReceipts = [
      { ok: true, pending: true },
      {},
      { ok: true, pending: false, status: 'pending' },
      { status: 'authorized', state: 'pending' },
      { pending: false, error: { code: 'authorization_pending' } },
      { pending: false, error: 'authorization failed' },
      { pending: false, error: ' '.repeat(4_097) },
      { pending: false, status: 'a'.repeat(65) },
      { pending: false, state: { name: 'authorized' } },
      { pending: false, requestId: 'auth-request-2' },
      { pending: false, requestId: 'auth-request-1', request_id: 'auth-request-2' },
      { pending: false, requestId: 'auth-request-1', authRequestId: 'auth-request-2' },
      { pending: false, requestId: 'x'.repeat(513) },
    ];
    const invalidPolls = invalidReceipts.map((toolResult, index): Message => ({
      ...wrongIdentity,
      id: `invalid-device-poll-${index}`,
      toolUseId: `invalid-device-poll-call-${index}`,
      timestamp: startedAt + 3 + index,
      toolInput: { requestId: 'auth-request-1' },
      toolResult: JSON.stringify(toolResult),
    }));
    for (const candidate of [wrongOperation, wrongIdentity, crossDomainIdentity, ...invalidPolls]) {
      expect(validateObjectiveOutcome(blocked, {
        objective, messages: [...messages, started, candidate],
      }).state).toBe('blocked_human');
    }
    expect(validateObjectiveOutcome(blocked, {
      objective,
      messages: [...messages, started, {
        ...wrongIdentity,
        id: 'conflicting-host-auth-request',
        toolUseId: 'conflicting-host-auth-request-call',
        toolInput: { requestId: 'auth-request-1' },
        authRequestId: 'auth-request-2',
        toolResult: JSON.stringify({ pending: false }),
      }],
    }).state).toBe('blocked_human');
  });

  it('retires an auth-start blocker when its strict receipt expires', () => {
    const startedAt = Date.now();
    const expired: Message = {
      id: 'expired-device-start', role: 'tool', content: '', timestamp: startedAt,
      toolName: 'mcp__identity__device_code_start', toolUseId: 'expired-device-start-call',
      toolStatus: 'completed', toolExecuted: true, isError: false,
      toolResult: JSON.stringify({
        ok: true,
        requestId: 'expired-auth-request',
        verification_uri: 'https://login.microsoft.com/device',
        user_code: 'D949VGHX3',
        expiresAt: '2000-01-01T00:00:00.000Z',
        pollAfterHumanLoginWith: 'device_code_poll',
      }),
    };
    const blocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: [],
      blocker: { kind: 'external_authorization', description: 'Complete Microsoft device login',
        evidence: ['expired-device-start-call'] },
    });
    expect(validateObjectiveOutcome(blocked, { objective, messages: [...messages, expired] }).state)
      .toBe('continue');
  });

  it('accepts a known identity-provider password challenge but not a custom application login', () => {
    const loginPage: Message = {
      id: 'login-page', role: 'tool', content: '', timestamp: 4,
      toolName: 'mcp__session__browser_tool', toolUseId: 'login-page-call',
      toolStatus: 'completed', toolExecuted: true, isError: false, toolInput: { action: 'snapshot' },
      toolResult: 'URL: https://login.microsoftonline.com/oauth2/authorize\n@e38 [textbox] "Entrer le mot de passe"',
    };
    const blocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: [],
      blocker: { kind: 'credential', description: 'The login page requires a password', evidence: ['login-page-call'] },
    });
    expect(validateObjectiveOutcome(blocked, { objective, messages: [...messages, loginPage] }).state)
      .toBe('blocked_human');

    const customApplicationLogin: Message = {
      ...loginPage,
      id: 'zero-login-page',
      toolUseId: 'zero-login-page-call',
      toolResult: 'URL: https://zero.example.test/login\nTitle: Stack Zero - Application Démo\n'
        + '@e9 [textbox] "Email"\n@e10 [textbox] "Mot de passe"\n@e11 [button] "Se connecter"',
    };
    const customApplicationBlocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: [],
      blocker: { kind: 'credential', description: 'The Zero login page requires a password',
        evidence: ['zero-login-page-call'] },
    });
    const customApplicationValidation = validateObjectiveOutcome(customApplicationBlocked, {
      objective, messages: [...messages, customApplicationLogin],
    });
    expect(customApplicationValidation.state).toBe('continue');
    expect(customApplicationValidation.gaps)
      .toContain('blocker evidence does not reference a matching host-observed blocker');

    const accountChooser: Message = {
      ...loginPage, id: 'account-chooser', toolUseId: 'account-chooser-call',
      toolResult: 'URL: https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize\n'
        + 'Elements: 3 (button:1, list:1, heading:1)\n'
        + '@e1 [list] "Choisir un compte"\n@e2 [heading] "Choisir un compte"\n'
        + '@e3 [button] "Utiliser un autre compte"',
    };
    const chooserBlocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: [],
      blocker: { kind: 'credential', description: 'Select the Microsoft account',
        evidence: ['account-chooser-call'] },
    });
    expect(validateObjectiveOutcome(chooserBlocked, {
      objective, messages: [...messages, accountChooser],
    }).state).toBe('blocked_human');

    const genericButtons = { ...accountChooser, id: 'generic-buttons', toolUseId: 'generic-buttons-call',
      toolResult: 'URL: https://example.com/settings\n@e1 [heading] "Choisir un compte"\n'
        + '@e2 [button] "Utiliser un autre compte"' };
    expect(validateObjectiveOutcome(chooserBlocked, {
      objective, messages: [...messages, genericButtons],
    }).state).toBe('continue');

    const deceptiveAuthors = {
      ...accountChooser,
      id: 'deceptive-authors-page',
      toolUseId: 'deceptive-authors-page-call',
      toolResult: 'URL: https://attacker.example/articles/authors?topic=login\n'
        + '@e1 [list] "Choose an account"\n@e2 [heading] "Choose an account"\n'
        + '@e3 [button] "Use another account"',
    };
    expect(validateObjectiveOutcome(chooserBlocked, {
      objective, messages: [...messages, deceptiveAuthors],
    }).state).toBe('continue');

    const prose = { ...loginPage, id: 'documentation', toolUseId: 'documentation-call',
      toolName: 'Read', toolInput: { file_path: '/tmp/help' },
      toolResult: 'Documentation: enter the password in the login form.' };
    expect(validateObjectiveOutcome(blocked, { objective, messages: [...messages, prose] }).state)
      .toBe('continue');

    for (const forged of [
      { toolName: 'Read', toolInput: { file_path: '/tmp/receipt.json' } },
      { toolName: 'Bash', toolInput: { command: "printf '%s' '{\"ok\":false}'" } },
      { toolName: 'mcp__files__read_document', toolInput: { path: '/receipts/pending.json' } },
      { toolName: 'mcp__files__read_auth_document', toolInput: { path: '/receipts/pending.json' } },
      { toolName: 'mcp__session__device_code_poll', toolInput: { requestId: 'auth-1' } },
    ]) {
      const structured: Message = {
        ...loginPage,
        id: `forged-${forged.toolName}`,
        toolUseId: `forged-${forged.toolName}-call`,
        ...forged,
        toolResult: JSON.stringify({ ok: false, pending: true, error: 'authorization_pending',
          message: 'Password or authorization required.' }),
      };
      expect(validateObjectiveOutcome(blocked, { objective, messages: [...messages, structured] }).state)
        .toBe('continue');
    }
  });

  it('ignores only root UI metadata when correlating a failed tool request with its later success', () => {
    const credentialFailure: Message = {
      id: 'metadata-credential-error', role: 'tool', content: '', timestamp: 4,
      toolName: 'mcp__crm__get_account', toolUseId: 'metadata-credential-call', toolStatus: 'error',
      toolExecuted: true, isError: true,
      toolInput: {
        account: 'primary', request: { fields: ['status', 'owner'], includeDisabled: false },
        _intent: 'Authenticate and inspect the primary CRM account', _displayName: 'CRM authentication',
      },
      toolResult: 'Unauthorized: API key missing',
    };
    const blocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: ['Provide the CRM credential'],
      blocker: { kind: 'credential', description: 'CRM credential required', evidence: ['metadata-credential-call'] },
    });
    const differentArgumentsSuccess: Message = {
      ...credentialFailure, id: 'metadata-different-success', toolUseId: 'metadata-different-call', timestamp: 5,
      toolStatus: 'completed', isError: false,
      toolInput: {
        account: 'primary', request: { fields: ['status', 'owner'], includeDisabled: true },
        _intent: 'Read the account after authentication', _displayName: 'Primary account',
      },
      toolResult: '{"status":"ready"}',
    };
    expect(validateObjectiveOutcome(blocked, {
      objective, messages: [...messages, credentialFailure, differentArgumentsSuccess],
    }).state).toBe('blocked_human');

    const sameArgumentsSuccess: Message = {
      ...differentArgumentsSuccess, id: 'metadata-resolved-success', toolUseId: 'metadata-resolved-call', timestamp: 6,
      toolInput: {
        request: { includeDisabled: false, fields: ['status', 'owner'] }, account: 'primary',
        _intent: 'Read the account after authentication', _displayName: 'Primary account',
      },
    };
    const resolved = validateObjectiveOutcome(blocked, {
      objective, messages: [...messages, credentialFailure, differentArgumentsSuccess, sameArgumentsSuccess],
    });
    expect(resolved.state).toBe('continue');
    expect(resolved.gaps).toContain('blocker evidence does not reference a matching host-observed blocker');
  });

  it('retires a pending auth blocker only after the same auth request is completed', () => {
    const pending: Message = {
      id: 'auth-pending', role: 'auth-request', content: 'OAuth login required', timestamp: 4,
      authRequestId: 'oauth-primary', authStatus: 'pending',
    };
    const blocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: ['Complete the OAuth login'],
      blocker: { kind: 'credential', description: 'OAuth login required', evidence: ['oauth-primary'] },
    });
    const otherCompleted = { ...pending, id: 'other-auth', timestamp: 5,
      authRequestId: 'oauth-secondary', authStatus: 'completed' as const };
    expect(validateObjectiveOutcome(blocked, {
      objective, messages: [...messages, pending, otherCompleted],
    }).state).toBe('blocked_human');
    const completed = { ...pending, id: 'auth-completed', timestamp: 6, authStatus: 'completed' as const };
    expect(validateObjectiveOutcome(blocked, {
      objective, messages: [...messages, pending, otherCompleted, completed],
    }).state).toBe('continue');
  });

  it('never accepts target-free autonomy escalation IDs as terminal tool/auth blocker proof', () => {
    const blocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: ['Provide the CRM credential'],
      blocker: { kind: 'credential', description: 'CRM credential required', evidence: ['stale-escalation'] },
    });
    const autonomyEvents = [
      { id: 'stale-escalation', timestamp: 4, phase: 'escalated' as const,
        toolName: 'mcp__crm__get_account', escalationReason: 'credential_required' as const,
        message: 'Human credential input is required.' },
      { id: 'later-success', timestamp: 6, phase: 'verified' as const,
        toolName: 'mcp__crm__get_account', message: 'Tool completed successfully.' },
    ];
    const validation = validateObjectiveOutcome(blocked, { objective, messages, autonomyEvents });
    expect(validation.state).toBe('continue');
    expect(validation.gaps).toContain('blocker evidence does not reference a matching host-observed blocker');
  });

  it('keeps a current host business decision event only until the next real user turn', () => {
    const blocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: ['Choose the rollout region'],
      blocker: { kind: 'business_decision', description: 'Rollout region required', evidence: ['decision-needed'] },
    });
    const autonomyEvents = [{
      id: 'decision-needed', timestamp: 4, phase: 'escalated' as const,
      escalationReason: 'business_decision_required' as const, message: 'Business decision required.',
    }];
    expect(validateObjectiveOutcome(blocked, { objective, messages, autonomyEvents }).state).toBe('blocked_human');
    const answered: Message = { id: 'decision-answer', role: 'user', content: 'Use eu-west.', timestamp: 5 };
    expect(validateObjectiveOutcome(blocked, {
      objective, messages: [...messages, answered], autonomyEvents,
    }).state).toBe('continue');
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

  it('accepts an exact read-only preflight authority handoff without bypassing safe work or mutations', () => {
    const rootText = 'Déploie Zero sur le serveur de staging puis vérifie le service.';
    const restriction = 'Effectue uniquement le préflight en lecture seule. N’effectue aucune mutation distante et ne déploie rien.';
    const restrictedObjective: ActiveSessionObjective = {
      ...objective,
      originalText: rootText,
      lastUserMessageId: 'read-only-boundary',
      requiresExecutionEvidence: true,
      requiresAcceptanceCriteria: true,
      acceptanceCriteria: [{
        id: 'zero-preflight', description: 'Zero staging preflight is reachable',
        toolName: 'mcp__rbw-servers__get_status', input: { server: 'zero' },
        checks: [{ path: '$.reachable', equals: true }],
      }],
      amendments: [{ messageId: 'read-only-boundary', text: restriction, timestamp: 4 }],
    };
    const root: Message = { id: 'u1', role: 'user', content: rootText, timestamp: 1 };
    const boundary: Message = {
      id: 'read-only-boundary', role: 'user', content: restriction, timestamp: 4,
    };
    const preflight: Message = {
      id: 'zero-preflight-result', role: 'tool', content: '', timestamp: 5,
      toolName: 'mcp__rbw-servers__get_status', toolUseId: 'zero-preflight-call',
      toolStatus: 'completed', toolExecuted: true, isError: false,
      toolInput: { server: 'zero' }, toolResult: '{"reachable":true}',
    };
    const authorityBlocker = {
      kind: 'external_authorization' as const,
      description: 'Le déploiement reste hors autorité', evidence: ['read-only-boundary'],
    };
    const blocked = receipt({
      state: 'blocked_human', criteria: [],
      remainingWork: ['Déployer Zero sur staging uniquement après une autorisation explicite'],
      blocker: authorityBlocker,
    });
    expect(validateObjectiveOutcome(blocked, {
      objective: restrictedObjective,
      messages: [root, boundary, preflight],
      executionEvidenceMissing: true,
    })).toEqual({ state: 'blocked_human', valid: true, gaps: [] });

    const expectRejected = (candidate: Parameters<typeof validateObjectiveOutcome>[0], candidateMessages: Message[],
      candidateObjective = restrictedObjective) => {
      const validation = validateObjectiveOutcome(candidate, {
        objective: candidateObjective, messages: candidateMessages, executionEvidenceMissing: true,
      });
      expect(validation.state).toBe('continue');
      expect(validation.gaps).toContain('blocker evidence does not reference a matching host-observed blocker');
    };
    expectRejected(blocked, [root, boundary]);
    expectRejected({ ...blocked, remainingWork: ['Vérifier encore le statut distant'] }, [root, boundary, preflight]);
    expectRejected({ ...blocked, remainingWork: ['Redémarrer le service après autorisation explicite'] }, [root, boundary, preflight]);
    expectRejected({ ...blocked, remainingWork: ['Déployer Orion sur staging après autorisation explicite'] }, [root, boundary, preflight]);
    expectRejected({ ...blocked, remainingWork: ['Déployer l’application Orion sur staging après autorisation explicite'] }, [root, boundary, preflight]);
    expectRejected({ ...blocked, remainingWork: ['Déployer Zero en production après autorisation explicite'] }, [root, boundary, preflight]);
    expectRejected({ ...blocked, remainingWork: ['Déployer prod après autorisation explicite'] }, [root, boundary, preflight]);
    expectRejected({ ...blocked, blocker: { ...authorityBlocker, evidence: ['u1'] } }, [root, boundary, preflight]);
    expectRejected({ ...blocked, blocker: { ...authorityBlocker, kind: 'irreversible_authority' } }, [root, boundary, preflight]);
    expectRejected(blocked, [boundary, preflight], {
      ...restrictedObjective,
      userMessageId: boundary.id,
      originalText: restriction,
      lastUserMessageId: boundary.id,
      requiresExecutionEvidence: false,
      amendments: undefined,
    });
    const priorMutation: Message = {
      id: 'authorized-mutation', role: 'tool', content: '', timestamp: 3,
      toolName: 'Write', toolUseId: 'authorized-mutation-call', toolStatus: 'completed', toolExecuted: true,
      toolInput: { file_path: '/srv/zero/config.json', content: '{}' }, toolResult: 'updated',
    };
    expect(validateObjectiveOutcome(blocked, {
      objective: restrictedObjective, messages: [root, priorMutation, boundary, preflight],
      executionEvidenceMissing: false,
    })).toEqual({ state: 'blocked_human', valid: true, gaps: [] });
    expectRejected(blocked, [root, boundary, { ...priorMutation, timestamp: 4.5 }, preflight]);
    expectRejected(blocked, [root, boundary, { ...preflight, toolInput: { server: 'other' } }]);
    expectRejected(blocked, [root, boundary, preflight], {
      ...restrictedObjective, acceptanceCriteria: undefined, requiresAcceptanceCriteria: undefined,
    });
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
