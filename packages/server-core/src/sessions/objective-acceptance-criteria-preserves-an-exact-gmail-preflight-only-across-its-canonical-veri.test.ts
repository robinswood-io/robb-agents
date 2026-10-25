import { describe, expect, it } from "bun:test";
import type { Message, ObjectiveOutcomeDeclaration, ObjectiveAcceptanceCriterion } from "@craft-agent/core/types";
import { transitionObjectiveContract } from "./objective-contract.ts";
import { registerObjectiveAcceptanceCriteria, validateObjectiveAcceptanceCriteria } from "./objective-acceptance-criteria.ts";
import { validateObjectiveOutcome } from "./objective-outcome.ts";
import { objective, observation, receipt, root } from "./testing/objective-acceptance-criteria-fixture.ts";

describe('business criteria and durable goal — E01 E03 E04 E11 E12', () => {
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
});
