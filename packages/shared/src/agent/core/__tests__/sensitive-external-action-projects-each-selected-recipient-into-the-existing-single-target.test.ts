import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { cleanupModeState, initializeModeState } from "../../mode-manager.ts";
import { clearContextualGmailPreflightAttestation, recordContextualGmailToolResult, runPreToolUseChecks } from "../pre-tool-use.ts";
import { contextualGmailReplyPreflightAttestationFromObjective, contextualGmailTargetScopedAuthorizationSegments } from "../sensitive-external-action.ts";
import { gmailRecipientBinding, whitelistedPermissionManager } from "./testing/sensitive-external-action-fixture.ts";

const usedSessionIds: string[] = [];
const temporaryPaths: string[] = [];

afterEach(() => {
  setSystemTime();
  for (const sessionId of usedSessionIds.splice(0)) {
    clearContextualGmailPreflightAttestation(sessionId);
    cleanupModeState(sessionId);
  }
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('host-authenticated multi-target Gmail selection', () => {
  const first = [
    '[host-authenticated-user-authorization:v1]',
    'Authenticated question id: publisher_targets',
    'The user affirmatively selected: Les deux contacts identifiés Répondre à alice@example.com et à bob@example.com.',
    'Displayed scope affirmed by that selection: Quel périmètre de destinataires dois-je utiliser pour ces réponses.',
  ].join('\n');

  const exactThreads = [
    '[host-authenticated-user-authorization:v1]',
    'Authenticated question id: publisher_threads',
    'The user affirmatively selected: Oui, ces deux fils exacts Alice : message 1a0e88c1fc492d90. Bob : message 1a0e72da54933139.',
    'Displayed scope affirmed by that selection: Confirmez-vous que je dois répondre dans ces deux fils Gmail exacts.',
  ].join('\n');

  const tool = 'mcp__google-contacts__gmail_reply_preflight';

  const input = {
    messageId: '1a0e72da54933139',
    expectedRecipientEmail: 'bob@example.com',
    body: 'Bonjour Bob.',
    isHtml: false,
  };

  it('projects each selected recipient into the existing single-target signed-preflight contract', () => {
    const root = 'Réponds aux deux éditeurs dans leurs fils Gmail.';
    const selected = contextualGmailTargetScopedAuthorizationSegments(
      [root, first], [first], tool, input,
    );
    expect(contextualGmailReplyPreflightAttestationFromObjective(tool, input, selected))
      .toMatchObject({ messageId: input.messageId, expectedRecipientEmail: input.expectedRecipientEmail });
    const selectedExact = contextualGmailTargetScopedAuthorizationSegments(
      [root, first, exactThreads], [first, exactThreads], tool, input,
    );
    expect(contextualGmailReplyPreflightAttestationFromObjective(tool, input, selectedExact))
      .toMatchObject({ messageId: input.messageId, expectedRecipientEmail: input.expectedRecipientEmail });
  });

  it('accepts one selected thread only after its observed read and signed preflight', () => {
    const sessionId = `multi-target-${randomUUID()}`;
    usedSessionIds.push(sessionId);
    initializeModeState(sessionId, 'allow-all');
    const segments = ['Réponds aux deux éditeurs dans leurs fils Gmail.', first];
    const run = (toolName: string, toolInput: Record<string, unknown>, toolUseId: string) =>
      runPreToolUseChecks({
        toolName,
        input: toolInput,
        sessionId,
        toolUseId,
        permissionMode: 'allow-all',
        workspaceRootPath: '/tmp/robb-sensitive-action-test',
        workspaceId: 'sensitive-action-test',
        activeSourceSlugs: ['google-contacts'],
        allSourceSlugs: ['google-contacts'],
        hasSourceActivation: false,
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: segments,
        authenticatedUserAuthorizationSegments: [first],
        permissionManager: whitelistedPermissionManager,
        currentUserRequest: first,
      });
    const binding = gmailRecipientBinding('a');
    recordContextualGmailToolResult({
      sessionId,
      toolUseId: 'multi-read',
      toolName: 'mcp__google-contacts__gmail_get_message',
      toolInput: { messageId: input.messageId },
      result: JSON.stringify({ id: input.messageId, threadId: input.messageId }),
      executed: true,
      isError: false,
      objectiveAuthorizationSegments: segments,
    });
    expect(run(tool, { ...input, expectedSenderEmail: 'sender@example.com' }, 'multi-preflight-extra-sender'))
      .toMatchObject({ type: 'block', reason: expect.stringContaining('Omit expectedSenderEmail') });
    expect(run(tool, input, 'multi-preflight').type).toBe('allow');
    recordContextualGmailToolResult({
      sessionId,
      toolUseId: 'multi-preflight',
      toolName: tool,
      toolInput: input,
      result: JSON.stringify({
        ok: true,
        willSend: false,
        messageId: input.messageId,
        bodySha256: createHash('sha256').update(input.body).digest('hex'),
        isHtml: false,
        replyAll: false,
        expectedRecipientEmail: input.expectedRecipientEmail,
        primarySenderEmail: 'sender@example.com',
        subject: 'Selected thread',
        resolvedRecipients: { to: [input.expectedRecipientEmail], cc: [] },
        recipientBinding: binding,
        bindingExpiresInSeconds: 600,
      }),
      executed: true,
      isError: false,
      objectiveAuthorizationSegments: segments,
    });
    expect(run('mcp__google-contacts__gmail_reply_bound', {
      ...input, recipientBinding: binding,
    }, 'multi-bound').type).toBe('allow');
    expect(run('mcp__google-contacts__gmail_reply_bound', {
      ...input, recipientBinding: binding,
    }, 'multi-bound-again')).toMatchObject({ type: 'block' });
  });

  it('does not promote public text, unselected ids or unselected recipients', () => {
    const root = 'Réponds aux deux éditeurs dans leurs fils Gmail.';
    expect(contextualGmailTargetScopedAuthorizationSegments(
      [root, first], [], tool, input,
    )).toEqual([root, first]);
    expect(contextualGmailTargetScopedAuthorizationSegments(
      [root, first, exactThreads], [first, exactThreads], tool,
      { ...input, messageId: '1a0e000000000000' },
    )).toEqual([root, first, exactThreads]);
    expect(contextualGmailTargetScopedAuthorizationSegments(
      [root, first], [first], tool,
      { ...input, expectedRecipientEmail: 'eve@example.com' },
    )).toEqual([root, first]);
    expect(contextualGmailTargetScopedAuthorizationSegments(
      [root, first, exactThreads], [first, exactThreads], tool,
      { ...input, expectedRecipientEmail: 'alice@example.com' },
    )).toEqual([root, first, exactThreads]);

  });

  it('authorizes a natural-language reply when gmail_get_message extracted media assets and the agent supplied expectedSenderEmail', () => {
    const sessionId = `cindy-sellsy-${randomUUID()}`;
    usedSessionIds.push(sessionId);
    initializeModeState(sessionId, 'allow-all');
    const segments = [
      'Répond au mail de cindy sur comment créer une facture avce TVA internationnal dans notre sellsy et mention à apposer dessus',
    ];
    const run = (toolName: string, toolInput: Record<string, unknown>, toolUseId: string) =>
      runPreToolUseChecks({
        toolName,
        input: toolInput,
        sessionId,
        toolUseId,
        permissionMode: 'allow-all',
        workspaceRootPath: '/tmp/robb-sensitive-action-test',
        workspaceId: 'sensitive-action-test',
        activeSourceSlugs: ['google-contacts', 'orion-mcp'],
        allSourceSlugs: ['google-contacts', 'orion-mcp'],
        hasSourceActivation: false,
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: segments,
        permissionManager: whitelistedPermissionManager,
        currentUserRequest: segments[0],
      });

    expect(run('mcp__orion-mcp__orion_tool_schema', {
      name: 'gmail_reply_bound',
      providerId: 'google-workspace',
    }, 'schema-1').type).toBe('allow');

    const messageId = '1a16478d254f26a8';
    const mediaWrappedReadResult = [
      '[Structured media assets extracted and saved]',
      '',
      `Result metadata JSON: ${JSON.stringify({
        id: messageId,
        threadId: messageId,
        subject: 'IMPORTANT',
        from: 'Cindy Steenkeste <cindy@robinswood.io>',
        to: 'Thibault Fritsch <thibault@youcom.io>',
      })}`,
      '',
      'Original JSON SHA256: c81b2d256f23756dfd80c339725d6a63c798307d71982e5fd3420b0a94611f1a',
    ].join('\n');

    recordContextualGmailToolResult({
      sessionId,
      toolUseId: 'cindy-read',
      toolName: 'mcp__google-contacts__gmail_get_message',
      toolInput: { messageId },
      result: mediaWrappedReadResult,
      executed: true,
      isError: false,
      objectiveAuthorizationSegments: segments,
    });

    const replyPayload = {
      messageId,
      expectedRecipientEmail: 'cindy@robinswood.io',
      expectedSenderEmail: 'thibault@robinswood.io',
      body: '<p>Hello Cindy,</p><p>TVA à 0 et mention article 259, 1° du CGI.</p>',
      isHtml: true,
    };
    const binding = gmailRecipientBinding('c');

    expect(run('mcp__google-contacts__gmail_reply_preflight', replyPayload, 'cindy-preflight').type).toBe('allow');
    recordContextualGmailToolResult({
      sessionId,
      toolUseId: 'cindy-preflight',
      toolName: 'mcp__google-contacts__gmail_reply_preflight',
      toolInput: replyPayload,
      result: JSON.stringify({
        ok: true,
        willSend: false,
        messageId,
        threadId: messageId,
        subject: 'Re: IMPORTANT',
        resolvedRecipients: { to: ['cindy@robinswood.io'], cc: [] },
        selfSentAnchor: false,
        replyAll: false,
        bodySha256: createHash('sha256').update(replyPayload.body, 'utf8').digest('hex'),
        isHtml: true,
        expectedRecipientEmail: 'cindy@robinswood.io',
        expectedSenderEmail: 'thibault@robinswood.io',
        primarySenderEmail: 'thibault@robinswood.io',
        recipientBinding: binding,
        bindingExpiresInSeconds: 600,
      }),
      executed: true,
      isError: false,
      objectiveAuthorizationSegments: segments,
    });

    expect(run('mcp__google-contacts__gmail_reply_bound', {
      ...replyPayload,
      recipientBinding: binding,
    }, 'cindy-bound').type).toBe('allow');
  });
});
