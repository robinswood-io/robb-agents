import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { cleanupModeState, initializeModeState, type PermissionMode } from "../../mode-manager.ts";
import { clearContextualGmailPreflightAttestation, runPreToolUseChecks } from "../pre-tool-use.ts";
import { contextualGmailExactEffectExpectationFromObjective, contextualGmailReplyPreflightAttestationFromObjective, isContextualGmailReplyRequestedByObjective } from "../sensitive-external-action.ts";
import { whitelistedPermissionManager } from "./testing/sensitive-external-action-fixture.ts";

const usedSessionIds: string[] = [];
const temporaryPaths: string[] = [];
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
    ...(options?.externalActionPolicy !== undefined ? { externalActionPolicy: options?.externalActionPolicy } : {}),
    ...(options?.objectiveMutationAuthorized !== undefined ? { objectiveMutationAuthorized: options?.objectiveMutationAuthorized } : {}),
    ...(options?.objectiveSensitiveActionAuthorized !== undefined ? { objectiveSensitiveActionAuthorized: options?.objectiveSensitiveActionAuthorized } : {}),
    ...(options?.objectiveAuthorizationSegments !== undefined ? { objectiveAuthorizationSegments: options?.objectiveAuthorizationSegments } : {}),
    ...(options?.authenticatedUserAuthorizationSegments !== undefined ? { authenticatedUserAuthorizationSegments: options?.authenticatedUserAuthorizationSegments } : {}),
    ...(options?.dataFolderPath !== undefined ? { dataFolderPath: options?.dataFolderPath } : {}),
    ...(options?.declaredToolCapabilities !== undefined ? { declaredToolCapabilities: options?.declaredToolCapabilities } : {}),
    permissionManager: whitelistedPermissionManager,
    ...(currentUserRequest !== undefined ? { currentUserRequest } : {}),
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

  it('authorizes only a signed closed existing-thread Gmail reply-all from contextual human scope', () => {
    const messageId = '1a0aaa36e2769235';
    const options = (objectiveAuthorizationSegments: readonly string[]) => ({
      externalActionPolicy: 'allow-in-execute' as const,
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments,
    });
    const reply = { messageId, body: 'Merci, nous attendons la clé API.', isHtml: false };
    const replyAll = {
      ...reply,
      recipientBinding: `v1.1789601856.${'a'.repeat(64)}`,
    };
    const boundReply = {
      ...reply,
      expectedRecipientEmail: 'laurent@example.test',
      recipientBinding: `v1.1789601856.${'b'.repeat(64)}`,
    };

    expect(checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_reply_bound', boundReply, 'Poursuis.',
      options([`Réponds-lui au message ${messageId}.`, 'Poursuis.']),
    ).type).toBe('allow');

    expect(checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_reply_all', replyAll, 'Poursuis.',
      options([`Répond leur au message ${messageId} que nous attendons l’ouverture de la clé API.`, 'Poursuis.']),
    ).type).toBe('allow');
    expect(checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_reply_all', replyAll, 'Poursuis.',
      options([
        `Envoie-la exactement une fois dans le fil existant ancré sur ${messageId}, sans modifier les destinataires.`,
        'Poursuis.',
      ]),
    ).type).toBe('allow');
    expect(checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_reply_all', replyAll, 'Poursuis.',
      options([`Réponds leur au message ${messageId} et ne modifie pas les destinataires.`, 'Poursuis.']),
    ).type).toBe('allow');
    expect(checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_reply_all', replyAll, 'Poursuis.',
      options([`Réponds leur au message ${messageId} et ne retire aucun destinataire.`, 'Poursuis.']),
    ).type).toBe('allow');
    expect(checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_reply_all', replyAll, 'Poursuis.',
      options([
        `Réponds leur au message ${messageId} et ne retire aucun destinataire.`,
        'Termine aussi le connecteur puis vérifie SharePoint.',
      ]),
    ).type).toBe('allow');
    expect(checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_reply_all', {
        ...replyAll,
        body: 'Bonjour',
      }, 'Poursuis.',
      options([`Réponds leur au message ${messageId} avec le texte exact « Bonjour ».`, 'Poursuis.']),
    ).type).toBe('allow');
    expect(checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_reply_all', {
        ...replyAll,
        body: 'CONTENU DIFFERENT',
      }, 'Poursuis.',
      options([`Réponds leur au message ${messageId} avec le texte exact « Bonjour ».`, 'Poursuis.']),
    )).toMatchObject({
      type: 'block',
      reason: (expect.stringContaining('does not match the exact delimited body') as unknown),
    });
    expect(checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_reply', reply, 'Poursuis.',
      options([`Réponds-lui au message ${messageId}.`, 'Poursuis.']),
    )).toMatchObject({
      type: 'block',
      reason: (expect.stringContaining('gmail_reply_preflight') as unknown),
    });

    // Reply-all cannot be inferred from a singular instruction, while a
    // no-recipient-change instruction cannot silently degrade to plain reply.
    const singularReplyAll = checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_reply_all', replyAll, 'Réponds-lui.',
      options([`Réponds-lui au message ${messageId}.`]),
    );
    expect(singularReplyAll).toMatchObject({ type: 'block' });
    if (singularReplyAll.type === 'block') {
      expect(singularReplyAll.reason).toContain('mcp__google-contacts__gmail_reply');
    }
    const wrongReplyMode = checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_reply_bound', boundReply, 'Poursuis.',
      options([`Réponds au message ${messageId} dans le fil existant sans modifier les destinataires.`, 'Poursuis.']),
    );
    expect(wrongReplyMode).toMatchObject({ type: 'block' });
    if (wrongReplyMode.type === 'block') {
      expect(wrongReplyMode.reason).toContain('mcp__google-contacts__gmail_reply_all');
    }

    // Explore remains fail-closed even for an otherwise authorized reply.
    expect(checkMcp(
      'safe', 'mcp__google-contacts__gmail_reply_all', replyAll, 'Poursuis.',
      options([`Répond leur au message ${messageId} dans le fil existant.`, 'Poursuis.']),
    )).toMatchObject({ type: 'block', reason: (expect.stringContaining('Explore') as unknown) });
  });

  it.each([
    {
      language: 'French',
      body: 'Nous attendons l’ouverture de la clé API.\nNous reviendrons vers vous si nécessaire.',
      objective: (messageId: string, body: string) => [
        `Réponds à tous au message ${messageId} dans le fil existant sans modifier les destinataires.`,
        'Envoie exactement :',
        body,
        'Instruction suivante : vérifie une seule fois dans le fil Envoyés.',
      ].join('\n'),
    },
    {
      language: 'English',
      body: 'We are waiting for the API key to be opened.\nWe will follow up if needed.',
      objective: (messageId: string, body: string) => [
        `Reply all to message ${messageId} in the existing thread, leaving recipients unchanged.`,
        'Send exactly:',
        body,
        'Next instruction: verify it once in Sent.',
      ].join('\n'),
    },
  ])('binds an unquoted multiline exact body in $language without absorbing the next instruction', ({ body, objective }) => {
    const messageId = '1a0aaa36e2769235';
    const acceptedObjective = objective(messageId, body);
    const options = {
      externalActionPolicy: 'allow-in-execute' as const,
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: [acceptedObjective],
    };
    const input = {
      messageId,
      recipientBinding: `v1.1789601856.${'a'.repeat(64)}`,
      body,
    };

    expect(checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_reply_all', input, acceptedObjective, options,
    ).type).toBe('allow');
    expect(checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_reply_all', {
        ...input,
        body: `${body}\nTexte ajouté par le modèle.`,
      }, acceptedObjective, options,
    )).toMatchObject({
      type: 'block',
      reason: (expect.stringContaining('does not match the exact delimited body') as unknown),
    });
    expect(checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_reply_all', {
        ...input,
        body: `${body}\nVérifie ensuite une seule fois dans le fil Envoyés.`,
      }, acceptedObjective, options,
    )).toMatchObject({
      type: 'block',
      reason: (expect.stringContaining('does not match the exact delimited body') as unknown),
    });
  });

  it('fails closed when an unquoted exact body contains instruction-shaped prose', () => {
    const messageId = '1a0aaa36e2769235';
    const fullBody = [
      'Bonjour,',
      'Puis vérifiez votre compte et confirmez-moi le résultat.',
      'Merci.',
    ].join('\n');
    const objective = [
      `Réponds-lui au message ${messageId}.`,
      'Corps exact :',
      '',
      fullBody,
      '',
      'S’il n’est pas déjà envoyé, refais un préflight puis appelle l’outil gmail_reply_bound.',
    ].join('\n');
    const options = {
      externalActionPolicy: 'allow-in-execute' as const,
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: [objective],
    };
    for (const body of [fullBody, 'Bonjour,']) {
      expect(checkMcp(
        'allow-all', 'mcp__google-contacts__gmail_reply_bound', {
          messageId,
          expectedRecipientEmail: 'alice@example.com',
          recipientBinding: `v1.1789601856.${'d'.repeat(64)}`,
          body,
        }, objective, options,
      )).toMatchObject({
        type: 'block',
        reason: (expect.stringContaining('exact delimited body') as unknown),
      });
    }
  });

  it('keeps ordinary API wording inside an exact unquoted Gmail body', () => {
    const messageId = '1a0aaa36e2769235';
    const body = [
      'Bonjour,',
      '',
      'Utilisez l’API interne pour récupérer votre dossier.',
      '',
      'Merci.',
    ].join('\n');
    const objective = [
      `Réponds à alice@example.com au message ${messageId}.`,
      'Corps exact :',
      '',
      body,
      '',
      'Cet envoi exact est déjà autorisé par l’objectif en cours.',
    ].join('\n');
    const input = {
      messageId,
      expectedRecipientEmail: 'alice@example.com',
      recipientBinding: `v1.1789601856.${'d'.repeat(64)}`,
      body,
    };
    const options = {
      externalActionPolicy: 'allow-in-execute' as const,
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: [objective],
    };

    expect(checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_reply_bound', input, objective, options,
    ).type).toBe('allow');
    expect(contextualGmailExactEffectExpectationFromObjective([objective])).toMatchObject({
      anchorMessageId: messageId,
      expectedRecipientEmail: 'alice@example.com',
      expectedBody: body,
    });
  });

  it('composes exact Gmail constraints from a later authenticated amendment', () => {
    const messageId = '1a0a917ea946a540';
    const objectiveSegments = [
      `Réponds à alice@example.com au message ${messageId}.`,
      'Utilise exactement ce corps : «Bonjour Alice»',
    ];
    const correct = {
      messageId,
      expectedRecipientEmail: 'alice@example.com',
      body: 'Bonjour Alice',
      isHtml: false,
    };
    const wrong = { ...correct, body: 'CORPS DIFFÉRENT' };

    expect(isContextualGmailReplyRequestedByObjective(objectiveSegments)).toBeTrue();
    expect(contextualGmailExactEffectExpectationFromObjective(objectiveSegments)).toMatchObject({
      anchorMessageId: messageId,
      expectedRecipientEmail: 'alice@example.com',
      expectedBody: 'Bonjour Alice',
    });
    expect(contextualGmailReplyPreflightAttestationFromObjective(
      'mcp__google-contacts__gmail_reply_preflight', correct, objectiveSegments,
    )).toMatchObject({ body: 'Bonjour Alice' });
    expect(contextualGmailReplyPreflightAttestationFromObjective(
      'mcp__google-contacts__gmail_reply_preflight', wrong, objectiveSegments,
    )).toBeUndefined();
    for (const paddedBody of ['  Bonjour Alice  ', '\nBonjour Alice\n']) {
      expect(contextualGmailReplyPreflightAttestationFromObjective(
        'mcp__google-contacts__gmail_reply_preflight',
        { ...correct, body: paddedBody },
        objectiveSegments,
      )).toBeUndefined();
    }

    const conflictingSegments = [...objectiveSegments, 'Corps exact : «Bonjour Bob»'];
    expect(contextualGmailReplyPreflightAttestationFromObjective(
      'mcp__google-contacts__gmail_reply_preflight', correct, conflictingSegments,
    )).toBeUndefined();

    const unrelatedSlackAmendment = [
      objectiveSegments[0]!,
      'Pour la notification Slack, message exact : «Alerte incident P1»',
    ];
    expect(contextualGmailExactEffectExpectationFromObjective(unrelatedSlackAmendment)).not
      .toHaveProperty('expectedBody');
    expect(contextualGmailReplyPreflightAttestationFromObjective(
      'mcp__google-contacts__gmail_reply_preflight', correct, unrelatedSlackAmendment,
    )).toMatchObject({ body: 'Bonjour Alice' });
  });

  it('does not invert positive exact-effect conditions into send authority', () => {
    for (const objective of [
      'Si l’effet exact existe, effectue une réponse API au message 1a0a917ea946a540.',
      'If the exact effect exists, perform an API reply to message 1a0a917ea946a540.',
      'Si l’effet exact apparaît, réponds au message 1a0a917ea946a540.',
    ]) {
      expect(isContextualGmailReplyRequestedByObjective([objective])).toBeFalse();
    }
    expect(isContextualGmailReplyRequestedByObjective([
      'Réponds au message 1a0a917ea946a540. Aucun second envoi si l’effet exact apparaît.',
    ])).toBeTrue();
  });
});
