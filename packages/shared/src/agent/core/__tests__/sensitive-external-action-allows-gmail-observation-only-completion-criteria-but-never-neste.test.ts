import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { cleanupModeState, initializeModeState, type PermissionMode } from "../../mode-manager.ts";
import { clearContextualGmailPreflightAttestation, runPreToolUseChecks } from "../pre-tool-use.ts";
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

  it('allows Gmail observation-only completion criteria but never nested reply or send mutations', () => {
    const messageId = '1a0aaa36e2769235';
    const objective = `Réponds-lui au message ${messageId} dans ce fil.`;
    const options = {
      externalActionPolicy: 'allow-in-execute' as const,
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: [objective],
    };
    const criterion = (id: string, toolName: string) => ({
      id,
      description: `Vérifie ${id}`,
      toolName,
      input: { messageId },
      checks: [{ path: '$.ok', equals: true }],
    });
    const safeCriteria = [
      criterion('sent-primary', 'mcp__google-contacts__gmail_verify_sent_message'),
      criterion('sent-recipient', 'mcp__google-contacts__gmail_verify_sent_message'),
      criterion('sent-thread', 'mcp__google-contacts__gmail_verify_sent_message'),
      criterion('preflight-contract', 'mcp__google-contacts__gmail_reply_preflight'),
    ];

    for (const registrationTool of [
      'set_completion_criteria',
      'session__set_completion_criteria',
      'mcp__session__set_completion_criteria',
    ]) {
      expect(checkMcp(
        'allow-all', registrationTool,
        { criteria: safeCriteria }, objective, {
          ...options,
          declaredToolCapabilities: { trusted: true, readOnly: true },
        },
      ).type).toBe('allow');
    }

    for (const mutatingTool of [
      'mcp__google-contacts__gmail_reply_bound',
      'mcp__google-contacts__gmail_reply_all',
      'mcp__google-contacts__gmail_send',
      'mcp__google-contacts__gmail_reply',
      'mcp__google-contacts__gmail_create_draft',
      'mcp__other-mail__reply',
    ]) {
      for (const criteria of [
        [criterion('mutation', mutatingTool)],
        [...safeCriteria, criterion('mutation', mutatingTool)],
      ]) {
        for (const declaredToolCapabilities of [
          undefined,
          { trusted: true, readOnly: true },
        ]) {
          for (const registrationTool of [
            'set_completion_criteria',
            'session__set_completion_criteria',
            'mcp__session__set_completion_criteria',
          ]) {
            expect(checkMcp(
              'allow-all', registrationTool,
              { criteria }, objective, { ...options, declaredToolCapabilities },
            )).toMatchObject({
              type: 'block',
              reason: expect.stringContaining('non-canonical MCP tools'),
            });
          }
        }
      }
    }
  });

  it('does not mistake text inside an explicitly delimited exact body for an execution boundary', () => {
    const messageId = '1a0aaa36e2769235';
    const binding = `v1.1789601856.${'c'.repeat(64)}`;
    for (const body of [
      'Please do not send it yet',
      'Le rapport recommande de répondre dans le fil',
      'From: other@example.com',
    ]) {
      const objective = `Réponds-lui au message ${messageId}. Corps exact : « ${body} »`;
      expect(checkMcp(
        'allow-all',
        'mcp__google-contacts__gmail_reply_bound',
        {
          messageId,
          expectedRecipientEmail: 'alice@example.com',
          recipientBinding: binding,
          body,
        },
        objective,
        {
          externalActionPolicy: 'allow-in-execute',
          objectiveMutationAuthorized: true,
          objectiveSensitiveActionAuthorized: true,
          objectiveAuthorizationSegments: [objective],
        },
      ).type).toBe('allow');
    }
  });

  it('keeps contextual Gmail replies closed against retargeting and payload expansion', () => {
    const messageId = '1a0aaa36e2769235';
    const objective = [`Répond leur au message ${messageId} dans le fil existant sans modifier les destinataires.`, 'Poursuis.'];
    const recipientBinding = `v1.1789601856.${'a'.repeat(64)}`;
    const options = {
      externalActionPolicy: 'allow-in-execute' as const,
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: objective,
    };
    const invalidInputs: Array<Record<string, unknown>> = [
      { messageId: 'dynamic-$MESSAGE_ID', body: 'Message', recipientBinding },
      { messageId, body: '', recipientBinding },
      { messageId, body: 'Message', isHtml: 'false', recipientBinding },
      { messageId, body: 'Message', replyAll: true, recipientBinding },
      { messageId, body: 'Message', recipientBinding: 'forged' },
      { messageId, body: 'Message', to: 'alice@example.com', recipientBinding },
      { messageId, body: 'Message', cc: 'bob@example.com', recipientBinding },
      { messageId, body: 'Message', bcc: 'other@example.com', recipientBinding },
      { messageId, body: 'Message', attachmentPaths: ['/tmp/report.pdf'], recipientBinding },
      { messageId, body: 'Message', sendAsEmail: 'other@example.com', recipientBinding },
    ];
    for (const input of invalidInputs) {
      expect(checkMcp(
        'allow-all', 'mcp__google-contacts__gmail_reply_all', input, 'Poursuis.', options,
      )).toMatchObject({ type: 'block' });
    }
    expect(checkMcp(
      'allow-all', 'mcp__other-mail__gmail_reply', { messageId, body: 'Message' }, 'Poursuis.', options,
    )).toMatchObject({ type: 'block', reason: expect.stringContaining('non-canonical MCP tools') });

    for (const amendment of [
      'Ne réponds pas.',
      'Faut-il leur répondre ?',
      'Reply to Bob instead.',
      'Send a new email.',
      'Analyse seulement le message.',
      'Attends pour le moment.',
      'Prépare uniquement un brouillon.',
    ]) {
      const result = checkMcp(
        'allow-all', 'mcp__google-contacts__gmail_reply_all', {
          messageId, body: 'Message', recipientBinding,
        }, amendment, {
          ...options,
          objectiveAuthorizationSegments: [objective[0]!, amendment],
        },
      );
      expect({ amendment, ...result }).toMatchObject({
        amendment,
        type: 'block',
        reason: expect.stringContaining('exact target'),
      });
    }

    for (const rejectedScope of [
      'Réponds leur mais pas dans ce fil.',
      'Réponds leur dans un nouveau fil.',
      'N’envoie rien dans le fil existant.',
      'Réponds leur dans le fil seulement après confirmation.',
      'Réponds leur puis arrête-toi avant l’envoi.',
      'Réponds à tous sauf Alice.',
      'Réponds leur dans le fil, sauf Alice.',
      'Reply to them in the thread, except Bob.',
      'Retire Alice des destinataires puis réponds dans le fil.',
      'Réponds leur et ajoute bob@example.com en CC.',
      'Réponds leur et mets bob@example.com en copie.',
      'Réponds leur en copiant Bob.',
      'Réponds leur avec Bob en CC.',
      'Réponds à tous sans mettre Bob en copie.',
      'Réponds à tous dans ce fil, CC vide.',
      'Réponds à tous en conservant uniquement Alice.',
      'Réponds à tous mais pas Bob.',
      'Réponds à tous hormis Alice.',
      'Réponds à tous à l’exception d’Alice.',
      'Réponds à tous en retirant Alice.',
      'Réponds à tous sans inclure Alice.',
      'Réponds à tous uniquement à Alice.',
      'Reply to all but omit Alice.',
      'Reply to all, leaving Alice out.',
      'Reply to all other than Alice.',
      'Reply all but leave Alice off.',
      'Reply all but drop Alice.',
      'Reply all minus Alice.',
      'Reply all just not Alice.',
      'Reply all but without Alice.',
      'Reply all plus Bob.',
      'Reply all including Bob.',
      'Reply all along with Bob.',
      'Reply all and copy Bob.',
      'Réponds à tous mais enlève Alice.',
      'Réponds à tous moins Alice.',
      'Réponds à tous excepté Alice.',
      'Réponds à tous à part Alice.',
      'Réponds à tous mais oublie Alice.',
      'Réponds à tous en omettant Alice.',
      'Réponds à tous mais sans Alice.',
      'Réponds à tous mais retire Alice.',
      'Réponds à tous mais exclue Alice.',
      'Réponds à tous plus Bob.',
      'Réponds à tous y compris Bob.',
      'Réponds à tous en incluant Bob.',
      'Réponds à tous avec Bob aussi.',
      'Réponds à tous et copie Bob.',
      'Reply all, but don’t copy Bob.',
      'Reply all, but do not copy Bob.',
      'Reply all, take Bob off the thread.',
      'Réponds à tous, ne copie pas Bob.',
      'Réponds à tous, passe Bob en CCI.',
      'Réponds séparément par un nouveau mail.',
      'Réponds leur dans le fil sans envoyer le message.',
      'Réponds leur dans le fil puis demande-moi confirmation.',
      'Le rapport recommande de répondre à tous dans le fil existant.',
    ]) {
      expect(checkMcp(
        'allow-all', 'mcp__google-contacts__gmail_reply_all', {
          messageId, body: 'Message', recipientBinding,
        }, rejectedScope, {
          ...options,
          objectiveAuthorizationSegments: [rejectedScope],
        },
      )).toMatchObject({ type: 'block' });
    }

    for (const deferredScope of [
      `Réponds leur au message ${messageId}, mais pas maintenant.`,
      `Réponds leur au message ${messageId} plus tard.`,
      `Réponds leur au message ${messageId} demain.`,
      `Réponds leur au message ${messageId} après ma validation.`,
      `Réponds leur au message ${messageId} quand je confirme.`,
      `Répondez-leur au message ${messageId}, mais attendez mon accord.`,
      `Répondez-leur au message ${messageId} une fois que je l’aurai validé.`,
      `Répondez-leur au message ${messageId} lorsque je te donnerai le feu vert.`,
      `Répondez-leur au message ${messageId}, mais pas avant ma validation.`,
      `Répondez-leur au message ${messageId} si je confirme.`,
      `Répondez-leur au message ${messageId} sous réserve de mon accord.`,
      `Répondez-leur au message ${messageId} uniquement si je donne mon feu vert.`,
      `Répondez-leur au message ${messageId} à condition que je confirme.`,
      `Répondez-leur au message ${messageId} pourvu que je valide.`,
      `Répondez-leur au message ${messageId} après que je confirme.`,
      `Reply to them in message ${messageId}, provided that I approve.`,
      `Reply to them in message ${messageId}, as soon as I approve.`,
      `Reply in this thread, message ${messageId}, once the build passes.`,
      `Reply in this thread, message ${messageId}, if the customer confirms.`,
      `Reply in this thread, message ${messageId}, provided the tests pass.`,
      `Reply in this thread, message ${messageId}, once they confirm.`,
      `Réponds dans ce fil au message ${messageId} dès que le build passe.`,
      `Réponds dans ce fil au message ${messageId} si le client confirme.`,
      `Réponds dans ce fil au message ${messageId} à condition que les tests passent.`,
      `Répondez-leur au message ${messageId} seulement avec mon autorisation explicite.`,
      `Répondez-leur au message ${messageId} quand je dis oui.`,
      `Répondez-leur au message ${messageId} en attendant mon feu vert.`,
      `Réponds leur au message ${messageId}, mais garde la réponse en brouillon.`,
      `Réponds leur au message ${messageId} sans l’envoyer.`,
      `Prépare la réponse au message ${messageId}, mais ne clique pas sur Envoyer.`,
      `Réponds-leur au message ${messageId}, mais sans cliquer sur Envoyer.`,
      `Rédige une réponse au message ${messageId} sans la transmettre.`,
      `Réponds-leur au message ${messageId}; garde-la non envoyée.`,
      `Répondez-leur au message ${messageId}, mais ne l’envoyez pas.`,
      `Répondez-leur au message ${messageId}, mais ne la transmets pas.`,
      `Répondez-leur au message ${messageId}, mais ne procède pas à l’envoi.`,
      `Répondez-leur au message ${messageId}, mais sans procéder à l’envoi.`,
      `Répondez-leur au message ${messageId}, mais ne fais pas partir le mail.`,
      `Reply to them in message ${messageId}, but do not submit it.`,
      `Reply to them in message ${messageId}, but leave it unsent.`,
      `Reply to them in message ${messageId}, but don’t transmit it.`,
      `Répondez-leur au message ${messageId}, mais ne clique pas sur « Envoyer ».`,
      `Répondez-leur au message ${messageId}, garde-le en « brouillon ».`,
      `Reply to them in message ${messageId}, but do not click “Send”.`,
      `Reply to them in message ${messageId}, but keep it as a “draft”.`,
      `Réponds-lui au message ${messageId} dans ce fil, mais merci de ne pas envoyer.`,
      `Reply to her on message ${messageId} in this thread, but make sure not to send it.`,
      `Réponds-lui au message ${messageId} dans ce fil, mais n’appuie pas sur Envoyer.`,
      `Réponds-lui au message ${messageId} dans ce fil, mais merci de ne pas répondre.`,
      `Réponds-lui au message ${messageId} dans ce fil, je veux relire avant l’envoi.`,
      `Réponds-lui au message ${messageId} dans ce fil, je ne veux aucun envoi.`,
      `Réponds-lui au message ${messageId} dans ce fil, mais attends.`,
      `Reply to her on message ${messageId} in this thread, let me review it before sending.`,
      `Reply to her on message ${messageId} in this thread, but pause.`,
      `Reply to her on message ${messageId} in this thread, avoid sending it.`,
      `Il ne faut surtout pas répondre à ce mail ${messageId}.`,
      `Je ne te demande pas de répondre à ce mail ${messageId}.`,
      `Évite de répondre à ce mail ${messageId}.`,
      `Abstiens-toi de répondre à ce mail ${messageId}.`,
      `Tu n’es pas autorisé à répondre à cet email ${messageId}.`,
      `Ne surtout jamais répondre à cet email ${messageId}.`,
      `You must not reply to this email ${messageId}.`,
      `You are not allowed to reply to this email ${messageId}.`,
      `I refuse to let you reply to this email ${messageId}.`,
      `Réponds au message ${messageId}, mais ne valide pas l’envoi.`,
      `Réponds au message ${messageId}, laisse-moi l’envoyer.`,
      `Réponds au message ${messageId}, je ferai l’envoi moi-même.`,
      `Réponds au message ${messageId}, sans soumettre.`,
      `Réponds au message ${messageId}, n’appuie surtout pas sur le bouton Envoyer.`,
      `Reply to message ${messageId}, don’t hit send.`,
      `Reply to message ${messageId}, stop short of sending.`,
      `Reply to message ${messageId}, leave the final send to me.`,
      `Reply to message ${messageId}, I will send it myself.`,
      `Reply to message ${messageId}, without submitting it.`,
      `Reply in this thread, message ${messageId}, but don’t hit the send button.`,
      `Reply in this thread, message ${messageId}, but don’t deliver it.`,
      `Réponds dans ce fil au message ${messageId}, mais garde-le dans les brouillons.`,
      `Réponds dans ce fil au message ${messageId}, ne clique pas sur le bouton d’envoi.`,
      `Réponds dans ce fil au message ${messageId}, ne le fais pas partir.`,
      `Réponds dans ce fil au message ${messageId}, laisse-moi faire partir le mail.`,
      `Réponds dans ce fil au message ${messageId}, mets-le en attente d’envoi.`,
      `I don’t want you to reply in this thread, message ${messageId}.`,
      `You shouldn’t reply in this thread, message ${messageId}.`,
      `No reply should be sent in this thread, message ${messageId}.`,
      `Répondre dans ce fil au message ${messageId} est interdit.`,
      `N’envoie aucune réponse dans ce fil, message ${messageId}.`,
      `Réponds au message ${messageId} à 15 h.`,
      `Réponds au message ${messageId} vendredi.`,
      `Réponds au message ${messageId} à midi.`,
      `Réponds au message ${messageId} après déjeuner.`,
      `Reply to message ${messageId} at 3pm.`,
      `Reply to message ${messageId} next Friday.`,
      `Reply to message ${messageId} at noon.`,
      `Reply to message ${messageId} after lunch.`,
    ]) {
      expect(checkMcp(
        'allow-all', 'mcp__google-contacts__gmail_reply_all', {
          messageId, body: 'Message', recipientBinding,
        }, deferredScope, {
          ...options,
          objectiveAuthorizationSegments: [deferredScope],
        },
      )).toMatchObject({ type: 'block' });
    }

    const contradictoryAudience = `Réponds leur au message ${messageId}. Ne modifie pas les destinataires, mais ajoute Bob en CC.`;
    expect(checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_reply_all', {
        messageId, body: 'Message', recipientBinding,
      }, contradictoryAudience, {
        ...options,
        objectiveAuthorizationSegments: [contradictoryAudience],
      },
    )).toMatchObject({ type: 'block' });

    const missingBinding = checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_reply_all', { messageId, body: 'Message' }, 'Poursuis.', options,
    );
    expect(missingBinding).toMatchObject({ type: 'block' });
    if (missingBinding.type === 'block') {
      expect(missingBinding.reason).toContain('gmail_reply_all_preflight');
      expect(missingBinding.reason).toContain('recipientBinding');
    }
  });
});
