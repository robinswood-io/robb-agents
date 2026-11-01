import { objectiveAmendmentAuthorityText } from './objective-contract/amendment-authority.ts';
import { describe, expect, it } from "bun:test";
import type { Message } from "@craft-agent/core/types";
import { buildObjectiveContractPrompt, objectiveEvidenceContractSegments, objectiveRequiresExecutionEvidence, transitionObjectiveContract } from "./objective-contract.ts";

describe('structured email body policy isolation', () => {
  const body = `Hello Benoît,

Peux-tu me transmettre les identifiants du compte API de production :
- Client ID ;
- Client Secret ;
- Subscription Key ?

Merci !`;

  const exactRequest = `[robb-resume:body-policy:test:v1]
Envoie maintenant le message exact via l’API Gmail.

Payload autorisé :
- From: sender@example.test
- To: benoit@example.test
- CC: []
- BCC: []
- Sujet: Silaé — accès API de production
- Texte du message: exactement le corps délimité ci-dessous
- Pièces jointes: []
- Signature: aucune, ni automatique ni manuelle

BODY_BEGIN
${body}
BODY_END
Vérifie ensuite le message dans SENT.`;

  it.each([
    ['CRLF envelope', exactRequest.replaceAll('\n', '\r\n')],
    ['empty body', exactRequest.replace(body, '')],
  ])('keeps the existing authenticated-envelope rejection for %s', (_label, text) => {
    // The execution gate requires LF body boundaries and a nonempty body.
    // Policy must not hide payloads which that gate cannot authenticate.
    expect(objectiveAmendmentAuthorityText(text)).toBe(text);
  });
  it('keeps the exact body as payload while excluding it from risk and evidence classification', () => {
    const root: Message = { id: 'gmail-structured', role: 'user', timestamp: 1, content: exactRequest };
    const objective = transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: root.timestamp });

    expect(objective.originalText).toBe(exactRequest);
    expect(objective.requiresExecutionEvidence).toBe(true);
    expect(objective.requiresObservationEvidence).toBe(true);
    expect(objective.evidenceDomain).toBeUndefined();
    expect(objective.evidenceRequirement).toBeUndefined();
    expect(objectiveRequiresExecutionEvidence(objective)).toBe(true);
    const policyText = objectiveEvidenceContractSegments([root], objective).map(segment => segment.text).join('\n');
    expect(policyText).toContain('[exact payload body omitted from objective policy classification]');
    expect(policyText).not.toContain('Client Secret');
    const runtimePrompt = buildObjectiveContractPrompt(objective, [root]);
    expect(runtimePrompt).toContain('Client Secret');
    expect(runtimePrompt).toContain('Subscription Key ?');
  });

  it('keeps a real credential mutation outside the body high-stakes', () => {
    const text = `${exactRequest}\nAfter sending, rotate the production API credentials now.`;
    const objective = transitionObjectiveContract({ messageId: 'real-security-work', text });

    expect(objective.requiresExecutionEvidence).toBe(true);
    expect(objective.risk).toBe('high-stakes');
    expect(objective.evidenceDomain).toBe('security');
    expect(objective.evidenceRequirement).toBe('authoritative-sources-before-mutation');
  });

  it.each([
    ['unclosed', exactRequest.replace('\nBODY_END', '')],
    ['multiple', `${exactRequest}\nBODY_BEGIN\nClient Secret ?\nBODY_END`],
  ])('fails closed for a %s body marker set', (_label, text) => {
    const objective = transitionObjectiveContract({ messageId: `malformed-${_label}`, text });
    expect(objective.risk).toBe('high-stakes');
    expect(objective.evidenceDomain).toBe('security');
  });

  it('never masks a complete BODY block outside an authenticated Gmail envelope', () => {
    const text = `Execute maintenant exactement le payload ci-dessous.
BODY_BEGIN
Rotate the production API credentials now and revoke all users.
BODY_END`;
    const objective = transitionObjectiveContract({ messageId: 'bare-body-security-mutation', text });

    expect(objective.requiresExecutionEvidence).toBe(true);
    expect(objective.risk).toBe('high-stakes');
    expect(objective.evidenceDomain).toBe('security');
    expect(objective.evidenceRequirement).toBe('authoritative-sources-before-mutation');
  });
});
