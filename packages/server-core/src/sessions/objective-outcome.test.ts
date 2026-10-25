import { describe, expect, it } from "bun:test";
import type { Message } from "@craft-agent/core/types";
import { extractObjectiveOutcome, validateObjectiveOutcome } from "./objective-outcome.ts";
import { messages, objective, receipt } from "./testing/objective-outcome-fixture.ts";

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
});
