import { describe, expect, it } from 'bun:test';
import type { Message, ObjectiveOutcomeDeclaration, ObjectiveAcceptanceCriterion } from '@craft-agent/core/types';
import { isObjectiveShellExecutorToolName } from '@craft-agent/shared/agent';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { bindBusinessProcedure, businessProcedurePrompt } from './business-procedures.ts';
import { buildObjectiveContractPrompt, objectiveReviewBinding, findObjectiveText, isObjectiveMutationTool, transitionObjectiveContract } from './objective-contract.ts';
import { collectObjectiveAcceptanceObservations, hasTargetBoundObjectiveExecutionEvidence, registerObjectiveAcceptanceCriteria, validateObjectiveAcceptanceCriteria } from './objective-acceptance-criteria.ts';
import { validateObjectiveOutcome } from './objective-outcome.ts';

const criterion: ObjectiveAcceptanceCriterion = {
  id: 'timer-active', description: 'The authorized timer is active on the requested host',
  toolName: 'mcp__ops__get_timer', input: { host: 'dev', timer: 'cleanup' },
  checks: [{ path: 'enabled', equals: true }, { path: 'nextRunScheduled', equals: true }],
};
const root: Message = { id: 'u1', role: 'user', content: 'Active et vérifie le minuteur.', timestamp: 1 };
const objective = registerObjectiveAcceptanceCriteria(transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }), [criterion], 2);
const observation: Message = {
  id: 'm1', toolUseId: 't1', role: 'tool', content: '', toolName: criterion.toolName,
  toolStatus: 'completed', toolExecuted: true, timestamp: 4,
  toolInput: { host: 'dev', timer: 'cleanup' }, toolResult: '{"enabled":true,"nextRunScheduled":true}',
};
const receipt: ObjectiveOutcomeDeclaration = {
  state: 'complete_verified', blocker: null, remainingWork: [],
  criteria: [
    { id: 'timer-active', satisfied: true, evidence: ['t1'] },
    ...objective.completionCriteria.map(id => ({ id, satisfied: true, evidence: [id === 'relevant-checks-passed' ? 't1' : 'assistant-final'] })),
  ],
};

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

  it('preserves an exact Gmail preflight only across its canonical verified send', () => {
    const gmailRoot: Message = {
      id: 'gmail-preflight-root', role: 'user', content: 'Envoie le payload Gmail autorisé puis vérifie-le.', timestamp: 1,
    };
    const body = 'Hello Benoît,\n\nPayload exact.';
    const preflightInput = {
      to: 'benoit@example.test', cc: '', bcc: '',
      from: 'Thibault — Robinswood <sender@example.test>',
      sendAsEmail: 'sender@example.test', subject: 'Accès API', body, isHtml: false,
      requireKnownContacts: false, allowExternal: true, checkContacts: true,
    };
    const preflightCriterion: ObjectiveAcceptanceCriterion = {
      id: 'payload-preflight', description: 'The exact Gmail payload passes preflight.',
      toolName: 'mcp__google-contacts__gmail_send_preflight', input: preflightInput,
      checks: [{ path: '$.ok', equals: true }],
    };
    const gmailObjective = registerObjectiveAcceptanceCriteria(transitionObjectiveContract({
      messageId: gmailRoot.id, text: gmailRoot.content, nowMs: 1,
    }), [preflightCriterion], 2);
    const preflight: Message = {
      id: 'preflight', toolUseId: 'preflight-call', role: 'tool', content: '', timestamp: 3,
      toolName: preflightCriterion.toolName, toolStatus: 'completed', toolExecuted: true,
      toolInput: preflightInput, toolResult: '{"ok":true}',
    };
    const messageId = '1a0b23d42003f066';
    const sendInput = {
      to: preflightInput.to, sendAsEmail: preflightInput.sendAsEmail,
      subject: preflightInput.subject, body, isHtml: false, attachmentPaths: [],
      requireKnownContacts: false, allowExternal: true, checkContacts: true,
    };
    const operationKey = ['c5b90b782ef9c7c76c17f714e09b3617', 'b2e00059518d7c939b110d225d93e358'].join('');
    const bodySha256 = '36f526e1a5f246893833af5f8ec680c895686471135fa9cc0388e30363f82362';
    const sendResult = {
      id: messageId, threadId: messageId, labelIds: ['SENT'], sent: true, operationKey,
      to: preflightInput.to, cc: null, subject: preflightInput.subject,
      attachment_count: 0, attachment_names: [] as string[],
      requested_from: preflightInput.sendAsEmail,
      requested_send_as_email: preflightInput.sendAsEmail,
      requested_reply_to: preflightInput.sendAsEmail,
      preflight: {
        ok: true,
        sender: {
          requestedFrom: preflightInput.sendAsEmail,
          requestedSendAsEmail: preflightInput.sendAsEmail,
          resolvedEmail: preflightInput.sendAsEmail,
          effectiveEmail: preflightInput.sendAsEmail,
          replyTo: preflightInput.sendAsEmail,
          identityFound: true,
          verified: true,
        },
        recipients: { to: [preflightInput.to], cc: [], bcc: [] },
        subject: preflightInput.subject,
        body: { isHtml: false, plainLength: [...body].length },
        attachments: { count: 0, totalBytes: 0, items: [] as string[] },
      },
      verification: {
        ok: true, messageId, bodySha256,
        attachmentNames: [] as string[], attachmentEffects: [] as string[],
        checks: {
          sentLabelPresent: true, fromMatches: true, fromHeaderMatches: true,
          replyToMatches: true, operationHeaderMatches: true, toMatches: true,
          ccMatches: true, subjectMatches: true, bodyMatches: true,
          attachmentNamesMatch: true, attachmentEffectsMatch: true,
        },
        expected: {
          from: [preflightInput.sendAsEmail],
          fromHeader: preflightInput.sendAsEmail,
          replyTo: [preflightInput.sendAsEmail],
          to: [preflightInput.to], cc: [] as string[], subject: preflightInput.subject,
          operationKey, bodySha256,
          attachmentNames: [] as string[], attachmentEffects: [] as string[],
        },
      },
    };
    const send: Message = {
      id: 'send', toolUseId: 'send-call', role: 'tool', content: '', timestamp: 4,
      toolName: 'mcp__google-contacts__gmail_send', toolStatus: 'completed', toolExecuted: true,
      toolInput: sendInput, toolResult: JSON.stringify(sendResult),
    };
    const claim: ObjectiveOutcomeDeclaration = {
      state: 'complete_verified', blocker: null, remainingWork: [],
      criteria: [{ id: preflightCriterion.id, satisfied: true, evidence: ['preflight-call'] }],
    };
    expect(validateObjectiveAcceptanceCriteria(gmailObjective, [gmailRoot, preflight, send], claim)).toEqual([]);

    const gap = `Business criterion lacks matching post-action evidence: ${preflightCriterion.id}`;
    const withResult = (mutate: (candidate: typeof sendResult) => void): Message => {
      const candidate = structuredClone(sendResult);
      mutate(candidate);
      return { ...send, toolResult: JSON.stringify(candidate) };
    };
    for (const candidate of [
      { ...send, toolInput: { ...sendInput, body: `${body} altered` } },
      { ...send, toolInput: { ...sendInput, to: 'other@example.com' } },
      { ...send, toolInput: { ...sendInput, attachmentPaths: ['/tmp/report.pdf'] } },
      { ...send, toolInput: { ...sendInput, replyTo: preflightInput.sendAsEmail } },
      withResult(candidate => { candidate.sent = false; }),
      withResult(candidate => { candidate.verification.ok = false; }),
      withResult(candidate => { candidate.preflight.recipients.to = ['other@example.com']; }),
      { ...send, toolStatus: 'error' as const, isError: true, toolResult: 'send failed' },
    ]) {
      expect(validateObjectiveAcceptanceCriteria(gmailObjective, [gmailRoot, preflight, candidate], claim))
        .toContain(gap);
    }

    // The deployed receipt proves the mailbox through the effective sender,
    // post-send From header, and Reply-To checks. It deliberately does not
    // pretend to prove the human-readable display label from the preflight.
    const sameMailboxInput = { ...preflightInput,
      from: 'Another display label <sender@example.test>' };
    const sameMailboxCriterion = { ...preflightCriterion, input: sameMailboxInput };
    const sameMailboxObjective = { ...gmailObjective, acceptanceCriteria: [sameMailboxCriterion] };
    expect(validateObjectiveAcceptanceCriteria(
      sameMailboxObjective,
      [gmailRoot, { ...preflight, toolInput: sameMailboxInput }, send], claim,
    )).toEqual([]);

    const formattedFromHeader = `"Thibault — Robinswood" <${preflightInput.sendAsEmail}>`;
    const formattedHeaderReceipt = withResult(result => {
      result.requested_from = formattedFromHeader;
      result.preflight.sender.requestedFrom = formattedFromHeader;
      result.verification.expected.fromHeader = formattedFromHeader;
    });
    expect(validateObjectiveAcceptanceCriteria(
      gmailObjective, [gmailRoot, preflight, formattedHeaderReceipt], claim,
    )).toEqual([]);

    const emojiBody = `${body} 🙂`;
    const emojiInput = { ...preflightInput, body: emojiBody };
    const emojiResult = structuredClone(sendResult);
    emojiResult.operationKey = 'd'.repeat(64);
    emojiResult.verification.expected.operationKey = emojiResult.operationKey;
    emojiResult.verification.bodySha256 = 'e'.repeat(64);
    emojiResult.verification.expected.bodySha256 = emojiResult.verification.bodySha256;
    emojiResult.preflight.body.plainLength = [...emojiBody].length;
    const emojiCriterion = { ...preflightCriterion, input: emojiInput };
    const emojiObjective = { ...gmailObjective, acceptanceCriteria: [emojiCriterion] };
    expect(validateObjectiveAcceptanceCriteria(emojiObjective, [
      gmailRoot,
      { ...preflight, toolInput: emojiInput },
      { ...send, toolInput: { ...sendInput, body: emojiBody }, toolResult: JSON.stringify(emojiResult) },
    ], claim)).toEqual([]);

    const attachmentSizeBytes = 167_292;
    const attachmentSha256 = '9adab5b22a228a3e71bb1281029248d98d5a6f9f40a8e4b97e0420828a1b6f70';
    const attachmentReceipt = (attachmentPath: string) => {
      const attachmentName = attachmentPath.split('/').at(-1)!;
      const attachmentInput = { ...preflightInput, attachmentPaths: [attachmentPath] };
      const attachmentCriterion: ObjectiveAcceptanceCriterion = {
        ...preflightCriterion,
        input: { ...preflightInput, 'attachmentPaths.0': attachmentPath },
      };
      const attachmentObjective = registerObjectiveAcceptanceCriteria(transitionObjectiveContract({
        messageId: gmailRoot.id, text: gmailRoot.content, nowMs: 1,
      }), [structuredClone(attachmentCriterion)], 2);
      const attachmentSendInput = { ...sendInput, attachmentPaths: [attachmentPath] };
      const effect = { name: attachmentName, sizeBytes: attachmentSizeBytes, sha256: attachmentSha256 };
      const attachmentOperationKey = 'f'.repeat(64);
      const attachmentResult = {
        ...structuredClone(sendResult),
        operationKey: attachmentOperationKey,
        attachment_count: 1,
        attachment_names: [attachmentName],
        preflight: {
          ...structuredClone(sendResult.preflight),
          attachments: {
            count: 1,
            totalBytes: attachmentSizeBytes,
            items: [{
              input: attachmentPath,
              path: attachmentPath,
              exists: true,
              ...effect,
            }],
            duplicateNames: [] as string[],
          },
        },
        verification: {
          ...structuredClone(sendResult.verification),
          attachmentNames: [attachmentName],
          attachmentEffects: [effect],
          expected: {
            ...structuredClone(sendResult.verification.expected),
            operationKey: attachmentOperationKey,
            attachmentNames: [attachmentName],
            attachmentEffects: [effect],
          },
        },
      };
      const attachmentPreflight = { ...preflight, toolInput: structuredClone(attachmentInput) };
      const attachmentSend = {
        ...send,
        toolInput: attachmentSendInput,
        toolResult: JSON.stringify(attachmentResult),
      };
      return {
        attachmentCriterion, attachmentInput, attachmentObjective, attachmentPreflight,
        attachmentSendInput, attachmentResult, attachmentSend, attachmentName, effect,
      };
    };

    const agileAttachmentPath = '{{SESSION_PATH}}/long_responses/cfacf52c-a192-4cd2-a930-87bebc57b4c0_download.pdf';
    for (const attachmentPath of [
      agileAttachmentPath,
      '{{SESSION_PATH}}/downloads/facture-FC-02254.pdf',
      '{{SESSION_PATH}}/downloads/Facture FC-02254.PDF',
    ]) {
      const fixture = attachmentReceipt(attachmentPath);
      expect(validateObjectiveAcceptanceCriteria(
        fixture.attachmentObjective,
        [gmailRoot, fixture.attachmentPreflight, fixture.attachmentSend],
        claim,
      ), attachmentPath).toEqual([]);
    }

    const agileAttachment = attachmentReceipt(agileAttachmentPath);
    const validateAgileAttachment = (
      candidateSend: Message,
      candidateCriterion = agileAttachment.attachmentCriterion,
      candidatePreflight = agileAttachment.attachmentPreflight,
    ) => validateObjectiveAcceptanceCriteria(
      { ...agileAttachment.attachmentObjective, acceptanceCriteria: [candidateCriterion] },
      [gmailRoot, candidatePreflight, candidateSend],
      claim,
    );
    for (const attachmentPaths of [
      ['/tmp/facture-FC-02254.pdf'],
      ['{{SESSION_PATH}}/long_responses/../downloads/facture-FC-02254.pdf'],
      [agileAttachmentPath, '{{SESSION_PATH}}/downloads/other.pdf'],
      ['{{SESSION_PATH}}/long_responses/facture-FC-02254.txt'],
      ['{{SESSION_PATH}}/uploads/facture-FC-02254.pdf'],
    ]) {
      const input = { ...preflightInput, attachmentPaths };
      const criterionAttachmentSelectors = Object.fromEntries(
        attachmentPaths.map((path, index) => [`attachmentPaths.${index}`, path]),
      );
      const candidateCriterion: ObjectiveAcceptanceCriterion = {
        ...preflightCriterion,
        input: { ...preflightInput, ...criterionAttachmentSelectors },
      };
      const candidatePreflight = { ...preflight, toolInput: input };
      const candidateSend = {
        ...agileAttachment.attachmentSend,
        toolInput: { ...agileAttachment.attachmentSendInput, attachmentPaths },
      };
      expect(validateAgileAttachment(candidateSend, candidateCriterion, candidatePreflight), JSON.stringify(attachmentPaths))
        .toContain(gap);
    }
    expect(validateAgileAttachment({
      ...agileAttachment.attachmentSend,
      toolInput: {
        ...agileAttachment.attachmentSendInput,
        attachmentPaths: ['{{SESSION_PATH}}/long_responses/other.pdf'],
      },
    })).toContain(gap);

    const withAttachmentResult = (
      mutate: (candidate: typeof agileAttachment.attachmentResult) => void,
    ): Message => {
      const candidate = structuredClone(agileAttachment.attachmentResult);
      mutate(candidate);
      return { ...agileAttachment.attachmentSend, toolResult: JSON.stringify(candidate) };
    };
    const incoherentAttachmentReceipts = [
      withAttachmentResult(result => { result.attachment_count = 0; }),
      withAttachmentResult(result => { result.attachment_names = ['other.pdf']; }),
      withAttachmentResult(result => { result.preflight.attachments.count = 0; }),
      withAttachmentResult(result => { result.preflight.attachments.totalBytes++; }),
      withAttachmentResult(result => { result.preflight.attachments.duplicateNames = [agileAttachment.attachmentName]; }),
      withAttachmentResult(result => { result.preflight.attachments.items[0]!.input = '{{SESSION_PATH}}/downloads/other.pdf'; }),
      withAttachmentResult(result => { result.preflight.attachments.items[0]!.path = 'relative/facture.pdf'; }),
      withAttachmentResult(result => { result.preflight.attachments.items[0]!.path = `/tmp/${agileAttachment.attachmentName}`; }),
      withAttachmentResult(result => {
        result.preflight.attachments.items[0]!.path = `{{SESSION_PATH}}/downloads/${agileAttachment.attachmentName}`;
      }),
      withAttachmentResult(result => { result.preflight.attachments.items[0]!.exists = false; }),
      withAttachmentResult(result => { result.preflight.attachments.items[0]!.name = 'other.pdf'; }),
      withAttachmentResult(result => { result.preflight.attachments.items[0]!.sizeBytes++; }),
      withAttachmentResult(result => { result.preflight.attachments.items[0]!.sha256 = 'a'.repeat(64); }),
      withAttachmentResult(result => {
        Object.assign(result.preflight.attachments.items[0]!, { unexpected: true });
      }),
      withAttachmentResult(result => { result.verification.expected.attachmentNames = ['other.pdf']; }),
      withAttachmentResult(result => { result.verification.attachmentNames = ['other.pdf']; }),
      withAttachmentResult(result => { result.verification.expected.attachmentEffects[0]!.name = 'other.pdf'; }),
      withAttachmentResult(result => { result.verification.expected.attachmentEffects[0]!.sizeBytes++; }),
      withAttachmentResult(result => { result.verification.expected.attachmentEffects[0]!.sha256 = 'a'.repeat(64); }),
      withAttachmentResult(result => {
        Object.assign(result.verification.expected.attachmentEffects[0]!, { unexpected: true });
      }),
      withAttachmentResult(result => { result.verification.attachmentEffects[0]!.name = 'other.pdf'; }),
      withAttachmentResult(result => { result.verification.attachmentEffects[0]!.sizeBytes++; }),
      withAttachmentResult(result => { result.verification.attachmentEffects[0]!.sha256 = 'a'.repeat(64); }),
      withAttachmentResult(result => {
        Object.assign(result.verification.attachmentEffects[0]!, { unexpected: true });
      }),
      withAttachmentResult(result => { result.verification.checks.attachmentNamesMatch = false; }),
      withAttachmentResult(result => { result.verification.checks.attachmentEffectsMatch = false; }),
    ];
    for (const [index, candidate] of incoherentAttachmentReceipts.entries()) {
      expect(validateAgileAttachment(candidate), `incoherent attachment receipt ${index}`).toContain(gap);
    }

    const expectCriterionContractRejected = (
      input: Record<string, unknown>,
      observedInput: Record<string, unknown> = input,
    ) => {
      // Persisted legacy criteria are untrusted even when their values no
      // longer satisfy the current scalar registration type.
      const candidateCriterion: ObjectiveAcceptanceCriterion = {
        ...preflightCriterion,
        input: input as ObjectiveAcceptanceCriterion['input'],
      };
      const candidateObjective = { ...gmailObjective, acceptanceCriteria: [candidateCriterion] };
      expect(validateObjectiveAcceptanceCriteria(
        candidateObjective, [gmailRoot, { ...preflight, toolInput: observedInput }, send], claim,
      )).toContain(gap);
    };
    expectCriterionContractRejected({ ...preflightInput, replyTo: preflightInput.sendAsEmail });
    expectCriterionContractRejected({ ...preflightInput, attachmentPaths: ['/tmp/report.pdf'] });
    expectCriterionContractRejected({ ...preflightInput, from: 'Other <other@example.com>' });
    expectCriterionContractRejected({ ...preflightInput,
      from: `Thibault <${preflightInput.sendAsEmail}>, Other <other@example.com>` });
    const preflightWithoutBody: Record<string, unknown> = { ...preflightInput };
    delete preflightWithoutBody.body;
    expectCriterionContractRejected(
      { ...preflightWithoutBody, '$.body.value': body },
      { ...preflightWithoutBody, body: { value: body } },
    );

    for (const candidate of [
      withResult(result => { result.operationKey = 'not-a-sha256'; }),
      withResult(result => { result.verification.expected.operationKey = 'a'.repeat(64); }),
      withResult(result => { result.requested_from = 'other@example.com'; }),
      withResult(result => {
        result.requested_from = `${preflightInput.sendAsEmail}, other@example.com`;
      }),
      withResult(result => { result.preflight.sender.requestedFrom = 'other@example.com'; }),
      withResult(result => { result.verification.expected.fromHeader = 'other@example.com'; }),
      withResult(result => { result.preflight.sender.effectiveEmail = 'other@example.com'; }),
      withResult(result => { result.verification.expected.from = ['other@example.com']; }),
      withResult(result => { result.verification.expected.replyTo = ['other@example.com']; }),
      withResult(result => { result.verification.expected.to = ['other@example.com']; }),
      withResult(result => { result.verification.expected.cc = ['other@example.com']; }),
      withResult(result => { result.verification.expected.subject = 'Different subject'; }),
      withResult(result => { result.verification.expected.bodySha256 = 'a'.repeat(64); }),
      withResult(result => { result.verification.expected.attachmentNames = ['report.pdf']; }),
      withResult(result => { result.verification.expected.attachmentEffects = ['forged-effect']; }),
      withResult(result => { result.verification.attachmentNames = ['report.pdf']; }),
      withResult(result => { result.verification.attachmentEffects = ['forged-effect']; }),
    ]) {
      expect(validateObjectiveAcceptanceCriteria(gmailObjective, [gmailRoot, preflight, candidate], claim))
        .toContain(gap);
    }

    for (const check of ['operationHeaderMatches', 'fromHeaderMatches', 'replyToMatches'] as const) {
      const falseCheck = withResult(result => { result.verification.checks[check] = false; });
      expect(validateObjectiveAcceptanceCriteria(gmailObjective, [gmailRoot, preflight, falseCheck], claim))
        .toContain(gap);
      const absentCheck = withResult(result => {
        delete (result.verification.checks as Partial<typeof result.verification.checks>)[check];
      });
      expect(validateObjectiveAcceptanceCriteria(gmailObjective, [gmailRoot, preflight, absentCheck], claim))
        .toContain(gap);
    }

    const wrongLaterSend = { ...send, id: 'wrong-later-send', toolUseId: 'wrong-later-send', timestamp: 5,
      toolInput: { ...sendInput, subject: 'Different subject' } };
    const postActionReads: Message[] = [
      { ...preflight, id: 'get', toolUseId: 'get', timestamp: 6,
        toolName: 'mcp__google-contacts__gmail_get_message', toolInput: { messageId },
        toolResult: JSON.stringify({ id: messageId, to: preflightInput.to, subject: preflightInput.subject }) },
      { ...preflight, id: 'list', toolUseId: 'list', timestamp: 7,
        toolName: 'mcp__google-contacts__gmail_list_messages', toolInput: { q: 'in:sent' },
        toolResult: JSON.stringify({ resultCount: 1 }) },
      { ...preflight, id: 'review', toolUseId: 'review', timestamp: 8,
        toolName: 'mcp__session__call_llm', toolInput: {}, toolResult: JSON.stringify({
          verdict: 'PASS', criteria: [{ id: preflightCriterion.id, passed: true }], findings: [],
        }) },
    ];
    // Reads and reviewer prose are not interchangeable with the immutable
    // preflight predicate after a different mutation changes the payload.
    expect(validateObjectiveAcceptanceCriteria(
      gmailObjective, [gmailRoot, preflight, send, wrongLaterSend, ...postActionReads], claim,
    )).toContain(gap);
  });

  it('accepts exact state and rejects disabled timers, wrong targets, stale or absent observations', () => {
    expect(validateObjectiveAcceptanceCriteria(objective, [root, observation], receipt)).toEqual([]);
    for (const changes of [
      { toolResult: '{"enabled":false,"nextRunScheduled":true}' },
      { toolInput: { host: 'production', timer: 'cleanup' } },
      { timestamp: 0 }, { toolExecuted: false }, { toolResult: 'PASS' },
      { toolResult: '{"content":[{"type":"text","text":""}]}' },
      { toolName: 'mcp__other__get_timer' },
    ]) expect(validateObjectiveOutcome(receipt, { objective, messages: [root, { ...observation, ...changes }] }).valid).toBe(false);
  });
  it('rejects evidence before a mutation even if all technical flags pass', () => {
    const mutation: Message = { ...observation, id: 'm2', toolUseId: 't2', toolName: 'Edit', toolInput: { file_path: '/tmp/timer' } };
    expect(validateObjectiveAcceptanceCriteria(objective, [root, observation, mutation], receipt)).toHaveLength(1);
    expect(validateObjectiveAcceptanceCriteria(objective, [root, mutation, observation], receipt)).toEqual([]);
  });
  it('requires re-observation after an ambiguous tool or unproven shell command may change the target', () => {
    const possibleMutations: Message[] = [
      { ...observation, id: 'ambiguous', toolUseId: 'ambiguous', timestamp: 5,
        toolName: 'mcp__ops__get_and_process', toolInput: { host: 'dev', timer: 'cleanup' } },
      { ...observation, id: 'checkout', toolUseId: 'checkout', timestamp: 5,
        toolName: 'Bash', toolInput: { command: 'git checkout main' } },
      { ...observation, id: 'restart', toolUseId: 'restart', timestamp: 5,
        toolName: 'Bash', toolInput: { command: 'docker compose restart' } },
      { ...observation, id: 'find-write', toolUseId: 'find-write', timestamp: 5,
        toolName: 'Bash', toolInput: { command: 'find /srv/review -maxdepth 0 -fprintf /srv/review/state.txt changed' } },
      { ...observation, id: 'generic-action', toolUseId: 'generic-action', timestamp: 5,
        toolName: 'functions.exec', toolInput: { action: 'configure_service', host: 'dev', timer: 'cleanup' } },
      { ...observation, id: 'generic-sql', toolUseId: 'generic-sql', timestamp: 5,
        toolName: 'mcp__database__execute_query', toolInput: { query: 'SELECT mutate_timer()', host: 'dev', timer: 'cleanup' } },
      { ...observation, id: 'forward', toolUseId: 'forward', timestamp: 5,
        toolName: 'mcp__ops__forward_timer', toolInput: { host: 'dev', timer: 'cleanup' } },
    ];
    for (const possibleMutation of possibleMutations) {
      expect(validateObjectiveAcceptanceCriteria(
        objective, [root, observation, possibleMutation], receipt,
      )).toContain('Business criterion lacks matching post-action evidence: timer-active');
      const freshReceipt = { ...receipt, criteria: receipt.criteria.map(item => item.id === criterion.id
        ? { ...item, evidence: ['fresh'] }
        : item) };
      expect(validateObjectiveAcceptanceCriteria(
        objective, [root, observation, possibleMutation, { ...observation, id: 'fresh', toolUseId: 'fresh', timestamp: 6 }], freshReceipt,
      )).toEqual([]);
    }
  });
  it('requires registered checks for new actionable objectives and rechecks after partial failure', () => {
    const unregistered = transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 });
    expect(validateObjectiveAcceptanceCriteria(unregistered, [root, observation], receipt)).toHaveLength(1);
    const partial: Message = { ...observation, id: 'partial', toolUseId: 'partial', toolName: 'Edit', toolStatus: 'error', isError: true, toolResult: 'Wrote part of the file before failing' };
    expect(validateObjectiveAcceptanceCriteria(objective, [root, observation, partial], receipt)).toHaveLength(1);
  });
  it('binds independent review to the original goal and exact target/version criteria — E12', () => {
    const reviewedObjective = { ...objective, completionCriteria: [...objective.completionCriteria, 'independent-review-passed' as const] };
    const final = { ...receipt, criteria: [...receipt.criteria, { id: 'independent-review-passed', satisfied: true, evidence: ['review'] }] };
    const reviewed = { verdict: 'PASS', ...objectiveReviewBinding(reviewedObjective), findings: [],
      criteria: [...objective.completionCriteria, criterion.id].map(id => ({ id, passed: true })) };
    const sameConnectionReview: Message = { ...observation, id: 'review', toolUseId: 'review', toolName: 'mcp__llm__call_llm', timestamp: 6, toolResult: JSON.stringify(reviewed) };
    expect(validateObjectiveOutcome(final, {
      objective: reviewedObjective,
      messages: [root, observation, sameConnectionReview],
    }).valid).toBe(false);
    const review: Message = { ...sameConnectionReview, toolName: 'mcp__security__reviewer' };
    expect(validateObjectiveOutcome(final, { objective: reviewedObjective, messages: [root, observation, review] }).valid).toBe(true);
    for (const changed of [{ acceptanceSha256: 'old-version' }, { objectiveId: 'another-goal' }]) {
      expect(validateObjectiveOutcome(final, { objective: reviewedObjective, messages: [root, observation, { ...review, toolResult: JSON.stringify({ ...reviewed, ...changed }) }] }).valid).toBe(false);
    }
  });
  it('supports exact textual observations without accepting substring success claims', () => {
    const textCriterion = { ...criterion, checks: [{ path: '$text', equals: 'timer cleanup on dev: enabled, next run scheduled' }] };
    const textObjective = registerObjectiveAcceptanceCriteria(transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }), [textCriterion], 2);
    const textResult = { ...observation, toolResult: textCriterion.checks[0]!.equals };
    expect(validateObjectiveAcceptanceCriteria(textObjective, [root, textResult], receipt)).toEqual([]);
    expect(validateObjectiveAcceptanceCriteria(textObjective, [root, { ...textResult, toolResult: `${textResult.toolResult} BUT FAILED` }], receipt)).toHaveLength(1);
  });
  it('ignores one final line terminator in exact text checks while retaining significant output', () => {
    for (const expected of ['{"ok":true}', '{"ok":true}\n', '{"ok":true}\r\n']) {
      const registered = registerObjectiveAcceptanceCriteria(
        transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }),
        [{ ...criterion, checks: [{ path: '$text', equals: expected }] }], 2,
      );
      const binding = objectiveReviewBinding(registered);
      for (const toolResult of ['{"ok":true}', '{"ok":true}\n', '{"ok":true}\r\n']) {
        expect(validateObjectiveAcceptanceCriteria(registered, [root, { ...observation, toolResult }], receipt)).toEqual([]);
      }
      for (const toolResult of [
        '{"ok":false}\n', '{"ok":true}\nERROR', ' {"ok":true}\n', '{"ok":true} \n',
        '{"ok":true}\n\n', '{"ok":true}\r\n\r\n', '{"ok":true}\r',
      ]) {
        expect(validateObjectiveAcceptanceCriteria(registered, [root, { ...observation, toolResult }], receipt)).toHaveLength(1);
      }
      expect(registered.acceptanceCriteria?.[0]?.checks[0]?.equals).toBe(expected);
      expect(objectiveReviewBinding(registered)).toEqual(binding);
    }
  });
  it('accepts a short exact response when the registered criterion binds the real call and target', () => {
    const textObjective = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }),
      [{ ...criterion, checks: [{ path: '$text', equals: 'OK' }] }], 2,
    );
    const exactResult = { ...observation, toolResult: 'OK' };
    expect(validateObjectiveAcceptanceCriteria(textObjective, [root, exactResult], receipt)).toEqual([]);
    expect(validateObjectiveOutcome(receipt, { objective: textObjective, messages: [root, exactResult] }).valid).toBe(true);
    for (const changed of [
      { toolInput: { host: 'production', timer: 'cleanup' } },
      { toolExecuted: false }, { toolStatus: 'error' as const }, { isError: true },
      { toolResult: 'OK but target differs' },
    ]) {
      expect(validateObjectiveAcceptanceCriteria(textObjective, [root, { ...exactResult, ...changed }], receipt)).toHaveLength(1);
      expect(validateObjectiveOutcome(receipt, { objective: textObjective, messages: [root, { ...exactResult, ...changed }] }).valid).toBe(false);
    }
    const genericOnly = { ...textObjective, requiresAcceptanceCriteria: false, acceptanceCriteria: undefined };
    expect(validateObjectiveOutcome(receipt, { objective: genericOnly, messages: [root, exactResult] }).valid).toBe(false);
    expect(validateObjectiveOutcome({ ...receipt, criteria: receipt.criteria.map(item => (
      item.id === 'relevant-checks-passed' ? { ...item, evidence: [`tool:${criterion.toolName}`] } : item
    )) }, { objective: textObjective, messages: [root, exactResult] }).valid).toBe(true);
    expect(validateObjectiveOutcome({ ...receipt, criteria: receipt.criteria.map(item => (
      item.id === criterion.id || item.id === 'relevant-checks-passed'
        ? { ...item, evidence: [`tool:${criterion.toolName}`] }
        : item
    )) }, { objective: textObjective, messages: [root, exactResult] }).valid).toBe(true);
  });
  it('resolves persisted CRM and Gmail selectors without requiring a connector or data mutation', () => {
    const crmCriterion = { ...criterion, checks: [
      { path: '$.status', equals: 'open' }, { path: '$.step.id', equals: 17 },
    ] };
    const crmObjective = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }), [crmCriterion], 2,
    );
    expect(validateObjectiveAcceptanceCriteria(JSON.parse(JSON.stringify(crmObjective)), [root, {
      ...observation, toolResult: '{"status":"open","step":{"id":17}}',
    }], receipt)).toEqual([]);

    const gmailCriterion = { ...criterion, checks: [
      { path: '$[0].subject', equals: 'Intervention — entité et lieu' },
      { path: '$[0].labelIds[0]', equals: 'SENT' },
    ] };
    const gmailObjective = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }), [gmailCriterion], 2,
    );
    const sent = '[{"subject":"Intervention — entité et lieu","labelIds":["SENT"]}]';
    for (const toolResult of [sent, JSON.stringify({ content: [{ type: 'text', text: sent }] })]) {
      expect(validateObjectiveAcceptanceCriteria(gmailObjective, [root, { ...observation, toolResult }], receipt)).toEqual([]);
    }
    // Similar text, a different element and an object envelope are different facts.
    for (const toolResult of [
      sent.replace(' — entité', ' - entite'), sent.replace('SENT', 'DRAFT'),
      '[{}, {"subject":"Intervention — entité et lieu","labelIds":["SENT"]}]',
      JSON.stringify({ messages: JSON.parse(sent) }),
    ]) expect(validateObjectiveAcceptanceCriteria(gmailObjective, [root, { ...observation, toolResult }], receipt)).toHaveLength(1);
  });
  it('projects only the exact Gmail search summary into a bounded result count', () => {
    const searchCriterion: ObjectiveAcceptanceCriterion = {
      id: 'sent-reply-located', description: 'The exact sent reply is present.',
      toolName: 'mcp__google-contacts__gmail_search_exact',
      input: { query: 'in:sent subject:"Expected"', maxResults: 5 },
      checks: [{ path: '$.resultCount', equals: 1 }],
    };
    const registered = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }), [searchCriterion], 2,
    );
    const search: Message = { ...observation, toolName: searchCriterion.toolName,
      toolInput: { ...searchCriterion.input, _intent: 'Read-only verification.' },
      toolResult: '**Recherche Gmail API : « in:sent subject:"Expected" »**\n_1 message(s) retourné(s) ; lire le message exact avant toute action._\n\n### 1. Expected' };
    const claimed = { ...receipt, criteria: receipt.criteria.map(item => item.id === criterion.id
      ? { ...item, id: searchCriterion.id, evidence: ['t1'] }
      : item) };
    expect(validateObjectiveAcceptanceCriteria(registered, [root, search], claimed)).toEqual([]);
    expect(collectObjectiveAcceptanceObservations(registered, [root, search]))
      .toMatchObject([{ criterionId: searchCriterion.id, passed: true }]);
    const noneCriterion = { ...searchCriterion, checks: [{ path: '$.resultCount', equals: 0 }] };
    const noneObjective = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }), [noneCriterion], 2,
    );
    expect(validateObjectiveAcceptanceCriteria(noneObjective, [root, {
      ...search, toolResult: 'Aucun message Gmail trouvé pour : « in:sent subject:"Expected" »\n',
    }], claimed)).toEqual([]);
    for (const toolResult of [
      '**Recherche Gmail API : « in:sent subject:"Expected" »**\n_2 message(s) retourné(s) ; lire le message exact avant toute action._',
      'Résumé libre\n_1 message(s) retourné(s) ; lire le message exact avant toute action._',
      '**Recherche Gmail API : « in:sent subject:"Expected" »**\n_01 message(s) retourné(s) ; lire le message exact avant toute action._',
      '**Recherche Gmail API : « in:sent subject:"Expected" »**\n1 message retourné',
    ]) expect(validateObjectiveAcceptanceCriteria(registered, [root, { ...search, toolResult }], claimed)).toHaveLength(1);
  });
  it('uses host-retained Gmail metadata when media extraction replaces the original JSON', () => {
    const messageCriterion: ObjectiveAcceptanceCriterion = {
      id: 'sent-message', description: 'The sent message headers match.',
      toolName: 'mcp__google-contacts__gmail_get_message', input: { messageId: 'message-1' },
      checks: [
        { path: '$.to', equals: 'Recipient <recipient@example.com>' },
        { path: '$.from', equals: 'Sender <sender@example.com>' },
        { path: '$.subject', equals: 'Expected subject' },
        { path: '$.labelIds[0]', equals: 'SENT' },
      ],
    };
    const registered = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }), [messageCriterion], 2,
    );
    const tempRoot = mkdtempSync(join(tmpdir(), 'gmail-media-'));
    try {
      const artifactDir = join(tempRoot, 'sessions', 'session-1', 'long_responses');
      mkdirSync(artifactDir, { recursive: true });
      const originalPath = join(artifactDir, 'message_original.json');
      const linkedPath = join(artifactDir, 'message_linked.json');
      const originalJson = '{"id":"message-1","subject":"Expected subject","from":"Sender <sender@example.com>","to":"Recipient <recipient@example.com>","labelIds":["SENT"],"bodyHtml":"data:image/png;base64,AAAA"}';
      writeFileSync(originalPath, originalJson);
      writeFileSync(linkedPath, '{}');
      const digest = createHash('sha256').update(originalJson).digest('hex');
      const metadata = '{"id":"message-1","subject":"Expected subject","from":"Sender <sender@example.com>","to":"Recipient <recipient@example.com>","labelIds":["SENT"]}';
      const extracted: Message = { ...observation, toolName: messageCriterion.toolName,
        toolInput: messageCriterion.input,
        toolResult: `[Structured media assets extracted and saved]\n\nResult metadata JSON: ${metadata}\n\nOriginal JSON SHA256: ${digest}\nOriginal JSON: ${originalPath}\nLinked JSON: ${linkedPath}\nAssets extracted: 1` };
      const claimed = { ...receipt, criteria: receipt.criteria.map(item => item.id === criterion.id
        ? { ...item, id: messageCriterion.id, evidence: ['t1'] }
        : item) };
      expect(validateObjectiveAcceptanceCriteria(registered, [root, extracted], claimed, 'session-1')).toEqual([]);
      for (const changed of [
        { toolName: 'mcp__other__gmail_get_message' },
        { toolExecuted: undefined },
        { toolResult: `Prose\n${extracted.toolResult}` },
        { toolResult: extracted.toolResult!.replace(metadata, '{"to":"Recipient <recipient@example.com>","from":"Sender <sender@example.com>","subject":"Expected subject","labelIds":["SENT"],"bodyHtml":"forged"}') },
        { toolResult: extracted.toolResult!.replace(digest, '0'.repeat(64)) },
        { toolResult: extracted.toolResult!.replace(originalPath, join(artifactDir, 'missing.json')) },
      ]) expect(validateObjectiveAcceptanceCriteria(
        registered, [root, { ...extracted, ...changed }], claimed, 'session-1',
      )).toHaveLength(1);
      expect(validateObjectiveAcceptanceCriteria(registered, [root, extracted], claimed, 'foreign-session'))
        .toHaveLength(1);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
  it('projects only an exact WebFetch JSON wrapper bound to the requested URL', () => {
    const webCriterion: ObjectiveAcceptanceCriterion = {
      id: 'vendor-ready', description: 'The vendor endpoint reports ready.',
      toolName: 'WebFetch', input: { url: 'http://example.com/status' },
      checks: [{ path: '$.status', equals: 'ready' }],
    };
    const registered = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }), [webCriterion], 2,
    );
    const fetched: Message = { ...observation, toolName: 'WebFetch', toolInput: webCriterion.input,
      toolResult: 'JSON from https://example.com/status/:\n\n{"status":"ready"}' };
    const claimed = { ...receipt, criteria: receipt.criteria.map(item => item.id === criterion.id
      ? { ...item, id: webCriterion.id, evidence: ['t1'] } : item) };
    expect(validateObjectiveAcceptanceCriteria(registered, [root, fetched], claimed)).toEqual([]);
    expect(validateObjectiveAcceptanceCriteria(registered, [root, {
      ...fetched, toolResult: 'JSON from https://example.com/status:\n\n{"status":"ready"}',
    }], claimed)).toEqual([]);
    for (const toolResult of [
      'JSON from https://other.example/status/:\n\n{"status":"ready"}',
      'JSON from https://example.com/other:\n\n{"status":"ready"}',
      'JSON from https://example.com/status//:\n\n{"status":"ready"}',
      'JSON from https://example.com/status///:\n\n{"status":"ready"}',
      'JSON from https://example.com/status////evil/../:\n\n{"status":"ready"}',
      'Report\nJSON from https://example.com/status/:\n\n{"status":"ready"}',
      'JSON from https://example.com/status/:\n\nnot-json',
    ]) expect(validateObjectiveAcceptanceCriteria(registered, [root, { ...fetched, toolResult }], claimed)).toHaveLength(1);
  });
  it('projects successful native Bash transport for text or HTML curl output', () => {
    const bashCriterion: ObjectiveAcceptanceCriterion = {
      id: 'public-health', description: 'The public health request exits zero.', toolName: 'Bash',
      input: { command: 'curl --fail --silent https://example.com/health' },
      checks: [{ path: '$.transport.success', equals: true }, { path: '$.transport.code', equals: 0 }],
    };
    const registered = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }), [bashCriterion], 2,
    );
    const response: Message = { ...observation, toolName: 'Bash', toolInput: bashCriterion.input,
      toolResult: '<html><body>healthy</body></html>' };
    const claimed = { ...receipt, criteria: receipt.criteria.map(item => item.id === criterion.id
      ? { ...item, id: bashCriterion.id, evidence: ['t1'] } : item) };
    expect(validateObjectiveAcceptanceCriteria(registered, [root, response], claimed)).toEqual([]);
    for (const changes of [{ toolExecuted: false }, { toolStatus: 'error' as const, isError: true }]) {
      expect(validateObjectiveAcceptanceCriteria(registered, [root, { ...response, ...changes }], claimed)).toHaveLength(1);
    }
    expect(validateObjectiveAcceptanceCriteria(registered, [root, {
      ...response, toolResult: '{"status":"ready"}',
    }], claimed)).toEqual([]);
    expect(validateObjectiveAcceptanceCriteria(registered, [root, {
      ...response, toolResult: '"ready"',
    }], claimed)).toEqual([]);
    for (const toolResult of ['{}', 'true', 'null']) {
      expect(validateObjectiveAcceptanceCriteria(registered, [root, {
        ...response, toolExecuted: undefined, toolResult,
      }], claimed)).toHaveLength(1);
    }

    const curlWithoutFail = {
      ...bashCriterion,
      id: 'public-transport-only',
      input: { command: 'curl --silent https://example.com/health' },
    };
    const transportOnly = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }),
      [{ ...curlWithoutFail, checks: [{ path: '$.transport.code', equals: 0 }] }], 2,
    );
    const errorPage: Message = { ...response, toolInput: curlWithoutFail.input, toolResult: '<html>404</html>' };
    expect(validateObjectiveAcceptanceCriteria(transportOnly, [root, errorPage], {
      ...receipt, criteria: [{ id: curlWithoutFail.id, satisfied: true, evidence: ['t1'] }],
    })).toEqual([]);
    expect(() => registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }),
      [curlWithoutFail], 2, undefined, [root, errorPage],
    )).toThrow('unsupported shell transport predicate');

    for (const command of [
      'test -e /tmp/report.json',
      'cmp -s /tmp/report.json /tmp/expected.json',
      'curl --fail --silent -o /dev/null https://example.com/health',
    ]) {
      const emptyCriterion = { ...bashCriterion, id: `empty-${command.split(/\s+/, 1)[0]}`,
        input: { command }, checks: [{ path: '$.transport.code', equals: 0 }] };
      const emptyObjective = registerObjectiveAcceptanceCriteria(
        transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }), [emptyCriterion], 2,
      );
      const emptyResult = { ...response, toolInput: emptyCriterion.input, toolResult: '' };
      expect(validateObjectiveAcceptanceCriteria(emptyObjective, [root, emptyResult], {
        ...receipt, criteria: [{ id: emptyCriterion.id, satisfied: true, evidence: ['t1'] }],
      })).toEqual([]);
    }
  });
  it('uses only bounded host-retained metadata from a spilled exact result', () => {
    const metadataCriterion: ObjectiveAcceptanceCriterion = {
      id: 'release-validator', description: 'The release status check succeeds.', toolName: 'mcp__ops__get_status',
      input: { host: 'staging' }, checks: [{ path: '$.success', equals: true }, { path: '$.code', equals: 0 }],
    };
    const registered = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }), [metadataCriterion], 2,
    );
    const tempRoot = mkdtempSync(join(tmpdir(), 'acceptance-spill-'));
    try {
      const spillDir = join(tempRoot, 'sessions', 'session-1', 'long_responses');
      mkdirSync(spillDir, { recursive: true });
      const filePath = join(spillDir, 'result.txt');
      const fullText = '{"code":0,"success":true,"payload":"retained only on disk"}';
      writeFileSync(filePath, fullText);
      const digest = createHash('sha256').update(fullText).digest('hex');
      const result: Message = { ...observation, toolName: metadataCriterion.toolName, toolInput: metadataCriterion.input,
        toolResult: `[Large response (~9000 tokens) summarized]\n\nResult metadata JSON: {"code":0,"success":true}\n\nFull data SHA256: ${digest}\n\nFull data saved to: ${filePath}\n- Use Read/Grep to access specific content\n- Use transform_data with inputFiles: ["long_responses/result.txt"] for data analysis\n\nsummary` };
      const claimed = { ...receipt, criteria: receipt.criteria.map(item => item.id === criterion.id
        ? { ...item, id: metadataCriterion.id, evidence: ['t1'] } : item) };
      expect(validateObjectiveAcceptanceCriteria(registered, [root, result], claimed, 'session-1')).toEqual([]);
      for (const toolResult of [
        result.toolResult!.replace('{"code":0,"success":true}', '{"code":0,"success":false}'),
        `Prose before\n${result.toolResult}`,
        result.toolResult!.replace('Full data saved to: ', 'Data saved to: '),
        result.toolResult!.replace(digest, '0'.repeat(64)),
        result.toolResult!.replace(filePath, join(spillDir, 'missing.txt')),
      ]) expect(validateObjectiveAcceptanceCriteria(
        registered, [root, { ...result, toolResult }], claimed, 'session-1',
      )).toHaveLength(1);
      expect(validateObjectiveAcceptanceCriteria(registered, [root, result], claimed, 'foreign-session'))
        .toHaveLength(1);
      expect(validateObjectiveAcceptanceCriteria(registered, [root, {
        ...result, timestamp: Date.now() + 5_000,
      }], claimed, 'session-1')).toHaveLength(1);

      const webFullText = `JSON from https://example.com/status/:\n\n${JSON.stringify({ status: 'ready', payload: 'x'.repeat(20_000) })}`;
      const webPath = join(spillDir, 'web-fetch.txt');
      writeFileSync(webPath, webFullText);
      const webDigest = createHash('sha256').update(webFullText).digest('hex');
      const webCriterion: ObjectiveAcceptanceCriterion = {
        id: 'large-web-status', description: 'Large redirected vendor result is ready.', toolName: 'WebFetch',
        input: { url: 'http://example.com/status' }, checks: [{ path: '$.status', equals: 'ready' }],
      };
      const webObjective = registerObjectiveAcceptanceCriteria(
        transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }), [webCriterion], 2,
      );
      const webResult = { ...observation, toolName: 'WebFetch', toolInput: webCriterion.input,
        toolResult: `[Response too large (~9000 tokens)]\n\nResult metadata JSON: {"status":"ready"}\n\nFull data SHA256: ${webDigest}\n\nFull data saved to: ${webPath}\n- Use Read/Grep to access specific content\n- Use transform_data with inputFiles: ["long_responses/web-fetch.txt"] for data analysis\n\nPreview:\n...` };
      expect(validateObjectiveAcceptanceCriteria(webObjective, [root, webResult], {
        ...receipt, criteria: [{ id: webCriterion.id, satisfied: true, evidence: ['t1'] }],
      }, 'session-1')).toEqual([]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
  it('projects a real canonical browser navigation, but not a challenge or embedded claim', () => {
    const browserCriterion: ObjectiveAcceptanceCriterion = {
      id: 'public-route', description: 'The public route is reachable.',
      toolName: 'mcp__session__browser_tool', input: { command: 'navigate https://orion.example' },
      checks: [{ path: '$.success', equals: true }, { path: '$.url', equals: 'https://orion.example/requests' }],
    };
    const registered = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }), [browserCriterion], 2,
    );
    const navigation: Message = { ...observation, toolName: browserCriterion.toolName,
      toolInput: browserCriterion.input,
      toolResult: 'Navigated to: https://orion.example/requests\nTitle: Orion\nElapsed: 307ms' };
    const claimed = { ...receipt, criteria: receipt.criteria.map(item => item.id === criterion.id
      ? { ...item, id: browserCriterion.id, evidence: ['t1'] }
      : item) };
    expect(validateObjectiveAcceptanceCriteria(registered, [root, navigation], claimed)).toEqual([]);
    expect(collectObjectiveAcceptanceObservations(registered, [root, navigation]))
      .toMatchObject([{ criterionId: browserCriterion.id, passed: true }]);
    for (const toolResult of [
      'Security verification detected (cloudflare).\nURL: https://orion.example/',
      'Status report\nNavigated to: https://orion.example/requests',
      'Navigated to: javascript:alert(1)',
      ' Navigated to: https://orion.example/requests',
    ]) expect(validateObjectiveAcceptanceCriteria(registered, [root, { ...navigation, toolResult }], claimed)).toHaveLength(1);
  });
  it('projects exit zero only for an explicitly executed first-party OSS healthcheck', () => {
    const healthCriterion: ObjectiveAcceptanceCriterion = {
      id: 'oss-health', description: 'The OSS healthcheck exits successfully.',
      toolName: 'mcp__rbw-agents-oss__oss_healthcheck', input: { _displayName: 'Contrôler santé' },
      checks: [{ path: '$.success', equals: true }, { path: '$.code', equals: 0 }],
    };
    const registered = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }), [healthCriterion], 2,
    );
    const health: Message = { ...observation, toolName: healthCriterion.toolName,
      toolInput: healthCriterion.input,
      toolResult: '== docker compose ps ==\nservices healthy\n{"ok":true,"status":"passed"}' };
    const claimed = { ...receipt, criteria: receipt.criteria.map(item => item.id === criterion.id
      ? { ...item, id: healthCriterion.id, evidence: ['t1'] }
      : item) };
    expect(validateObjectiveAcceptanceCriteria(registered, [root, health], claimed)).toEqual([]);
    expect(collectObjectiveAcceptanceObservations(registered, [root, health]))
      .toMatchObject([{ criterionId: healthCriterion.id, passed: true }]);
    for (const changed of [
      { toolName: 'mcp__other__oss_healthcheck' },
      { toolExecuted: undefined },
      { toolResult: '' },
      { toolResult: '{"success":false,"code":1}' },
    ]) expect(validateObjectiveAcceptanceCriteria(registered, [root, { ...health, ...changed }], claimed)).toHaveLength(1);
  });
  it('keeps tool observation semantics when crediting an exact short registered check', () => {
    const cases: Array<{ toolName: string; input: ObjectiveAcceptanceCriterion['input']; valid: boolean }> = [
      { toolName: 'mcp__ops__get_status', input: { host: 'staging' }, valid: true },
      { toolName: 'Bash', input: { command: 'cat /tmp/status' }, valid: true },
      { toolName: 'Bash', input: { command: 'test -s /tmp/status && printf OK' }, valid: true },
      { toolName: 'Bash', input: { command: 'grep -q ready /tmp/status && echo OK' }, valid: true },
      { toolName: 'Bash', input: { command: 'cmp -s /tmp/status /tmp/expected && printf OK' }, valid: true },
      { toolName: 'Bash', input: { command: 'curl --fail --silent https://example.com/health' }, valid: true },
      { toolName: 'Bash', input: { command: 'python3 /tmp/validate_campaign.py' }, valid: true },
      { toolName: 'Bash', input: { command: 'bun run test:orion-contract' }, valid: true },
      { toolName: 'Bash', input: { command: "docker inspect -f '{{.State.Status}}' release-api" }, valid: true },
      { toolName: 'Bash', input: { command: 'docker ps --filter name=release-api' }, valid: true },
      { toolName: 'Bash', input: { command: 'systemctl is-active --quiet release-api.service' }, valid: true },
      { toolName: 'Bash', input: { command: 'gh pr view 20 --repo craft-ai-agents/craft-agents-oss --json state' }, valid: true },
      { toolName: 'mcp__ops__ssh_execute', input: { server: 'staging', cwd: '/srv/release',
        command: 'python3 /srv/validate_release.py' }, valid: true },
      { toolName: 'mcp__ops__exec_command', input: { host: 'staging',
        command: 'curl --fail --silent https://example.com/health' }, valid: true },
      { toolName: 'mcp__pipeline__get_and_process', input: { host: 'staging' }, valid: false },
      { toolName: 'mcp__ops__get_wait_status', input: { host: 'staging' }, valid: false },
      { toolName: 'mcp__session__wait_sessions', input: { sessionId: 'child' }, valid: false },
      { toolName: 'Bash', input: { command: 'printf OK' }, valid: false },
      { toolName: 'Bash', input: { command: 'python3 -c "print(\"OK\")"' }, valid: false },
      { toolName: 'Bash', input: { command: 'curl -X POST https://example.com/health' }, valid: false },
    ];
    for (const { toolName, input, valid } of cases) {
      const base = transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 });
      const candidate = { ...criterion, toolName, input, checks: [{ path: '$text', equals: 'OK' }] };
      if (!valid && isObjectiveShellExecutorToolName(toolName)) {
        expect(() => registerObjectiveAcceptanceCriteria(base, [candidate], 2))
          .toThrow('cannot serve as host-observed acceptance evidence');
        expect(base.acceptanceCriteria).toBeUndefined();
        continue;
      }
      const registered = registerObjectiveAcceptanceCriteria(base, [candidate], 2);
      const result = { ...observation, toolName, toolInput: input, toolResult: 'OK' };
      const outcome = validateObjectiveOutcome(receipt, { objective: registered, messages: [root, result] });
      expect(outcome.valid).toBe(valid);
      if (!valid) expect(outcome.gaps).toContain('criterion lacks observed evidence: relevant-checks-passed');
    }
  });
  it('compares the exact bounded Read payload while excluding only its authenticated continuation notice', () => {
    const expected = "alpha\nbeta\ngamma";
    const readCriterion: ObjectiveAcceptanceCriterion = {
      id: 'bounded-read', description: 'The exact selected source lines match.',
      toolName: 'functions.read',
      input: { path: '/tmp/selected.txt', offset: 23, limit: 3 },
      checks: [{ path: '$text', equals: expected }],
    };
    const registered = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }),
      [readCriterion], 2,
    );
    const checkReceipt: ObjectiveOutcomeDeclaration = {
      ...receipt,
      criteria: [
        { id: readCriterion.id, satisfied: true, evidence: ['read-result'] },
        ...registered.completionCriteria.map(id => ({
          id, satisfied: true, evidence: [id === 'relevant-checks-passed' ? 'read-result' : 'assistant-final'],
        })),
      ],
    };
    const result: Message = {
      id: 'read-result', toolUseId: 'read-use', role: 'tool', content: '',
      toolName: 'Read', toolStatus: 'completed', toolExecuted: true, timestamp: 4,
      toolInput: { path: '/tmp/selected.txt', offset: 23, limit: 3 },
      toolResult: expected + '\n\n[350 more lines in file. Use offset=26 to continue.]',
    };
    expect(validateObjectiveAcceptanceCriteria(registered, [root, result], checkReceipt)).toEqual([]);
    for (const changed of [
      { toolResult: expected + '\n\n[350 more lines in file. Use offset=27 to continue.]' },
      { toolResult: expected + '\n\n[350 more lines in file. Use offset=26 to continue.] extra' },
      { toolResult: expected + '\nwrong\n[350 more lines in file. Use offset=26 to continue.]' },
      { toolResult: expected + '\n\n[Showing lines 23-25 of 375. Use offset=26 to continue.]' },
      { toolName: 'Bash' },
      { toolExecuted: false },
      { toolInput: { path: '/tmp/other.txt', offset: 23, limit: 3 } },
    ] satisfies Array<Partial<Message>>) {
      expect(validateObjectiveAcceptanceCriteria(registered, [root, { ...result, ...changed }], checkReceipt))
        .toContain('Business criterion lacks matching post-action evidence: bounded-read');
    }
  });

  it('reads a frozen text predicate from a successful trusted SSH stdout envelope', () => {
    const command = 'test -r /srv/app/status && printf READY';
    const sshCriterion: ObjectiveAcceptanceCriterion = {
      id: 'ssh-status', description: 'The exact remote status file is readable.',
      toolName: 'mcp__rbw-servers__ssh_execute',
      input: { server: 'interne', cwd: '/srv/app', command },
      checks: [{ path: '$text', equals: 'READY' }],
    };
    const registered = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }),
      [sshCriterion], 2,
    );
    const envelope = {
      server: 'interne', command: 'cd /srv/app && ' + command,
      stdout: 'READY', stderr: '', code: 0, success: true,
    };
    const observed: Message = {
      ...observation, id: 'ssh-status-result', toolUseId: 'ssh-status-call',
      toolName: sshCriterion.toolName, toolInput: sshCriterion.input,
      toolResult: JSON.stringify(envelope),
    };
    const claim: ObjectiveOutcomeDeclaration = {
      state: 'complete_verified', blocker: null, remainingWork: [],
      criteria: [{ id: sshCriterion.id, satisfied: true, evidence: [observed.id] }],
    };
    expect(validateObjectiveAcceptanceCriteria(registered, [root, observed], claim)).toEqual([]);
    expect(collectObjectiveAcceptanceObservations(registered, [root, observed]))
      .toMatchObject([{ criterionId: sshCriterion.id, passed: true }]);
    expect(registered.acceptanceCriteria?.[0]?.checks).toEqual([{ path: '$text', equals: 'READY' }]);

    for (const invalid of [
      { ...envelope, stdout: 'OTHER' },
      { ...envelope, stderr: 'warning' },
      { ...envelope, code: 1 },
      { ...envelope, success: false },
    ]) {
      const changed = { ...observed, toolResult: JSON.stringify(invalid) };
      expect(collectObjectiveAcceptanceObservations(registered, [root, changed]))
        .toMatchObject([{ criterionId: sshCriterion.id, passed: false }]);
    }
    expect(collectObjectiveAcceptanceObservations(registered, [root, {
      ...observed, toolName: 'mcp__other__ssh_execute',
    }])).toEqual([]);
    expect(collectObjectiveAcceptanceObservations(registered, [root, {
      ...observed, toolInput: { ...sshCriterion.input, command: 'cat /srv/app/status' },
    }])).toEqual([]);
  });

  it('accepts the rbw SSH connector code as exitCode without accepting another target or failed execution', () => {
    const input = {
      server: 'dev', cwd: '/opt/ia-webdev/agent-dev/worktrees/orion/campaign',
      command: "sed -n '1,220p' docs/orion/activation.md deploy/orion/README.md",
    };
    const sshCriterion: ObjectiveAcceptanceCriterion = {
      id: 'orion-docs-read', description: 'The requested remote documents were read successfully.',
      toolName: 'mcp__rbw-servers__ssh_execute', input,
      checks: [{ path: '$.exitCode', equals: 0 }],
    };
    const registered = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }),
      [sshCriterion], 2,
    );
    const envelope = {
      server: input.server, command: `cd ${input.cwd} && ${input.command}`,
      stdout: 'document contents', stderr: '', code: 0, success: true,
    };
    const result: Message = {
      ...observation, id: 'orion-read', toolUseId: 'orion-read-call',
      toolName: sshCriterion.toolName, toolInput: input, toolResult: JSON.stringify(envelope),
    };
    expect(isObjectiveMutationTool(result)).toBe(false);
    expect(isObjectiveMutationTool({
      ...result, toolInput: { ...input, command: "sed -i '' 's/old/new/' docs/orion/activation.md" },
    })).toBe(true);
    const claim: ObjectiveOutcomeDeclaration = {
      state: 'complete_verified', blocker: null, remainingWork: [],
      criteria: [
        { id: sshCriterion.id, satisfied: true, evidence: [result.toolUseId!] },
        ...registered.completionCriteria.map(id => ({
          id, satisfied: true,
          evidence: [id === 'relevant-checks-passed' ? result.toolUseId! : 'assistant-final'],
        })),
      ],
    };
    expect(validateObjectiveOutcome(claim, { objective: registered, messages: [root, result] }))
      .toMatchObject({ state: 'complete_verified', valid: true, gaps: [] });
    for (const changed of [
      { toolExecuted: false }, { toolStatus: 'error' as const },
      { toolResult: JSON.stringify({ ...envelope, server: 'prod' }) },
      { toolResult: JSON.stringify({ ...envelope, command: 'cd /elsewhere && ' + input.command }) },
      { toolResult: JSON.stringify({ ...envelope, code: 1, success: false }) },
      { toolResult: JSON.stringify({ ...envelope, code: '0' }) },
    ] satisfies Array<Partial<Message>>) {
      expect(validateObjectiveOutcome(claim, {
        objective: registered, messages: [root, { ...result, ...changed }],
      }).valid).toBe(false);
    }
  });

  it('requires exact target, real invocation and post-mutation evidence for a registered validation script', () => {
    const command = 'python3 /tmp/validate_campaign.py >/dev/null && printf \'{"ok":true}\\n\'';
    const registered = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }),
      [{ ...criterion, toolName: 'Bash', input: { command }, checks: [{ path: '$text', equals: '{"ok":true}' }] }], 2,
    );
    const result = { ...observation, toolName: 'Bash', toolInput: { command }, toolResult: '{"ok":true}\n' };
    expect(validateObjectiveOutcome(receipt, { objective: registered, messages: [root, result] }).valid).toBe(true);
    for (const changes of [
      { toolInput: { command: 'python3 /tmp/validate_other_campaign.py' } },
      { timestamp: 0 }, { toolUseId: 'different-call', id: 'different-message' },
      { toolExecuted: false }, { toolStatus: 'error' as const }, { isError: true },
      { toolResult: '{"ok":false}\n' }, { toolResult: '{"ok":true}\nERROR' },
    ]) expect(validateObjectiveOutcome(receipt, { objective: registered, messages: [root, { ...result, ...changes }] }).valid).toBe(false);
    const mutation: Message = { ...observation, id: 'later-write', toolUseId: 'later-write', toolName: 'Write', toolInput: { file_path: '/tmp/campaign' }, timestamp: 5 };
    expect(validateObjectiveOutcome(receipt, { objective: registered, messages: [root, result, mutation] }).valid).toBe(false);
    const otherRoot: Message = { ...root, id: 'other-objective', timestamp: 6 };
    expect(validateObjectiveOutcome(receipt, { objective: { ...registered, userMessageId: otherRoot.id }, messages: [root, result, otherRoot] }).valid).toBe(false);
    const invented = { ...receipt, criteria: receipt.criteria.map(item => ({ ...item, evidence: ['t_invented'] })) };
    expect(validateObjectiveOutcome(invented, { objective: registered, messages: [root, result] }).valid).toBe(false);
  });
  it('preserves sequential sibling observations from exact bounded registered inspections', () => {
    const fields = ['state', 'mergeStateStatus', 'statusCheckRollup'];
    const criteria: ObjectiveAcceptanceCriterion[] = fields.map(field => ({
      id: `pr20-${field.toLowerCase()}`, description: `PR 20 ${field} is verified`,
      toolName: 'Bash',
      input: { command: `gh pr view 20 --repo craft-ai-agents/craft-agents-oss --json ${field}` },
      checks: [{ path: '$.success', equals: true }],
    }));
    const registered = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }),
      criteria,
      2,
    );
    const observations: Message[] = criteria.map((item, index) => ({
      ...observation,
      id: `pr20-observation-${index}`,
      toolUseId: `pr20-call-${index}`,
      timestamp: 3 + index,
      toolName: item.toolName,
      toolInput: item.input,
      toolResult: '{"success":true}',
    }));
    const claimed: ObjectiveOutcomeDeclaration = {
      state: 'complete_verified', blocker: null, remainingWork: [],
      criteria: [
        ...criteria.map((item, index) => ({
          id: item.id, satisfied: true, evidence: [observations[index]!.toolUseId!],
        })),
        ...registered.completionCriteria.map(id => ({
          id, satisfied: true,
          evidence: [id === 'relevant-checks-passed'
            ? observations[observations.length - 1]!.toolUseId! : 'assistant-final'],
        })),
      ],
    };
    expect(validateObjectiveOutcome(claimed, {
      objective: registered, messages: [root, ...observations],
    })).toMatchObject({ state: 'complete_verified', valid: true, gaps: [] });

    const laterMutation: Message = {
      ...observation, id: 'pr20-later-mutation', toolUseId: 'pr20-later-mutation', timestamp: 9,
      toolName: 'Bash', toolInput: { command: 'git checkout main' }, toolResult: 'Switched to main',
    };
    expect(validateObjectiveOutcome(claimed, {
      objective: registered, messages: [root, ...observations, laterMutation],
    }).valid).toBe(false);
  });
  it('rejects mutually invalidating opaque validators before freezing an impossible contract', () => {
    const criteria: ObjectiveAcceptanceCriterion[] = ['merged', 'ci'].map(mode => ({
      id: `pr20-${mode}`, description: `PR 20 ${mode} state is verified`,
      toolName: 'mcp__ops__ssh_execute',
      input: { server: 'dev', command: `/tmp/pr20/verify-pr20.sh ${mode}` },
      checks: [{ path: '$.success', equals: true }],
    }));
    const base = transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 });
    expect(() => registerObjectiveAcceptanceCriteria(
      base,
      criteria,
      2,
    )).toThrow('Consolidate them into one read-only invocation');
    expect(base.acceptanceCriteria).toBeUndefined();

    const sharedCommand = '/tmp/pr20/verify-pr20.sh all';
    expect(() => registerObjectiveAcceptanceCriteria(base, criteria.map((item, index) => ({
      ...item,
      input: { server: 'dev', command: sharedCommand },
      checks: [{ path: index === 0 ? '$.merged' : '$.ci', equals: true }],
    })), 3)).not.toThrow();

    expect(() => registerObjectiveAcceptanceCriteria(base, criteria.map((item, index) => ({
      ...item,
      input: { server: 'dev', projectId: `project-${index}`, command: String(item.input.command) },
    })), 4)).not.toThrow();
  });
  it('accepts equivalent dotted/indexed registration without changing frozen criteria or review binding', () => {
    const indexed = { ...criterion, toolName: 'functions.bash', input: { command: 'cat /tmp/verified.json', 'target.ids.0': 17 }, checks: [
      { path: '$.items[0].status', equals: 'ready' }, { path: '$.ok', equals: true },
    ] };
    const initial = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }), [indexed], 2,
    );
    const equivalent = { ...indexed, toolName: 'Bash', input: { '$.target.ids[0]': 17, '$.command': 'cat /tmp/verified.json' }, checks: [
      { path: 'ok', equals: true }, { path: 'items.0.status', equals: 'ready' },
    ] };
    const repeated = registerObjectiveAcceptanceCriteria(initial, [equivalent], 99);
    expect(repeated).toEqual(initial);
    expect(objectiveReviewBinding(repeated)).toEqual(objectiveReviewBinding(initial));
    for (const changed of [
      { ...equivalent, input: { command: 'cat /tmp/another-target.json', 'target.ids.0': 17 } },
      { ...equivalent, checks: [{ path: 'ok', equals: true }] },
      { ...equivalent, checks: [{ path: 'ok', equals: false }, { path: 'items.0.status', equals: 'ready' }] },
      { ...equivalent, checks: [{ path: 'ok', equals: true }, { path: 'items.1.status', equals: 'ready' }] },
      { ...equivalent, toolName: 'mcp__other__bash' },
    ]) expect(() => registerObjectiveAcceptanceCriteria(initial, [changed], 100)).toThrow('cannot be weakened');
  });
  it('recognizes native callable names while keeping MCP namespaces and inputs exact', () => {
    const bashCriterion = { ...criterion, toolName: 'functions.bash', input: { command: 'cat /tmp/state.json' }, checks: [{ path: '$.ok', equals: true }] };
    const bashObjective = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }), [bashCriterion], 2,
    );
    const bashObservation = { ...observation, toolName: 'Bash', toolInput: { command: 'cat /tmp/state.json' }, toolResult: '{"ok":true}' };
    for (const toolName of ['Bash', 'bash', 'functions.bash']) {
      expect(validateObjectiveAcceptanceCriteria(bashObjective, [root, { ...bashObservation, toolName }], receipt)).toEqual([]);
    }
    for (const changed of [
      { toolName: 'mcp__other__bash' }, { toolName: 'other.bash' }, { toolName: 'functions_bash' },
      { toolInput: { command: 'cat ./tmp/state.json' } },
      { toolInput: { command: 'cat /tmp/other-state.json' } },
      { toolResult: 'SUCCESS: {"ok":true}' },
    ]) expect(validateObjectiveAcceptanceCriteria(bashObjective, [root, { ...bashObservation, ...changed }], receipt)).toHaveLength(1);
    const namespaced = { ...criterion, toolName: `functions.${criterion.toolName}` };
    const namespacedObjective = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }), [namespaced], 2,
    );
    expect(validateObjectiveAcceptanceCriteria(namespacedObjective, [root, observation], receipt)).toHaveLength(1);
    for (const ref of ['tool:Bash', 'tool:bash', 'tool:functions.bash']) {
      expect(validateObjectiveAcceptanceCriteria(bashObjective, [root, bashObservation], {
        ...receipt, criteria: [{ id: criterion.id, satisfied: true, evidence: [ref] }],
      })).toEqual([]);
    }
    expect(validateObjectiveAcceptanceCriteria(bashObjective, [root, bashObservation], {
      ...receipt, criteria: [{ id: criterion.id, satisfied: true, evidence: ['tool:BASH'] }],
    })).toHaveLength(1);
    const repeatedBash = { ...bashObservation, id: 'bash-second', toolUseId: 'bash-second',
      toolName: 'functions.bash', timestamp: 5 };
    expect(validateObjectiveAcceptanceCriteria(bashObjective, [root, bashObservation, repeatedBash], {
      ...receipt, criteria: [{ id: criterion.id, satisfied: true, evidence: ['tool:bash'] }],
    })).toEqual([]);
    expect(validateObjectiveAcceptanceCriteria(bashObjective, [root, bashObservation, repeatedBash], {
      ...receipt, criteria: [{ id: criterion.id, satisfied: true, evidence: ['bash-second'] }],
    })).toEqual([]);
  });
  it('reconciles only persisted MCP path fields under bounded workspace roots', () => {
    const validatePath = (
      inputPath: string,
      observedPath: string,
      inputKey = 'path',
      toolName = 'mcp__ops__read_file',
    ): string[] => {
      const pathCriterion: ObjectiveAcceptanceCriterion = {
        id: 'workspace-state', description: 'The exact workspace state is ready.',
        toolName, input: { [inputKey]: inputPath }, checks: [{ path: '$.status', equals: 'ready' }],
      };
      const registered = registerObjectiveAcceptanceCriteria(
        transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }),
        [pathCriterion],
        2,
      );
      const pathObservation: Message = {
        ...observation, id: 'workspace-path-observation', toolUseId: 'workspace-path-observation',
        toolName, toolInput: { [inputKey]: observedPath }, toolResult: '{"status":"ready"}',
      };
      const pathReceipt: ObjectiveOutcomeDeclaration = {
        state: 'complete_verified', blocker: null, remainingWork: [],
        criteria: [{ id: pathCriterion.id, satisfied: true, evidence: [pathObservation.toolUseId!] }],
      };
      return validateObjectiveAcceptanceCriteria(registered, [root, pathObservation], pathReceipt);
    };

    for (const [inputPath, observedPath, inputKey] of [
      ['/Users/example/project/state.json', './Users/example/project/state.json', 'path'],
      ['./home/craft/project/state.json', '/home/craft/project/state.json', 'file_path'],
      ['/srv/release/state.json', './srv/release/state.json', 'remotePath'],
    ] as const) {
      expect(validatePath(inputPath, observedPath, inputKey)).toEqual([]);
    }

    for (const [inputPath, observedPath, inputKey, toolName] of [
      ['/etc/state.json', './etc/state.json', 'path', 'mcp__ops__read_file'],
      ['/Users/example/project/state.json', './Users/example/project/other.json', 'path', 'mcp__ops__read_file'],
      ['/home/craft/project/state.json', './srv/craft/project/state.json', 'path', 'mcp__ops__read_file'],
      ['/srv/release/../secret.json', './srv/release/../secret.json', 'path', 'mcp__ops__read_file'],
      ['/home/craft/./state.json', './home/craft/./state.json', 'path', 'mcp__ops__read_file'],
      ['/Users/example/project/state.json', './Users/example/project/state.json', 'target', 'mcp__ops__read_file'],
      ['/Users/example/project/state.json', './Users/example/project/state.json', 'path', 'Read'],
    ] as const) {
      expect(validatePath(inputPath, observedPath, inputKey, toolName)).toHaveLength(1);
    }
  });
  it('rejects unsupported or dangerous selectors before freezing an objective', () => {
    for (const path of [
      '', '$.', '$foo', 'foo.', 'foo..id', '$..id', 'foo.[0]', 'foo[0]id',
      '$[*]', '$[-1]', '$[01]', '$[0:2]', '$[?(@.ok)]', '$["ok"]',
      'foo.*', 'foo[0].constructor', '$.__proto__.ok', 'foo.prototype.ok', 'foo[0].__proto__',
      'foo[0', 'foo]0', 'foo bar', 'foo;ok', 'foo()','a'.repeat(257),
    ]) {
      expect(() => registerObjectiveAcceptanceCriteria(
        transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }),
        [{ ...criterion, checks: [{ path, equals: true }] }], 2,
      )).toThrow('Invalid JSON selector');
    }
    const invalidInputs: ObjectiveAcceptanceCriterion['input'][] = [{ '$text': 'ok' }, { '$': 'ok' }, { id: 1, '$.id': 1 }];
    for (const input of invalidInputs) {
      expect(() => registerObjectiveAcceptanceCriteria(
        transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }), [{ ...criterion, input }], 2,
      )).toThrow('Invalid JSON selector');
    }
    expect(() => registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }),
      [{ ...criterion, checks: [{ path: 'ok', equals: true }, { path: '$.ok', equals: true }] }], 2,
    )).toThrow('Invalid JSON selector');
    for (const equals of [true, false, 0, null]) {
      expect(() => registerObjectiveAcceptanceCriteria(
        transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }),
        [{ ...criterion, checks: [{ path: '$text', equals }] }], 2,
      )).toThrow('Invalid JSON selector');
    }
    expect(objective.acceptanceCriteria).toEqual([criterion]);
  });
  it('reads only own data properties and supports explicit scalar JSON roots', () => {
    const input = Object.create({ host: 'dev' }) as Record<string, unknown>;
    input.timer = 'cleanup';
    expect(validateObjectiveAcceptanceCriteria(objective, [root, { ...observation, toolInput: input }], receipt)).toHaveLength(1);
    Object.defineProperty(input, 'host', { get() { throw new Error('must not invoke accessors'); } });
    expect(validateObjectiveAcceptanceCriteria(objective, [root, { ...observation, toolInput: input }], receipt)).toHaveLength(1);
    const scalarObjective = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }),
      [{ ...criterion, checks: [{ path: '$', equals: true }] }], 2,
    );
    expect(validateObjectiveAcceptanceCriteria(scalarObjective, [root, { ...observation, toolResult: 'true' }], receipt)).toEqual([]);
    expect(validateObjectiveAcceptanceCriteria(scalarObjective, [root, { ...observation, toolResult: 'false' }], receipt)).toHaveLength(1);
  });
  it('preserves verified observations after internal result delivery without treating the delivery as business evidence', () => {
    for (const toolName of ['send_agent_message', 'session__send_agent_message', 'mcp__session__send_agent_message']) {
      const delivery: Message = { ...observation, id: 'delivery', toolUseId: 'delivery', timestamp: 5,
        toolName, toolInput: { targetSessionId: 'parent', message: 'Verification complete' }, toolResult: '{"status":"delivered"}' };
      expect(validateObjectiveAcceptanceCriteria(objective, [root, observation, delivery], receipt)).toEqual([]);
      const deliveryObjective = registerObjectiveAcceptanceCriteria(
        transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }),
        [{ ...criterion, toolName, input: { targetSessionId: 'parent' }, checks: [{ path: 'status', equals: 'delivered' }] }], 2,
      );
      expect(validateObjectiveAcceptanceCriteria(deliveryObjective, [root, delivery], {
        ...receipt, criteria: [{ id: criterion.id, satisfied: true, evidence: ['delivery'] }],
      })).toHaveLength(1);
      const textDeliveryObjective = registerObjectiveAcceptanceCriteria(
        transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }),
        [{ ...criterion, toolName, input: { targetSessionId: 'parent' }, checks: [{ path: '$text', equals: 'OK' }] }], 2,
      );
      expect(validateObjectiveAcceptanceCriteria(textDeliveryObjective, [root, { ...delivery, toolResult: 'OK' }], {
        ...receipt, criteria: [{ id: criterion.id, satisfied: true, evidence: ['delivery'] }],
      })).toHaveLength(1);
    }
    for (const toolName of ['mcp__gmail__send_message', 'mcp__other__send_agent_message']) {
      const mutation = { ...observation, id: 'sent', toolUseId: 'sent', timestamp: 5, toolName };
      expect(validateObjectiveAcceptanceCriteria(objective, [root, observation, mutation], receipt)).toHaveLength(1);
    }
  });
  it('resolves a tool-name alias only to the latest exact current criterion observation', () => {
    const aliasReceipt = { ...receipt, criteria: [
      { id: criterion.id, satisfied: true, evidence: [`tool:${criterion.toolName}`] },
    ] };
    expect(validateObjectiveAcceptanceCriteria(objective, [root, observation], aliasReceipt)).toEqual([]);

    const wrongTarget = { ...observation, toolInput: { host: 'production', timer: 'cleanup' } };
    expect(validateObjectiveAcceptanceCriteria(objective, [root, wrongTarget], aliasReceipt)).toHaveLength(1);
    expect(validateObjectiveAcceptanceCriteria(objective, [root, { ...observation, timestamp: 0 }], aliasReceipt)).toHaveLength(1);

    const mutation: Message = { ...observation, id: 'mutation', toolUseId: 'mutation', timestamp: 5,
      toolName: 'Edit', toolInput: { file_path: '/tmp/timer' }, toolResult: 'updated' };
    expect(validateObjectiveAcceptanceCriteria(objective, [root, observation, mutation], aliasReceipt)).toHaveLength(1);

    const failed = { ...observation, toolStatus: 'error' as const, isError: true, toolResult: 'request failed' };
    expect(validateObjectiveAcceptanceCriteria(objective, [root, failed], aliasReceipt)).toHaveLength(1);

    const second = { ...observation, id: 'm2', toolUseId: 't2', timestamp: 5 };
    expect(validateObjectiveAcceptanceCriteria(objective, [root, observation, second], aliasReceipt)).toEqual([]);
    expect(validateObjectiveAcceptanceCriteria(objective, [root, observation, second], {
      ...aliasReceipt, criteria: [{ id: criterion.id, satisfied: true, evidence: ['t2'] }],
    })).toEqual([]);

    for (const ref of ['assistant-final', 'tool:mcp__other__get_timer', `tool:${criterion.toolName.toUpperCase()}`]) {
      expect(validateObjectiveAcceptanceCriteria(objective, [root, observation], {
        ...aliasReceipt, criteria: [{ id: criterion.id, satisfied: true, evidence: [ref] }],
      })).toHaveLength(1);
    }
  });
  it('freezes expectations and registration time; only additive changes are allowed', () => {
    expect(registerObjectiveAcceptanceCriteria(objective, [criterion], 99)).toEqual(objective);
    expect(() => registerObjectiveAcceptanceCriteria(objective, [{ ...criterion, checks: [{ path: 'enabled', equals: false }] }])).toThrow('cannot be weakened');
    expect(() => registerObjectiveAcceptanceCriteria(objective, [{ ...criterion, input: { 'constructor.prototype': true } }])).toThrow();
    expect(() => registerObjectiveAcceptanceCriteria(objective, [criterion, criterion])).toThrow();
  });
  it('supersedes only an explicitly versioned criterion with a current negative observation', () => {
    const negative = {
      ...observation,
      id: 'negative-observation',
      toolUseId: 'negative-observation',
      toolResult: '{"enabled":false,"nextRunScheduled":true}',
    };
    const corrected: ObjectiveAcceptanceCriterion = {
      ...criterion,
      id: 'timer-active_v2',
      supersedes: 'timer-active',
    };
    const revised = registerObjectiveAcceptanceCriteria(
      objective,
      [corrected],
      10,
      undefined,
      [root, negative],
    );
    expect(revised.acceptanceCriteria).toEqual([corrected]);
    expect(revised.acceptanceRegisteredAtById).toEqual({ 'timer-active_v2': 10 });
    expect(revised.acceptanceHistory?.at(-1)).toMatchObject({
      revision: 'criterion-correction:timer-active',
      criteria: [criterion],
      registeredAt: 2,
    });
    expect(objectiveReviewBinding(revised)).not.toEqual(objectiveReviewBinding(objective));

    const nextVersion: ObjectiveAcceptanceCriterion = {
      ...corrected,
      id: 'timer-active_v3',
      supersedes: 'timer-active_v2',
    };
    expect(() => registerObjectiveAcceptanceCriteria(
      revised,
      [nextVersion],
      11,
      undefined,
      [root, negative],
    )).toThrow('must be re-observed after that exact version was registered');
    const freshNegative = {
      ...negative,
      id: 'negative-observation-v2',
      toolUseId: 'negative-observation-v2',
      timestamp: 12,
    };
    expect(registerObjectiveAcceptanceCriteria(
      revised,
      [nextVersion],
      13,
      undefined,
      [root, negative, freshNegative],
    ).acceptanceCriteria).toEqual([nextVersion]);

    for (const [candidate, transcript, error] of [
      [{ ...corrected, id: 'timer-active_v3' }, [root, negative], 'next explicit version ID'],
      [corrected, [root, observation], 'negative result'],
      [corrected, [root], 'negative result'],
      [{ ...corrected, requirementId: 'changed-requirement' }, [root, negative], 'preserve requirementId'],
      [{ ...corrected, checks: [{ path: 'enabled', equals: false }] }, [root, negative], 'preserve the exact'],
      [{ ...corrected, checks: [...criterion.checks, { path: 'scheduled', equals: true }] }, [root, negative], 'preserve the exact'],
      [{ ...corrected, input: { host: 'prod', timer: 'cleanup' } }, [root, negative], 'preserve the exact'],
      [{ ...corrected, toolName: 'mcp__other__get_timer' }, [root, negative], 'preserve the exact'],
    ] as const) {
      expect(() => registerObjectiveAcceptanceCriteria(
        objective,
        [candidate as ObjectiveAcceptanceCriterion],
        10,
        undefined,
        [...transcript],
      )).toThrow(error);
    }

    const merelyAdded = registerObjectiveAcceptanceCriteria(
      objective,
      [{ ...corrected, supersedes: undefined }],
      10,
    );
    expect(merelyAdded.acceptanceCriteria?.map(item => item.id)).toEqual([
      'timer-active',
      'timer-active_v2',
    ]);
  });
  it('allows only a complete identical criteria replay during terminal reconciliation', () => {
    const additional: ObjectiveAcceptanceCriterion = {
      ...criterion,
      id: 'timer-visible',
      description: 'The authorized timer remains visible on the requested host',
      checks: [{ path: 'visible', equals: true }],
    };
    const registered = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }),
      [criterion, additional],
      2,
    );
    const terminal = {
      ...registered,
      terminalReconciliation: { messageId: 'reconcile-terminal', timestamp: 10 },
    };
    const beforeCriteria = structuredClone(terminal.acceptanceCriteria);
    const beforeBinding = objectiveReviewBinding(terminal);

    const repeated = registerObjectiveAcceptanceCriteria(
      terminal,
      structuredClone(terminal.acceptanceCriteria!),
      99,
    );
    expect(repeated).toBe(terminal);
    expect(repeated.acceptanceRegisteredAt).toBe(registered.acceptanceRegisteredAt);
    expect(objectiveReviewBinding(repeated)).toEqual(beforeBinding);

    for (const candidate of [
      [{ ...criterion, description: 'Changed terminal expectation' }, additional],
      [criterion, additional, { ...additional, id: 'timer-route' }],
      [criterion],
    ]) {
      expect(() => registerObjectiveAcceptanceCriteria(terminal, candidate, 100))
        .toThrow('Terminal reconciliation freezes the registered acceptance contract');
      expect(terminal.acceptanceCriteria).toEqual(beforeCriteria);
      expect(objectiveReviewBinding(terminal)).toEqual(beforeBinding);
    }
  });
  it('rejects procedure and requirement changes during terminal reconciliation', () => {
    const base = transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 });
    const procedural = registerObjectiveAcceptanceCriteria(base, [criterion], 2, 'software-change');
    const terminal = {
      ...procedural,
      terminalReconciliation: { messageId: 'reconcile-terminal', timestamp: 10 },
    };
    const beforeBinding = objectiveReviewBinding(terminal);

    expect(registerObjectiveAcceptanceCriteria(terminal, [structuredClone(criterion)], 20, 'software-change'))
      .toBe(terminal);
    expect(() => registerObjectiveAcceptanceCriteria(
      terminal,
      [{ ...criterion, requirementId: 'requested-behavior' }],
      21,
      'software-change',
    )).toThrow('Terminal reconciliation freezes the registered acceptance contract');
    expect(() => registerObjectiveAcceptanceCriteria(terminal, [criterion], 22, 'document-package'))
      .toThrow('Terminal reconciliation freezes the registered acceptance contract');
    expect(objectiveReviewBinding(terminal)).toEqual(beforeBinding);

    const requirementCriterion: ObjectiveAcceptanceCriterion = {
      ...criterion,
      requirementId: 'requested-behavior',
    };
    const requirementBound = registerObjectiveAcceptanceCriteria(
      base,
      [requirementCriterion],
      3,
      'software-change',
    );
    const requirementTerminal = {
      ...requirementBound,
      terminalReconciliation: { messageId: 'reconcile-requirement', timestamp: 12 },
    };
    const requirementBinding = objectiveReviewBinding(requirementTerminal);
    expect(() => registerObjectiveAcceptanceCriteria(requirementTerminal, [{
      ...requirementCriterion,
      requirementId: 'regression-checks',
    }], 23, 'software-change')).toThrow(
      'Terminal reconciliation freezes the registered acceptance contract',
    );
    expect(objectiveReviewBinding(requirementTerminal)).toEqual(requirementBinding);

    const withoutProcedure = {
      ...objective,
      terminalReconciliation: { messageId: 'reconcile-without-procedure', timestamp: 11 },
    };
    const unboundProcedure = objectiveReviewBinding(withoutProcedure);
    expect(() => registerObjectiveAcceptanceCriteria(withoutProcedure, [criterion], 24, 'software-change'))
      .toThrow('Terminal reconciliation freezes the registered acceptance contract');
    expect(objectiveReviewBinding(withoutProcedure)).toEqual(unboundProcedure);
  });
  it('permits exactly the initial registration when terminal reconciliation has no contract yet', () => {
    const unregistered = {
      ...transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }),
      requiresAcceptanceCriteria: true,
      terminalReconciliation: {
        messageId: 'reconcile-before-registration',
        timestamp: 2,
        initialAcceptanceRegistrationRequired: true as const,
      },
    };
    expect(unregistered.acceptanceCriteria).toBeUndefined();

    const preMarkerObservation: Message = {
      ...observation,
      id: 'pre-marker-observation',
      toolUseId: 'pre-marker-observation',
      timestamp: 1.5,
    };
    const marker: Message = {
      id: 'reconcile-before-registration',
      role: 'user',
      content: 'Réconcilie uniquement les reçus existants, sans nouvel effet externe.',
      timestamp: 2,
    };
    const transcript = [root, preMarkerObservation, marker];

    const first = registerObjectiveAcceptanceCriteria(
      unregistered,
      [criterion],
      3,
      undefined,
      transcript,
    );
    expect(first.acceptanceCriteria).toEqual([criterion]);
    expect(first.procedure).toBeUndefined();
    expect(first.terminalReconciliation).toEqual(unregistered.terminalReconciliation);

    expect(registerObjectiveAcceptanceCriteria(first, [structuredClone(criterion)], 4))
      .toBe(first);
    expect(() => registerObjectiveAcceptanceCriteria(first, [{
      ...criterion, description: 'Changed after the initial registration',
    }], 5)).toThrow(
      'Terminal reconciliation freezes the registered acceptance contract',
    );

    const arbitraryLocalRead: ObjectiveAcceptanceCriterion = {
      id: 'read-arbitrary-system-file',
      description: 'An arbitrary system file contains a chosen value.',
      toolName: 'Read',
      input: { file_path: '/etc/passwd' },
      checks: [{ path: '$text', equals: 'root' }],
    };
    expect(() => registerObjectiveAcceptanceCriteria(
      unregistered,
      [arbitraryLocalRead],
      3,
      undefined,
      transcript,
    )).toThrow('already satisfied by exact persisted read-only observations');
    expect(() => registerObjectiveAcceptanceCriteria(
      unregistered,
      [criterion],
      3,
      undefined,
      [root, marker, preMarkerObservation],
    )).toThrow('already satisfied by exact persisted read-only observations');

    const noContractRequired = {
      ...unregistered,
      requiresAcceptanceCriteria: undefined,
      terminalReconciliation: { messageId: 'reconcile-without-contract', timestamp: 6 },
    };
    expect(noContractRequired.requiresAcceptanceCriteria).not.toBe(true);
    expect(() => registerObjectiveAcceptanceCriteria(noContractRequired, [criterion], 7))
      .toThrow('Terminal reconciliation freezes the registered acceptance contract');

    const missingHostCapability = {
      ...unregistered,
      terminalReconciliation: { messageId: 'reconcile-without-capability', timestamp: 8 },
    };
    expect(missingHostCapability.requiresAcceptanceCriteria).toBe(true);
    expect(() => registerObjectiveAcceptanceCriteria(missingHostCapability, [criterion], 9))
      .toThrow('Terminal reconciliation freezes the registered acceptance contract');
  });

  it('re-registers one fully observed amended contract during terminal reconciliation', () => {
    const amendment: Message = {
      id: 'target-production',
      role: 'user',
      content: 'La cible est désormais production.',
      timestamp: 3,
    };
    const amended = transitionObjectiveContract({
      existing: objective,
      messageId: amendment.id,
      text: amendment.content,
      nowMs: amendment.timestamp,
    });
    expect(amended.acceptanceNeedsReview).toBe(true);
    expect(amended.acceptanceRevision).toBe(amendment.id);

    const productionCriterion: ObjectiveAcceptanceCriterion = {
      ...criterion,
      description: 'The authorized timer is active on the production host',
      input: { host: 'production', timer: 'cleanup' },
    };
    const productionObservation: Message = {
      ...observation,
      id: 'production-observation',
      toolUseId: 'production-observation',
      timestamp: 4,
      toolInput: structuredClone(productionCriterion.input),
    };
    const closure: Message = {
      id: 'terminal-amended-registration',
      role: 'user',
      content: 'Reprends cette mission uniquement pour réconcilier son état terminal avec l’effet déjà accompli. Tu ne dois créer aucun nouvel effet externe. Réutilise les reçus persistés et garde toute observation en lecture seule. Termine réellement comme complete_verified.',
      timestamp: 5,
    };
    const terminal = transitionObjectiveContract({
      existing: amended,
      messageId: closure.id,
      text: closure.content,
      nowMs: closure.timestamp,
    });
    expect(terminal.terminalReconciliation).toEqual({
      messageId: closure.id,
      timestamp: closure.timestamp,
      initialAcceptanceRegistrationRequired: true,
    });
    const oldBinding = objectiveReviewBinding(objective);
    const registered = registerObjectiveAcceptanceCriteria(
      terminal,
      [productionCriterion],
      6,
      undefined,
      [root, amendment, productionObservation, closure],
    );
    expect(registered.acceptanceNeedsReview).toBe(false);
    expect(registered.acceptanceCriteria).toEqual([productionCriterion]);
    expect(registered.acceptanceRegisteredRevision).toBe(amendment.id);
    expect(registered.acceptanceHistory?.at(-1)?.criteria).toEqual([criterion]);
    expect(objectiveReviewBinding(registered)).not.toEqual(oldBinding);

    expect(() => registerObjectiveAcceptanceCriteria(
      terminal,
      [productionCriterion],
      6,
      undefined,
      [root, amendment, closure],
    )).toThrow('already satisfied by exact persisted read-only observations');
  });

  it('keeps business procedure binding immutable during terminal reconciliation', () => {
    const bound = bindBusinessProcedure(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }),
      'software-change',
    );
    const reconciled = {
      ...bound,
      terminalReconciliation: { messageId: 'receipt-only-close', timestamp: 2 },
    };
    expect(bindBusinessProcedure(reconciled, 'software-change')).toBe(reconciled);

    const unbound = {
      ...reconciled,
      procedure: undefined,
      requiresAcceptanceCriteria: undefined,
    };
    expect(() => bindBusinessProcedure(unbound, 'software-change'))
      .toThrow('Terminal reconciliation freezes the active business procedure');
    expect(() => bindBusinessProcedure(reconciled, 'software-deployment'))
      .toThrow('Terminal reconciliation freezes the active business procedure');
  });
  it('returns actionable procedure and reserved-id diagnostics before registration', () => {
    const base = transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 });
    expect(() => registerObjectiveAcceptanceCriteria(base, [{
      ...criterion, requirementId: 'requested-behavior',
    }], 2)).toThrow('requirementId "requested-behavior" requires a selected business procedure; select procedure or omit requirementId');
    expect(() => registerObjectiveAcceptanceCriteria(base, [{
      ...criterion, requirementId: 'arbitrary-pass',
    }], 2, 'software-change')).toThrow('Unknown requirementId "arbitrary-pass" for business procedure "software-change". Allowed requirementId values: requested-behavior, regression-checks, user-journey');

    for (const reservedId of base.completionCriteria) {
      expect(() => registerObjectiveAcceptanceCriteria(base, [{
        ...criterion, id: reservedId,
      }], 2)).toThrow(`Criterion id "${reservedId}" is reserved by the host completion contract; choose a different criterion id`);
    }
    expect(base.acceptanceCriteria).toBeUndefined();
  });
  it('makes each procedure\'s allowed requirementId values explicit in the contract prompt', () => {
    const expected = 'Allowed requirementId values for software-change: requested-behavior, regression-checks, user-journey';
    expect(businessProcedurePrompt()).toContain(expected);
    expect(businessProcedurePrompt({ id: 'software-change', version: 1 })).toContain(expected);
  });
  it('rejects unrepairable native and namespaced shell criteria atomically before freezing their identity', () => {
    const inadmissible: Array<{ toolName: string; input: ObjectiveAcceptanceCriterion['input'] }> = [
      { toolName: 'Bash', input: { command: `python3 -c "print({'exists': True})"` } },
      { toolName: 'bash', input: { '$.command': "python3 -c 'import json; print(json.dumps({\"exists\": True))'" } },
      { toolName: 'functions.bash', input: { cmd: 'node -e "console.log(JSON.stringify({ok:true}))"' } },
      { toolName: 'Bash', input: { script: 'printf \'{"ok":true}\\n\'' } },
      { toolName: 'mcp__ops__ssh_execute', input: { server: 'staging', cwd: '/srv/release',
        command: 'python3 -c "print(1)"' } },
      { toolName: 'mcp__ops__exec_command', input: { host: 'staging', command: 'printf PASS' } },
      { toolName: 'mcp__ops__shell', input: { host: 'staging',
        command: 'python3 /srv/validate_release.py --write' } },
      { toolName: 'mcp__ops__bash', input: { host: 'staging',
        command: 'curl -X POST https://example.com/health' } },
      { toolName: 'mcp__ops__ssh_execute', input: { server: 'staging', cwd: '/srv/release',
        command: 'rm -f /srv/release/result.json' } },
    ];
    for (const [index, candidate] of inadmissible.entries()) {
      const base = transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 });
      expect(() => registerObjectiveAcceptanceCriteria(base, [{
        id: `invalid-inline-${index}`, description: 'Inline output claims the report is valid.',
        ...candidate, checks: [{ path: '$.exists', equals: true }],
      }], 2)).toThrow('cannot serve as host-observed acceptance evidence');
      expect(base.acceptanceCriteria).toBeUndefined();
    }

    const base = transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 });
    const safe: ObjectiveAcceptanceCriterion = {
      id: 'safe-state', description: 'The state file is valid JSON.', toolName: 'Bash',
      input: { command: 'cat /tmp/state.json' }, checks: [{ path: '$.ok', equals: true }],
    };
    expect(() => registerObjectiveAcceptanceCriteria(base, [safe, {
      id: 'invalid-inline', description: 'Inline output claims the report is valid.',
      toolName: 'mcp__ops__exec_command', input: { host: 'staging', command: 'python3 -c "print(1)"' },
      checks: [{ path: '$text', equals: '1' }],
    }], 2)).toThrow('Nothing was registered');
    expect(base.acceptanceCriteria).toBeUndefined();

    // Reloaded legacy contracts remain immutable and idempotent, but the same
    // shared grammar keeps their inline output from certifying relevant checks.
    const legacyCriterion: ObjectiveAcceptanceCriterion = {
      id: 'legacy-inline', description: 'Legacy inline output claims success.', toolName: 'Bash',
      input: { command: 'python3 -c "print(1)"' }, checks: [{ path: '$text', equals: '1' }],
    };
    const legacy = { ...base, acceptanceCriteria: [legacyCriterion], acceptanceRegisteredAt: 2,
      acceptanceRegisteredAtById: { [legacyCriterion.id]: 2 } };
    expect(registerObjectiveAcceptanceCriteria(legacy, [structuredClone(legacyCriterion)], 99)).toEqual(legacy);
    const legacyResult: Message = { ...observation, id: 'legacy-inline-result', toolUseId: 'legacy-inline-result',
      toolName: 'Bash', toolInput: legacyCriterion.input, toolResult: '1', timestamp: 3 };
    const legacyReceipt: ObjectiveOutcomeDeclaration = {
      state: 'complete_verified', blocker: null, remainingWork: [], criteria: [
        { id: legacyCriterion.id, satisfied: true, evidence: [legacyResult.toolUseId!] },
        ...legacy.completionCriteria.map(id => ({ id, satisfied: true,
          evidence: [id === 'relevant-checks-passed' ? legacyResult.toolUseId! : 'assistant-final'] })),
      ],
    };
    expect(validateObjectiveAcceptanceCriteria(legacy, [root, legacyResult], legacyReceipt)).toEqual([]);
    expect(validateObjectiveOutcome(legacyReceipt, { objective: legacy, messages: [root, legacyResult] }).gaps)
      .toContain('criterion lacks observed evidence: relevant-checks-passed');
  });
  it('never promotes an unregistered opaque MCP shell result to relevant-checks evidence', () => {
    const unregistered = transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 });
    for (const [index, candidate] of [
      { toolName: 'mcp__ops__ssh_execute', toolInput: { server: 'staging', cwd: '/srv/release',
        command: 'python3 /srv/validate_release.py' } },
      { toolName: 'mcp__ops__exec_command', toolInput: { host: 'staging',
        command: 'curl --fail --silent https://example.com/health' } },
    ].entries()) {
      const result: Message = {
        ...observation, id: `unregistered-shell-${index}`, toolUseId: `unregistered-shell-${index}`,
        ...candidate, toolResult: '{"ok":true}', timestamp: 3 + index,
      };
      const claimed: ObjectiveOutcomeDeclaration = {
        state: 'complete_verified', blocker: null, remainingWork: [],
        criteria: unregistered.completionCriteria.map(id => ({ id, satisfied: true,
          evidence: [id === 'relevant-checks-passed' ? result.toolUseId! : 'assistant-final'] })),
      };
      expect(validateObjectiveOutcome(claimed, { objective: unregistered, messages: [root, result] }).gaps)
        .toContain('criterion lacks observed evidence: relevant-checks-passed');
    }
  });
  it('keeps a named validator repairable under the same immutable command after a syntax failure', () => {
    const base = transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 });
    const command = 'python3 /tmp/verify_report.py';
    const reportCriterion: ObjectiveAcceptanceCriterion = {
      id: 'report-valid', description: 'The generated report passes its validator.', toolName: 'Bash',
      input: { command }, checks: [{ path: '$.exists', equals: true }, { path: '$.hasPeriods', equals: true }],
    };
    const registered = registerObjectiveAcceptanceCriteria(base, [reportCriterion], 2);
    const failed: Message = {
      ...observation, id: 'validator-syntax-error', toolUseId: 'validator-syntax-error', timestamp: 3,
      toolName: 'Bash', toolInput: { command }, toolStatus: 'error', isError: true,
      toolResult: 'SyntaxError: closing parenthesis does not match opening parenthesis',
    };
    const repair: Message = {
      ...observation, id: 'repair-validator', toolUseId: 'repair-validator', timestamp: 4,
      toolName: 'Edit', toolInput: { file_path: '/tmp/verify_report.py' }, toolResult: 'Updated validator',
    };
    const verified: Message = {
      ...observation, id: 'validator-verified', toolUseId: 'validator-verified', timestamp: 5,
      toolName: 'Bash', toolInput: { command }, toolResult: '{"exists":true,"hasPeriods":true}',
    };
    const claimed: ObjectiveOutcomeDeclaration = {
      state: 'complete_verified', blocker: null, remainingWork: [],
      criteria: [
        { id: reportCriterion.id, satisfied: true, evidence: [verified.toolUseId!] },
        ...registered.completionCriteria.map(id => ({
          id, satisfied: true,
          evidence: [id === 'relevant-checks-passed' ? verified.toolUseId! : 'assistant-final'],
        })),
      ],
    };
    expect(registered.acceptanceCriteria).toEqual([reportCriterion]);
    expect(collectObjectiveAcceptanceObservations(registered, [root, failed, repair, verified]))
      .toMatchObject([{ criterionId: reportCriterion.id, passed: true,
        message: { toolUseId: verified.toolUseId } }]);
    expect(validateObjectiveOutcome(claimed, { objective: registered, messages: [root, failed, repair, verified] }))
      .toMatchObject({ state: 'complete_verified', valid: true, gaps: [] });
  });
  it('rejects a new JSON selector when the exact prior observation is demonstrably text-only', () => {
    const base = transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 });
    const pythonCriterion: ObjectiveAcceptanceCriterion = {
      id: 'report-shape', description: 'The report has every required section.',
      toolName: 'Bash', input: { command: 'python3 /tmp/verify_report.py' },
      checks: [{ path: '$.exists', equals: true }],
    };
    const pythonObservation: Message = { ...observation, toolName: 'Bash',
      toolInput: pythonCriterion.input, toolResult: "{'exists': True, 'hasPeriods': True}" };
    expect(() => registerObjectiveAcceptanceCriteria(
      base, [pythonCriterion], 2, undefined, [root, pythonObservation],
    )).toThrow('returned text without a supported structured projection for every requested selector');
    expect(base.acceptanceCriteria).toBeUndefined();

    const exactText = { ...pythonCriterion,
      checks: [{ path: '$text', equals: pythonObservation.toolResult! }] };
    expect(registerObjectiveAcceptanceCriteria(base, [exactText], 2, undefined,
      [root, pythonObservation]).acceptanceCriteria).toEqual([exactText]);
    // A named validator can be repaired in place without changing the frozen
    // command identity. Registration before its first observation stays valid.
    expect(registerObjectiveAcceptanceCriteria(base, [pythonCriterion], 2).acceptanceCriteria)
      .toEqual([pythonCriterion]);
  });
  it('does not bind opaque validator stdout unless the command has a bounded success marker', () => {
    const base = transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 });
    const opaque: ObjectiveAcceptanceCriterion = {
      id: 'opaque-output', description: 'The validator reports PASS.', toolName: 'Bash',
      input: { command: 'python3 /tmp/verify_report.py' }, checks: [],
    };
    for (const path of ['$.stdout', 'stdout', '$.stderr', 'stderr']) {
      expect(() => registerObjectiveAcceptanceCriteria(base, [{
        ...opaque, checks: [{ path, equals: 'PASS' }],
      }], 2)).toThrow('shell output is not a structured result field');
    }
    expect(registerObjectiveAcceptanceCriteria(base, [{
      ...opaque, id: 'opaque-exit', checks: [{ path: '$.transport.code', equals: 0 }],
    }], 2).acceptanceCriteria?.[0]?.id).toBe('opaque-exit');
    for (const checks of [
      [{ path: '$.transport.nonsense', equals: true }],
      [{ path: '$.transport.code', equals: 1 }],
      [{ path: '$.transport.success', equals: false }],
    ]) {
      expect(() => registerObjectiveAcceptanceCriteria(base, [{
        ...opaque, id: `invalid-transport-${String(checks[0]!.path).split('.').at(-1)}`,
        checks,
      }], 2)).toThrow('unsupported shell transport predicate');
    }
    expect(() => registerObjectiveAcceptanceCriteria(base, [{
      ...opaque, id: 'curl-without-fail-success', input: { command: 'curl --silent https://example.com/health' },
      checks: [{ path: '$.transport.success', equals: true }],
    }], 2)).toThrow('unsupported shell transport predicate');
    expect(registerObjectiveAcceptanceCriteria(base, [{
      ...opaque, id: 'curl-with-fail-success', input: { command: 'curl --fail --silent https://example.com/health' },
      checks: [{ path: '$.transport.success', equals: true }],
    }], 2).acceptanceCriteria?.[0]?.id).toBe('curl-with-fail-success');
    expect(() => registerObjectiveAcceptanceCriteria(base, [{
      ...opaque, id: 'bounded-output', input: { command: 'python3 /tmp/verify_report.py && printf PASS' },
      checks: [{ path: 'stdout', equals: 'PASS' }],
    }], 2)).toThrow('Use $text');
    expect(registerObjectiveAcceptanceCriteria(base, [{
      ...opaque, id: 'bounded-text', input: { command: 'python3 /tmp/verify_report.py && printf PASS' },
      checks: [{ path: '$text', equals: 'PASS' }],
    }], 2).acceptanceCriteria?.[0]?.id).toBe('bounded-text');
  });
  it('extends checks without replaying unchanged evidence and persists individual registration boundaries', () => {
    const added: ObjectiveAcceptanceCriterion = { ...criterion, id: 'timer-visible', toolName: 'mcp__ops__get_visibility',
      checks: [{ path: 'visible', equals: true }] };
    const extended = registerObjectiveAcceptanceCriteria(objective, [added], 10);
    expect(extended.acceptanceRegisteredAt).toBe(10);
    expect(extended.acceptanceRegisteredAtById).toEqual({ 'timer-active': 2, 'timer-visible': 10 });
    const loaded = JSON.parse(JSON.stringify(extended));
    const newObservation = { ...observation, id: 'm2', toolUseId: 't2', timestamp: 11, toolName: added.toolName,
      toolResult: '{"enabled":true,"nextRunScheduled":true,"visible":true}' };
    const extendedReceipt = { ...receipt, criteria: [...receipt.criteria,
      { id: added.id, satisfied: true, evidence: ['t2'] }] };
    expect(validateObjectiveAcceptanceCriteria(loaded, [root, observation, newObservation], extendedReceipt)).toEqual([]);
    expect(collectObjectiveAcceptanceObservations(loaded, [root, observation, newObservation])).toHaveLength(2);
    expect(objectiveReviewBinding(loaded)).not.toEqual(objectiveReviewBinding(objective));
    const repeated = registerObjectiveAcceptanceCriteria(loaded, [added, criterion], 20);
    expect(repeated).toBe(loaded);
    expect(validateObjectiveAcceptanceCriteria(repeated, [root, observation, newObservation], extendedReceipt)).toEqual([]);
  });

  it('reuses an exact objective-scoped observation when the criterion is registered later', () => {
    const added = { ...criterion, id: 'timer-visible', checks: [{ path: 'visible', equals: true }] };
    const extended = registerObjectiveAcceptanceCriteria(objective, [added], 10);
    const earlier = { ...observation, toolResult: '{"enabled":true,"nextRunScheduled":true,"visible":true}' };
    const claimed = { ...receipt, criteria: [...receipt.criteria,
      { id: added.id, satisfied: true, evidence: ['t1'] }] };
    expect(validateObjectiveAcceptanceCriteria(extended, [root, earlier], claimed)).toEqual([]);
    expect(collectObjectiveAcceptanceObservations(extended, [root, earlier]).map(item => item.criterionId))
      .toEqual(['timer-active', 'timer-visible']);
  });

  it('keeps a successful business observation across later transport failures, but not a newer negative result', () => {
    const negative = { ...observation, id: 'latest', toolUseId: 'latest', timestamp: 9,
      toolResult: '{"enabled":false,"nextRunScheduled":true}' };
    expect(validateObjectiveAcceptanceCriteria(objective, [root, observation, negative], receipt)).toEqual([
      'Business criterion lacks matching post-action evidence: timer-active',
    ]);
    for (const changes of [
      { isError: true, toolStatus: 'error' as const, toolResult: 'Unavailable' },
      { toolExecuted: false, toolResult: 'Not executed' },
    ]) {
      const latest = { ...observation, id: 'latest', toolUseId: 'latest', timestamp: 9, ...changes };
      expect(validateObjectiveAcceptanceCriteria(objective, [root, observation, latest], receipt)).toEqual([]);
      expect(collectObjectiveAcceptanceObservations(objective, [root, observation, latest]).map(item => item.message.id))
        .toEqual(['m1']);
    }
    const empty = { ...observation, id: 'empty', toolUseId: 'empty', timestamp: 9, toolResult: '' };
    expect(validateObjectiveAcceptanceCriteria(objective, [root, observation, empty], receipt)).toEqual([
      'Business criterion lacks matching post-action evidence: timer-active',
    ]);
    const otherTarget = { ...observation, id: 'other', toolUseId: 'other', timestamp: 9,
      toolInput: { host: 'other', timer: 'cleanup' }, toolResult: '{"enabled":false}' };
    expect(validateObjectiveAcceptanceCriteria(objective, [root, observation, otherTarget], receipt)).toEqual([]);
  });

  it('retains registration timestamps as provenance without turning them into duplicate-check boundaries', () => {
    const legacy = { ...objective, acceptanceRegisteredAtById: undefined };
    const added = { ...criterion, id: 'timer-visible', checks: [{ path: 'visible', equals: true }] };
    const extended = registerObjectiveAcceptanceCriteria(legacy, [added], 10);
    expect(extended.acceptanceRegisteredAtById).toEqual({ 'timer-active': 2, 'timer-visible': 10 });
    for (const at of [0, 11, Number.NaN, '2']) {
      const malformed = { ...extended, acceptanceRegisteredAtById: { 'timer-active': at } } as typeof extended;
      expect(validateObjectiveAcceptanceCriteria(malformed, [root, observation], receipt)).not.toContain(
        'Business criterion lacks matching post-action evidence: timer-active');
    }
    // Re-registering preserves old metadata, while exact objective-scoped proof
    // remains reusable.
    const lateLegacy = { ...legacy, acceptanceRegisteredAt: 8 };
    expect(registerObjectiveAcceptanceCriteria(lateLegacy, [criterion], 20)).toBe(lateLegacy);
    expect(validateObjectiveAcceptanceCriteria(lateLegacy, [root, observation], receipt)).toEqual([]);
  });

  it('invalidates evidence per explicit target instead of after every unrelated mutation', () => {
    const isolatedCriterion = { ...criterion, input: { workspaceId: 'workspace-a', timer: 'cleanup' } };
    const isolatedObjective = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }), [isolatedCriterion], 2,
    );
    const isolatedObservation = { ...observation, toolInput: isolatedCriterion.input };
    const unrelatedMutation: Message = { ...observation, id: 'other-mutation', toolUseId: 'other-mutation',
      timestamp: 5, toolName: 'mcp__ops__update_timer',
      toolInput: { workspaceId: 'workspace-b', timer: 'cleanup', enabled: false }, toolResult: '{"updated":true}' };
    expect(validateObjectiveAcceptanceCriteria(isolatedObjective, [root, isolatedObservation, unrelatedMutation], receipt)).toEqual([]);
    expect(validateObjectiveOutcome(receipt, { objective: isolatedObjective,
      messages: [root, isolatedObservation, unrelatedMutation] }).valid).toBe(true);

    const relevantMutation = { ...unrelatedMutation, id: 'same-mutation', toolUseId: 'same-mutation',
      toolInput: { workspaceId: 'workspace-a', timer: 'cleanup', enabled: false } };
    expect(validateObjectiveAcceptanceCriteria(isolatedObjective, [root, isolatedObservation, relevantMutation], receipt)).toEqual([
      'Business criterion lacks matching post-action evidence: timer-active',
    ]);
    expect(validateObjectiveOutcome(receipt, { objective: isolatedObjective,
      messages: [root, isolatedObservation, relevantMutation] }).valid).toBe(false);
    expect(validateObjectiveAcceptanceCriteria(isolatedObjective, [root, isolatedObservation, relevantMutation, {
      ...isolatedObservation, id: 'after-mutation', toolUseId: 'after-mutation', timestamp: 6,
    }], { ...receipt, criteria: receipt.criteria.map(item => item.id === criterion.id
      ? { ...item, evidence: ['after-mutation'] } : item) })).toEqual([]);

    const multiIdentityCriterion = { ...criterion,
      input: { workspaceId: 'workspace-a', sessionId: 'session-shared', timer: 'cleanup' } };
    const multiIdentityObjective = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }),
      [multiIdentityCriterion], 2,
    );
    const multiIdentityObservation = { ...observation, toolInput: multiIdentityCriterion.input };
    const inconsistentButSameSession = { ...relevantMutation, id: 'same-session-mutation',
      toolUseId: 'same-session-mutation',
      toolInput: { workspaceId: 'workspace-b', sessionId: 'session-shared', timer: 'cleanup', enabled: false } };
    expect(validateObjectiveAcceptanceCriteria(multiIdentityObjective,
      [root, multiIdentityObservation, inconsistentButSameSession], receipt)).toEqual([
      'Business criterion lacks matching post-action evidence: timer-active',
    ]);

    const pathObjective = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: 'path-root', text: 'Vérifie le fichier.', nowMs: 1 }),
      [{ ...criterion, input: { file_path: '/tmp/state' } }], 2,
    );
    const pathRoot = { ...root, id: 'path-root' };
    const pathObservation = { ...observation, toolInput: { file_path: '/tmp/state' } };
    const aliasedPathMutation = { ...relevantMutation, toolName: 'Edit',
      toolInput: { file_path: '/tmp/dir/../state', new_string: 'changed' } };
    expect(validateObjectiveAcceptanceCriteria(pathObjective, [pathRoot, pathObservation, aliasedPathMutation], receipt))
      .toHaveLength(1);
  });

  it('still invalidates old evidence after a mutation when extending the contract', () => {
    const added = { ...criterion, id: 'timer-visible', checks: [{ path: 'visible', equals: true }] };
    const extended = registerObjectiveAcceptanceCriteria(objective, [added], 10);
    const mutation: Message = { ...observation, id: 'mutation', toolUseId: 'mutation', timestamp: 8,
      toolName: 'Edit', toolInput: { file_path: '/tmp/timer-config' } };
    const newObservation = { ...observation, id: 'm2', toolUseId: 't2', timestamp: 11,
      toolResult: '{"enabled":false,"nextRunScheduled":true,"visible":true}' };
    const claimed = { ...receipt, criteria: [...receipt.criteria,
      { id: added.id, satisfied: true, evidence: ['t2'] }] };
    expect(validateObjectiveAcceptanceCriteria(extended, [root, observation, mutation, newObservation], claimed)).toEqual([
      'Business criterion lacks matching post-action evidence: timer-active',
    ]);
  });

  it('rejects a second live-release SHA for the same invocation atomically, including one incoming batch', () => {
    const base = transitionObjectiveContract({ messageId: 'live-root', text: 'Vérifie la release active.', nowMs: 1 });
    const first: ObjectiveAcceptanceCriterion = { id: 'first-release', description: 'The requested release is live.', toolName: 'Bash',
      input: { command: 'python3 /srv/verify.py --scope live' }, checks: [{ path: '$.sha', equals: 'f0b7a7283d70e058dee501cdf2bbcccdc4213de0' }] };
    const next = { ...first, id: 'next-release', checks: [{ path: '$.sha', equals: '140f4aad93c40fb33b38102446c9bc8466f87228' }] };
    const registered = registerObjectiveAcceptanceCriteria(base, [first], 2);
    const before = structuredClone(registered); const binding = objectiveReviewBinding(registered);
    expect(() => registerObjectiveAcceptanceCriteria(registered, [next], 3)).toThrow('Incompatible registered equality');
    expect(() => registerObjectiveAcceptanceCriteria(base, [first, next], 3)).toThrow('Incompatible registered equality');
    const independent = { ...first, id: 'other-server', input: { command: 'python3 /srv/verify_other.py --scope live' } };
    expect(() => registerObjectiveAcceptanceCriteria(registered, [independent, next], 3)).toThrow('Incompatible registered equality');
    expect(registered).toEqual(before);
    expect(objectiveReviewBinding(registered)).toEqual(binding);
    expect(base.acceptanceCriteria).toBeUndefined();
    // An explicit new objective has its own target/version contract; it does
    // not remove or supersede a criterion in the old objective.
    const newObjective = transitionObjectiveContract({ existing: registered, messageId: 'new-root', text: 'Nouvel objectif : vérifie la nouvelle release.' });
    expect(registerObjectiveAcceptanceCriteria(newObjective, [next], 4).acceptanceCriteria).toEqual([next]);
    expect(registered).toEqual(before);
  });
  it('compares native aliases, reordered inputs and equivalent selectors, with strict scalar types', () => {
    const first = { ...criterion, toolName: 'functions.bash', input: { command: 'cat /srv/check.json', 'target.ids.0': 17 }, checks: [{ path: '$.items[0].ready', equals: true }] };
    const registered = registerObjectiveAcceptanceCriteria(transitionObjectiveContract({ messageId: 'u1', text: root.content }), [first], 2);
    for (const equals of [false, 'true', 1, null]) {
      expect(() => registerObjectiveAcceptanceCriteria(registered, [{ ...first, id: 'conflicting', toolName: 'Bash',
        input: { '$.target.ids[0]': 17, '$.command': 'cat /srv/check.json' }, checks: [{ path: 'items.0.ready', equals }] }], 3)).toThrow('Incompatible registered equality');
    }
    const distinctConstraints: Array<Partial<ObjectiveAcceptanceCriterion>> = [
      { toolName: 'mcp__other__bash' }, { input: { command: 'cat /srv/other.json', 'target.ids.0': 17 } },
      { input: { command: 'cat /srv/check.json', 'target.ids.0': '17' } },
      { input: { command: 'cat /srv/check.json' } }, // exact input identity, not inferred overlap
      { checks: [{ path: '$.items[1].ready', equals: false }] },
    ];
    for (const distinct of distinctConstraints) expect(registerObjectiveAcceptanceCriteria(registered, [{ ...first, id: 'independent', checks: [{ path: 'items.0.ready', equals: false }], ...distinct }], 3).acceptanceCriteria).toHaveLength(2);
    expect(registerObjectiveAcceptanceCriteria(registered, [{ ...first, id: 'same-expected-state' }], 3).acceptanceCriteria).toHaveLength(2);
  });
  it('uses the existing whole-text equality semantics, without trimming significant content', () => {
    const first = { ...criterion, checks: [{ path: '$text', equals: 'READY\r\n' }] };
    const registered = registerObjectiveAcceptanceCriteria(transitionObjectiveContract({ messageId: 'u1', text: root.content }), [first], 2);
    for (const equals of ['READY', 'READY\n', 'READY\r\n']) {
      expect(registerObjectiveAcceptanceCriteria(registered, [{ ...first, id: 'same-text', checks: [{ path: '$text', equals }] }], 3).acceptanceCriteria).toHaveLength(2);
    }
    for (const equals of [' READY', 'READY ', 'READY\n\n', 'NOT READY']) {
      expect(() => registerObjectiveAcceptanceCriteria(registered, [{ ...first, id: 'conflicting-text', checks: [{ path: '$text', equals }] }], 3)).toThrow('Incompatible registered equality');
    }
  });
  it('preserves an already persisted contradiction on identical re-registration without extending it', () => {
    const legacy = { ...objective, acceptanceCriteria: [criterion, { ...criterion, id: 'old-conflict', checks: [{ path: 'enabled', equals: false }] }] };
    const before = structuredClone(legacy); const binding = objectiveReviewBinding(legacy);
    expect(registerObjectiveAcceptanceCriteria(legacy, structuredClone(legacy.acceptanceCriteria), 99)).toEqual(legacy);
    expect(registerObjectiveAcceptanceCriteria(legacy, [{ ...criterion, id: 'different-target', input: { host: 'other', timer: 'cleanup' } }], 100).acceptanceCriteria).toHaveLength(3);
    expect(() => registerObjectiveAcceptanceCriteria(legacy, [{ ...criterion, id: 'third-conflict' }], 100)).toThrow('Incompatible registered equality');
    expect(legacy).toEqual(before);
    expect(objectiveReviewBinding(legacy)).toEqual(binding);
  });
  it('retains the original request across continuation, reload and missing transcript context', () => {
    const continued = transitionObjectiveContract({ existing: JSON.parse(JSON.stringify(objective)), messageId: 'u2', text: 'Poursuit' });
    expect(findObjectiveText([], continued)).toBe(root.content);
    expect(continued.acceptanceCriteria).toEqual([criterion]);
    expect(buildObjectiveContractPrompt(continued)).toContain(root.content);
    const next = transitionObjectiveContract({ existing: continued, messageId: 'u3', text: 'Nouvel objectif : analyse le dossier différent.' });
    expect(next.acceptanceCriteria).toBeUndefined();
  });
  it('requires actual observations for inspection requests without requiring mutations', () => {
    const inspect = transitionObjectiveContract({ messageId: 'u1', text: 'Inspecte le serveur en lecture seule.' });
    expect(inspect.requiresObservationEvidence).toBe(true);
    expect(inspect.requiresExecutionEvidence).toBeUndefined();
    expect(buildObjectiveContractPrompt(inspect)).toContain('machine-readable');
  });
});
