import { describe, expect, it } from "bun:test";
import type { Message, ObjectiveOutcomeDeclaration, ObjectiveAcceptanceCriterion } from "@craft-agent/core/types";
import { transitionObjectiveContract } from "./objective-contract.ts";
import { hasTargetBoundObjectiveExecutionEvidence, registerObjectiveAcceptanceCriteria, validateObjectiveAcceptanceCriteria } from "./objective-acceptance-criteria.ts";
import { objective, observation, root } from "./testing/objective-acceptance-criteria-fixture.ts";

describe('business criteria and durable goal — E01 E03 E04 E11 E12', () => {
  it('does not mistake an unrelated mutation for target-bound execution evidence', () => {
    const unrelatedWrite: Message = {
      id: 'unrelated-write', toolUseId: 'unrelated-write', role: 'tool', content: '',
      toolName: 'Write', toolStatus: 'completed', toolExecuted: true, timestamp: 3,
      toolInput: { file_path: '/tmp/unrelated-note.txt' }, toolResult: 'Wrote unrelated note.',
    };
    expect(hasTargetBoundObjectiveExecutionEvidence(objective, [root, unrelatedWrite])).toBe(false);
    expect(hasTargetBoundObjectiveExecutionEvidence(objective, [root, unrelatedWrite, observation])).toBe(true);
  });

  it('requires an exact Gmail effect proof and reuses an already identical sent effect', () => {
    const anchorMessageId = '1a0a917ea946a540';
    const candidateMessageId = '1a0a92a5374438d3';
    const body = 'Bonjour Ludovic,\n\nNous attendons l’ouverture de la clé API.';
    const rootText = [
      `Réponds-lui au message ${anchorMessageId}. Cible exacte : laurent@example.test, From: sender@example.test, CC vide, sujet « RE: Compte-rendu PLC ».`,
      `Corps exact : «${body}»`,
    ].join('\n');
    const amendmentText = "Vérifie l’absence puis, seulement s’il est absent, effectue une unique réponse API.";
    const gmailRoot: Message = { id: 'gmail-root', role: 'user', content: rootText, timestamp: 1 };
    const gmailAmendment: Message = {
      id: 'gmail-amendment', role: 'user', content: amendmentText, timestamp: 2,
    };
    const gmailObjective = transitionObjectiveContract({
      existing: transitionObjectiveContract({ messageId: gmailRoot.id, text: rootText, nowMs: 1 }),
      messageId: gmailAmendment.id,
      text: amendmentText,
      nowMs: 2,
    });
    const exactInput = {
      expectedAnchorMessageId: anchorMessageId,
      expectedTo: 'laurent@example.test',
      expectedCc: '',
      expectedFrom: 'sender@example.test',
      expectedSubject: 'RE: Compte-rendu PLC',
      expectedBody: body,
      expectedIsHtml: false,
    };
    const exactCriterion: ObjectiveAcceptanceCriterion = {
      id: 'exact-gmail-effect',
      description: 'The exact authorized Gmail reply exists in Sent.',
      toolName: 'mcp__google-contacts__gmail_verify_sent_message',
      input: exactInput,
      checks: [{ path: '$.ok', equals: true }],
    };
    for (const missing of Object.keys(exactInput)) {
      const weakened = structuredClone(exactCriterion);
      delete (weakened.input as Record<string, unknown>)[missing];
      expect(() => registerObjectiveAcceptanceCriteria(
        gmailObjective, [weakened], 10,
      )).toThrow(/Exact Gmail effect lacks one complete sent-message proof/);
    }
    expect(() => registerObjectiveAcceptanceCriteria(gmailObjective, [{
      ...exactCriterion,
      checks: [{ path: '$.checks.subjectMatches', equals: true }],
    }], 10)).toThrow(/Exact Gmail effect lacks one complete sent-message proof/);

    const legacyWeakCriterion: ObjectiveAcceptanceCriterion = {
      ...exactCriterion,
      input: { expectedTo: 'laurent@example.test', expectedSubject: 'RE: Compte-rendu PLC' },
    };
    const legacyWeakObjective = {
      ...gmailObjective,
      acceptanceCriteria: [legacyWeakCriterion],
      acceptanceRegisteredAt: 2,
      acceptanceRegisteredAtById: { [legacyWeakCriterion.id]: 2 },
    };
    const weakObservation: Message = {
      id: 'weak-old-message', toolUseId: 'weak-old-message', role: 'tool', content: '', timestamp: 3,
      toolName: legacyWeakCriterion.toolName, toolStatus: 'completed', toolExecuted: true,
      toolInput: { messageId: '1a0a000000000000', ...legacyWeakCriterion.input },
      toolResult: '{"ok":true}',
    };
    expect(validateObjectiveAcceptanceCriteria(legacyWeakObjective, [gmailRoot, gmailAmendment, weakObservation], {
      state: 'complete_verified', blocker: null, remainingWork: [],
      criteria: [{ id: legacyWeakCriterion.id, satisfied: true, evidence: ['weak-old-message'] }],
    })).toContainEqual(expect.stringContaining('Exact Gmail effect lacks one complete sent-message proof'));

    const registered = registerObjectiveAcceptanceCriteria(gmailObjective, [exactCriterion], 10);
    const claim: ObjectiveOutcomeDeclaration = {
      state: 'complete_verified', blocker: null, remainingWork: [],
      criteria: [{ id: exactCriterion.id, satisfied: true, evidence: ['verify-existing'] }],
    };
    const exactExisting: Message = {
      id: 'verify-existing', toolUseId: 'verify-existing', role: 'tool', content: '', timestamp: 5,
      toolName: exactCriterion.toolName, toolStatus: 'completed', toolExecuted: true,
      toolInput: { messageId: candidateMessageId, ...exactInput },
      toolResult: JSON.stringify({ ok: true, checks: {
        fromMatches: true, toMatches: true, ccMatches: true, subjectMatches: true,
        anchorThreadMatches: true, bodyMatches: true, attachmentNamesMatch: true,
        sentLabelPresent: true,
      } }),
    };
    // Evidence observed before registration is deliberately reusable: an
    // already identical effect is completion proof, never a reason to resend.
    expect(validateObjectiveAcceptanceCriteria(
      registered, [gmailRoot, gmailAmendment, exactExisting], claim,
    )).toEqual([]);
    expect(validateObjectiveAcceptanceCriteria(
      registered,
      [gmailRoot, gmailAmendment, { ...exactExisting, toolResult: JSON.stringify({ ok: false, checks: {
        fromMatches: true, toMatches: true, ccMatches: false, subjectMatches: true,
        anchorThreadMatches: true, bodyMatches: false, attachmentNamesMatch: true,
        sentLabelPresent: true,
      } }) }],
      claim,
    )).toContain('Business criterion lacks matching post-action evidence: exact-gmail-effect');

    const longBody = 'x'.repeat(3000);
    const longText = `Réponds au message ${anchorMessageId}, cible exacte : laurent@example.test, CC vide, sujet exact: RE: Long body. Corps exact : «${longBody}»`;
    const longObjective = transitionObjectiveContract({
      messageId: 'gmail-long-body', text: longText, nowMs: 20,
    });
    expect(() => registerObjectiveAcceptanceCriteria(longObjective, [{
      ...exactCriterion,
      input: { ...exactInput, expectedSubject: 'RE: Long body', expectedBody: longBody },
    }], 21)).not.toThrow();
    expect(() => registerObjectiveAcceptanceCriteria(longObjective, [{
      ...exactCriterion,
      input: { ...exactInput, expectedSubject: 'WRONG SUBJECT', expectedBody: longBody },
    }], 21)).toThrow(/Exact Gmail effect lacks one complete sent-message proof/);
  });
});
