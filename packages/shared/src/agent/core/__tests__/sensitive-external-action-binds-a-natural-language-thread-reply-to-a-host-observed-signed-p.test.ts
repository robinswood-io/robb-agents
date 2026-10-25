import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { cleanupModeState, initializeModeState, type PermissionMode } from "../../mode-manager.ts";
import { clearContextualGmailPreflightAttestation, recordContextualGmailToolResult, runPreToolUseChecks } from "../pre-tool-use.ts";
import { contextualGmailReplyPreflightAttestationFromObjective, hasContextualGmailReplyMention, isContextualGmailReplyRequestedByObjective } from "../sensitive-external-action.ts";
import { gmailRecipientBinding, whitelistedPermissionManager } from "./testing/sensitive-external-action-fixture.ts";

const usedSessionIds: string[] = [];
const temporaryPaths: string[] = [];
function checkBash(
  mode: PermissionMode,
  command: string,
  currentUserRequest?: string,
  externalActionPolicy?: 'confirm' | 'allow-in-execute',
  objectiveMutationAuthorized?: boolean,
  objectiveAuthorizationSegments?: readonly string[],
) {
  const sessionId = `sensitive-action-${randomUUID()}`;
  usedSessionIds.push(sessionId);
  initializeModeState(sessionId, mode);
  return runPreToolUseChecks({
    toolName: 'Bash',
    input: { command },
    sessionId,
    permissionMode: mode,
    workspaceRootPath: '/tmp/robb-sensitive-action-test',
    workspaceId: 'sensitive-action-test',
    activeSourceSlugs: [],
    allSourceSlugs: [],
    hasSourceActivation: false,
    externalActionPolicy,
    objectiveMutationAuthorized,
    objectiveAuthorizationSegments,
    permissionManager: whitelistedPermissionManager,
    currentUserRequest,
  });
}
function checkMcp(
  mode: PermissionMode,
  toolName: string,
  input: Record<string, unknown>,
  currentUserRequest?: string,
  options?: {
    externalActionPolicy?: 'confirm' | 'allow-in-execute';
    objectiveMutationAuthorized?: boolean;
    objectiveSensitiveActionAuthorized?: boolean;
    objectiveAuthorizationSegments?: readonly string[];
    authenticatedUserAuthorizationSegments?: readonly string[];
    dataFolderPath?: string;
    declaredToolCapabilities?: {
      readOnly?: boolean;
      idempotent?: boolean;
      destructive?: boolean;
      openWorld?: boolean;
      trusted?: boolean;
    };
    sessionId?: string;
  },
) {
  const markerSessionId = toolName === 'mcp__rbw-agents-oss__oss_write_file'
    ? /^\[robb-resume:([a-z0-9]+(?:-[a-z0-9]+)*):/mu.exec(
      options?.objectiveAuthorizationSegments?.find(segment => /^\[robb-resume:/mu.test(segment))
        ?? currentUserRequest ?? '',
    )?.[1]
    : undefined;
  const sessionId = options?.sessionId ?? markerSessionId ?? `sensitive-action-${randomUUID()}`;
  usedSessionIds.push(sessionId);
  initializeModeState(sessionId, mode);
  const sourceSlug = toolName.split('__')[1] ?? '';
  return runPreToolUseChecks({
    toolName,
    input,
    sessionId,
    toolUseId: `call-${randomUUID()}`,
    permissionMode: mode,
    workspaceRootPath: '/tmp/robb-sensitive-action-test',
    workspaceId: 'sensitive-action-test',
    activeSourceSlugs: [sourceSlug],
    allSourceSlugs: [sourceSlug],
    hasSourceActivation: false,
    externalActionPolicy: options?.externalActionPolicy,
    objectiveMutationAuthorized: options?.objectiveMutationAuthorized,
    objectiveSensitiveActionAuthorized: options?.objectiveSensitiveActionAuthorized,
    objectiveAuthorizationSegments: options?.objectiveAuthorizationSegments,
    authenticatedUserAuthorizationSegments: options?.authenticatedUserAuthorizationSegments,
    dataFolderPath: options?.dataFolderPath,
    declaredToolCapabilities: options?.declaredToolCapabilities,
    permissionManager: whitelistedPermissionManager,
    currentUserRequest,
  });
}

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

describe('sensitive external action gate across permission modes', () => {
  const silaeConfirmationObjective = [
    'Reprends l’objectif explicite d’écrire à Benoît. Vérifie d’abord Sent/Brouillons pour éviter un doublon, exécute le préflight exact vers benoit@example.test, sans fallback navigateur, puis arrête-toi immédiatement avant l’envoi pour la confirmation d’action externe. Après confirmation, envoie une seule fois et vérifie le messageId.',
  ];

  it('binds a natural-language thread reply to a host-observed signed preflight without asking for an API id', () => {
    const sessionId = `sensitive-action-${randomUUID()}`;
    usedSessionIds.push(sessionId);
    initializeModeState(sessionId, 'allow-all');
    const objectiveAuthorizationSegments = [
      'Answer this email in the existing thread. From: sender@example.test, CC empty, subject «Sujet».',
      'Poursuis.',
    ];
    const run = (
      toolName: string,
      input: Record<string, unknown>,
      segments = objectiveAuthorizationSegments,
      toolUseId = `call-${randomUUID()}`,
    ) => (
      runPreToolUseChecks({
        toolName,
        input,
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
        permissionManager: whitelistedPermissionManager,
        currentUserRequest: segments.at(-1),
      })
    );
    const messageId = '1a0aaa36e2769235';
    const replyBody = 'Merci Alice.\n';
    const closedReply = {
      messageId,
      expectedRecipientEmail: 'alice@example.com',
      expectedSenderEmail: 'sender@example.test',
      recipientBinding: gmailRecipientBinding('b'),
      body: replyBody,
      isHtml: false,
    };
    const preflightInput = {
      messageId,
      expectedRecipientEmail: 'alice@example.com',
      expectedSenderEmail: 'sender@example.test',
      body: replyBody,
      isHtml: false,
    };

    const beforePreflight = run('mcp__google-contacts__gmail_reply_bound', closedReply);
    expect(beforePreflight).toMatchObject({ type: 'block' });
    if (beforePreflight.type === 'block') {
      expect(beforePreflight.reason).toContain('already returned by the read step');
      expect(beforePreflight.reason).toContain('Do not ask the user for an internal Gmail id');
    }
    // A signed preflight result alone cannot select an anchor for a deictic
    // instruction. The host must first observe that exact message separately.
    expect(run(
      'mcp__google-contacts__gmail_reply_preflight', preflightInput,
      objectiveAuthorizationSegments, 'preflight-without-read',
    ).type).toBe('allow');
    recordContextualGmailToolResult({
      sessionId,
      toolUseId: 'preflight-without-read',
      toolName: 'mcp__google-contacts__gmail_reply_preflight',
      toolInput: preflightInput,
      result: JSON.stringify({
        ok: true,
        willSend: false,
        messageId,
        bodySha256: createHash('sha256').update(replyBody).digest('hex'),
        isHtml: false,
        replyAll: false,
        expectedRecipientEmail: 'alice@example.com',
        expectedSenderEmail: 'sender@example.test',
        primarySenderEmail: 'sender@example.test',
        subject: 'Sujet',
        resolvedRecipients: { to: ['alice@example.com'], cc: [] },
        recipientBinding: closedReply.recipientBinding,
        bindingExpiresInSeconds: 600,
      }),
      isError: false,
      executed: true,
      objectiveAuthorizationSegments,
    });
    const deicticWithoutRead = run('mcp__google-contacts__gmail_reply_bound', closedReply);
    expect(deicticWithoutRead).toMatchObject({ type: 'block' });
    if (deicticWithoutRead.type === 'block') {
      expect(deicticWithoutRead.reason).toContain('already returned by the read step');
    }
    recordContextualGmailToolResult({
      sessionId,
      toolUseId: 'read-wrong',
      toolName: 'mcp__google-contacts__gmail_get_message',
      toolInput: { messageId: '1a0aaa36e2769001' },
      result: JSON.stringify({ id: '1a0aaa36e2769001', threadId: '1a0aaa36e2769000' }),
      isError: false,
      executed: true,
      objectiveAuthorizationSegments,
    });
    recordContextualGmailToolResult({
      sessionId,
      toolUseId: 'read-1',
      toolName: 'mcp__google-contacts__gmail_get_message',
      toolInput: { messageId },
      result: JSON.stringify({ id: messageId, threadId: '1a0aaa36e2769000', subject: 'Sujet' }),
      isError: false,
      executed: true,
      objectiveAuthorizationSegments,
    });
    expect(run(
      'mcp__google-contacts__gmail_reply_preflight', preflightInput,
      objectiveAuthorizationSegments, 'preflight-failed',
    ).type).toBe('allow');
    recordContextualGmailToolResult({
      sessionId,
      toolUseId: 'preflight-failed',
      toolName: 'mcp__google-contacts__gmail_reply_preflight',
      toolInput: preflightInput,
      result: JSON.stringify({
        ok: true,
        willSend: false,
        messageId,
        bodySha256: createHash('sha256').update(replyBody).digest('hex'),
        isHtml: false,
        replyAll: false,
        expectedRecipientEmail: 'alice@example.com',
        expectedSenderEmail: 'sender@example.test',
        primarySenderEmail: 'sender@example.test',
        subject: 'Autre sujet',
        resolvedRecipients: { to: ['alice@example.com'], cc: ['bob@example.com'] },
        recipientBinding: closedReply.recipientBinding,
        bindingExpiresInSeconds: 600,
      }),
      isError: false,
      executed: true,
      objectiveAuthorizationSegments,
    });
    expect(run('mcp__google-contacts__gmail_reply_bound', closedReply)).toMatchObject({ type: 'block' });

    expect(run(
      'mcp__google-contacts__gmail_reply_preflight', preflightInput,
      objectiveAuthorizationSegments, 'preflight-1',
    ).type).toBe('allow');
    recordContextualGmailToolResult({
      sessionId,
      toolUseId: 'preflight-1',
      toolName: 'mcp__google-contacts__gmail_reply_preflight',
      toolInput: preflightInput,
      result: JSON.stringify({
        ok: true,
        willSend: false,
        messageId,
        bodySha256: createHash('sha256').update(replyBody).digest('hex'),
        isHtml: false,
        replyAll: false,
        expectedRecipientEmail: 'alice@example.com',
        expectedSenderEmail: 'sender@example.test',
        primarySenderEmail: 'sender@example.test',
        subject: 'Sujet',
        resolvedRecipients: { to: ['alice@example.com'], cc: [] },
        recipientBinding: closedReply.recipientBinding,
        bindingExpiresInSeconds: 600,
      }),
      isError: false,
      executed: true,
      objectiveAuthorizationSegments,
    });
    expect(run('mcp__google-contacts__gmail_reply_bound', closedReply).type).toBe('allow');
    // Host attestation is single-use even though the connector also has its own exact-once ledger.
    expect(run('mcp__google-contacts__gmail_reply_bound', closedReply)).toMatchObject({ type: 'block' });

    // A later retarget cannot reuse an attestation issued for the earlier human objective.
    expect(run(
      'mcp__google-contacts__gmail_reply_bound',
      closedReply,
      ['Answer Bob in the existing thread.'],
    )).toMatchObject({ type: 'block' });
  });

  it('recognizes ordinary bilingual contextual reply wording and keeps it on the canonical path', () => {
    const positiveObjectives = [
      'Answer this email, message 1a0aaa36e2769235.',
      'Write back to them in this thread, message 1a0aaa36e2769235.',
      'Fais-lui un retour dans ce fil, message 1a0aaa36e2769235.',
      'Réponds à ce courriel, message 1a0aaa36e2769235.',
      'Reply all, leaving the recipients unchanged, message 1a0aaa36e2769235.',
      'Reply all without including any new recipient, message 1a0aaa36e2769235.',
      'Reply all, omitting no recipients, message 1a0aaa36e2769235.',
      'Réponds à tous sans inclure de nouveau destinataire, message 1a0aaa36e2769235.',
      'Reply all, leaving the subject unchanged, message 1a0aaa36e2769235.',
      'Reply all, leaving the wording unchanged, message 1a0aaa36e2769235.',
      'Réponds à tous, sans inclure de pièce jointe, message 1a0aaa36e2769235.',
      'Reply all, excluding attachments, message 1a0aaa36e2769235.',
      'Réponds au message 1a0aaa36e2769235 qui dit « Bonjour ».',
      'Réponds au mail 1a0aaa36e2769235 qui indique que le dossier est prêt.',
      'Reply to message 1a0aaa36e2769235 that says “Hello”.',
      'Respond in the thread 1a0aaa36e2769235 whose email says the project is ready.',
      'Reply to them in this thread, message 1a0aaa36e2769235. If useful, keep it concise.',
      'Réponds-leur dans ce fil, message 1a0aaa36e2769235. Si utile, reste concis.',
    ];
    for (const objective of positiveObjectives) {
      expect({ objective, mentioned: hasContextualGmailReplyMention([objective]) }).toEqual({
        objective,
        mentioned: true,
      });
      expect({ objective, requested: isContextualGmailReplyRequestedByObjective([objective]) }).toEqual({
        objective,
        requested: true,
      });
    }
  });

  it('selects reply-all only for a human audience, not for every content item', () => {
    const messageId = '1a0aaa36e2769235';
    const allInput = { messageId, body: 'Merci.' };
    const oneInput = { ...allInput, expectedRecipientEmail: 'alice@example.com' };
    for (const objective of [
      `Réponds à chacun dans ce fil, message ${messageId}.`,
      `Réponds à tout le monde dans ce fil, message ${messageId}.`,
      `Réponds à l’ensemble des destinataires, message ${messageId}.`,
      `Réponds à toute la liste, message ${messageId}.`,
      `Answer everyone in this thread, message ${messageId}.`,
      `Respond to each recipient in this thread, message ${messageId}.`,
      `Reply to the whole list in this thread, message ${messageId}.`,
      `Reply to every recipient in this thread, message ${messageId}.`,
    ]) {
      expect(contextualGmailReplyPreflightAttestationFromObjective(
        'mcp__google-contacts__gmail_reply_all_preflight', allInput, [objective],
      )?.scope).toBe('reply-all');
    }
    for (const objective of [
      `Réponds à tous les points de ce mail, message ${messageId}.`,
      `Réponds à toutes les questions, message ${messageId}.`,
      `Réponds à tous ses arguments dans ce fil, message ${messageId}.`,
      `Réponds à tous les commentaires de ce mail, message ${messageId}.`,
      `Réponds à toutes les demandes dans ce fil, message ${messageId}.`,
      `Reply to all questions in this email, message ${messageId}.`,
      `Respond to all its arguments in this thread, message ${messageId}.`,
      `Reply to all comments in this email, message ${messageId}.`,
      `Reply to all concerns in this email, message ${messageId}.`,
      `Respond to all requests in this thread, message ${messageId}.`,
    ]) {
      expect(contextualGmailReplyPreflightAttestationFromObjective(
        'mcp__google-contacts__gmail_reply_all_preflight', allInput, [objective],
      )).toBeUndefined();
      expect(contextualGmailReplyPreflightAttestationFromObjective(
        'mcp__google-contacts__gmail_reply_preflight', oneInput, [objective],
      )?.scope).toBe('reply');
    }
  });

  it('lets newer stop/read-only amendments revoke a reply while preserving unrelated added tasks', () => {
    const initial = 'Réponds-lui au message 1a0aaa36e2769235 dans ce fil.';
    for (const amendment of [
      'Attends.', 'Patiente.', 'Pause.', 'Pas encore.', 'Stoppe.', 'Hold on.', 'Wait.',
      'Pause there.', 'Not yet.', 'Do not proceed.', 'Don’t do it yet.', 'I’ll tell you when.',
      'Je te dirai quand.', 'Laisse en attente.', 'Non.', 'Finalement non.', 'No.',
      'Actually no.', 'N’y va pas.', 'Ne continue pas.', 'Pas avant vendredi.', 'Vendredi.',
      'Finalement, analyse-le seulement.', 'En fait, fais juste un résumé.',
      'Je voulais seulement un résumé, pas une réponse.', 'Ignore la réponse, résume le mail.',
      'Actually, just analyze it.', 'Just a summary instead.',
      'Finalement transfère-le à Bob.', 'Actually forward it to Bob instead.',
    ]) {
      expect({ amendment, requested: isContextualGmailReplyRequestedByObjective([initial, amendment]) })
        .toEqual({ amendment, requested: false });
    }
    for (const addition of [
      'Envoie aussi le rapport à bob@example.com.',
      'Envoie aussi une notification Slack à Bob.',
      'Transmets aussi le PDF à Bob.',
      'Send the report to bob@example.com.',
      'Also send Bob a Slack message.',
    ]) {
      expect({ addition, requested: isContextualGmailReplyRequestedByObjective([initial, addition]) })
        .toEqual({ addition, requested: true });
    }
  });

  it('blocks every explicit non-canonical mail mutation during a contextual Gmail reply', () => {
    const objective = 'Réponds-lui au message 1a0aaa36e2769235 dans ce fil.';
    const options = {
      externalActionPolicy: 'allow-in-execute' as const,
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: [objective],
    };
    for (const [toolName, input] of [
      ['mcp__other-mail__send_email', { messageId: '1a0aaa36e2769235', body: 'Hi' }],
      ['mcp__custom__reply', { messageId: '1a0aaa36e2769235', body: 'Hi' }],
      ['mcp__custom__execute', { action: 'gmail_reply', messageId: '1a0aaa36e2769235' }],
      ['mcp__smtp__dispatch', { to: 'alice@example.com', body: 'Hi' }],
      ['mcp__api__post', { url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', body: 'Hi' }],
    ] as const) {
      expect(checkMcp('allow-all', toolName, input, objective, options)).toMatchObject({
        type: 'block',
        reason: expect.stringContaining('non-canonical MCP tools'),
      });
    }
    for (const command of [
      'python3 send_gmail_reply.py --message-id 1a0aaa36e2769235',
      'node gmail-reply.js 1a0aaa36e2769235',
      'python3 send_mail.py --to alice@example.com',
      'python3 dispatch_reply.py --to alice@example.com',
      'python3 -c "import smtplib; smtplib.SMTP().sendmail(\"a\",\"b\",\"x\")"',
      'sendmail alice@example.com < /tmp/reply.txt',
      'osascript -e \'tell application "Mail" to send outgoing message 1\'',
      String.raw`osascript -e "tell application \"Mail\" to send outgoing message 1"`,
      String.raw`python3 -c 'import os; os.system("osascript -e \\\"tell application \\\\\\\"Mail\\\\\\\" to send outgoing message 1\\\"")'`,
    ]) {
      expect(checkBash(
        'allow-all', command, objective, 'allow-in-execute', true, [objective],
      )).toMatchObject({ type: 'block', reason: expect.stringContaining('scripts') });
    }
  });
});
