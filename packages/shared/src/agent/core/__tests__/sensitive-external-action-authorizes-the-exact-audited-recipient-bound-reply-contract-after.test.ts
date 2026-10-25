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

  it('authorizes the exact audited recipient-bound reply contract after duplicate-safe verification', () => {
    const messageId = '1a0a087bffc71438';
    const recipient = 'franck@example.test';
    const body = [
      'Bonjour Franck,',
      '',
      'Merci, j’ai bien reçu les éléments pour MEG / WithTime / GuardTek — exports mai/juin. Je les ai documentés côté suivi projet et je lance la vérification technique côté OSS.',
      '',
      'Pour finaliser le test proprement, il me manque encore ou je dois confirmer : sandbox/périmètre test, scopes.',
      '',
      'Je reviens avec le résultat du test ou le point bloquant exact.',
    ].join('\n');
    const objective = [
      `Reprends et termine l’envoi exact déjà autorisé à Franck dans le fil Gmail ${messageId}, uniquement via l’API Gmail et jamais via navigateur.`,
      'Vérifie d’abord le dossier Envoyés et ce fil pour exclure tout envoi déjà produit.',
      `Cible exacte : ${recipient}, From sender@example.test, CC vide, sujet « Re: Mise en relation — Robinswood / Sample Supplier — Projet Exemple ».`,
      'Corps exact :',
      '',
      body,
      '',
      'S’il n’est pas déjà envoyé, refais un préflight signé frais puis appelle une seule fois l’outil de réponse/envoi avec exactement le jeton, le destinataire, les CC, le fil et le corps liés par ce préflight.',
      'Ne modifie ni le connecteur ni l’hôte, ne cherche pas sur le Web, ne duplique aucun effet.',
      'Termine seulement après preuve API de l’envoi et vérification dans Envoyés ; si une autorité réellement indispensable manque encore, pose une seule question structurée.',
    ].join('\n');
    const preflightInput = {
      messageId,
      expectedRecipientEmail: recipient,
      expectedSenderEmail: 'sender@example.test',
      body,
      isHtml: false,
    };
    const binding = `v1.1789601856.${'b'.repeat(64)}`;
    const options = {
      externalActionPolicy: 'allow-in-execute' as const,
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: [objective],
    };

    expect(isContextualGmailReplyRequestedByObjective([objective])).toBeTrue();
    expect(contextualGmailReplyPreflightAttestationFromObjective(
      'mcp__google-contacts__gmail_reply_preflight', preflightInput, [objective],
    )).toMatchObject({
      scope: 'reply',
      messageId,
      expectedRecipientEmail: recipient,
      expectedSenderEmail: 'sender@example.test',
      body,
      isHtml: false,
    });
    expect(contextualGmailReplyPreflightAttestationFromObjective(
      'mcp__google-contacts__gmail_reply_preflight', {
        ...preflightInput,
        expectedSenderEmail: undefined,
      }, [objective],
    )).toBeUndefined();
    expect(contextualGmailReplyPreflightAttestationFromObjective(
      'mcp__google-contacts__gmail_reply_preflight', {
        ...preflightInput,
        expectedSenderEmail: 'other@example.test',
      }, [objective],
    )).toBeUndefined();
    for (const ambiguousSenderObjective of [
      `Reply to ${recipient} in message ${messageId}. From: sender@example.test From: other@example.test.`,
      `Reply to ${recipient} in message ${messageId}. Sender: sender@example.test and sender: other@example.test.`,
    ]) {
      expect(contextualGmailReplyPreflightAttestationFromObjective(
        'mcp__google-contacts__gmail_reply_preflight', preflightInput,
        [ambiguousSenderObjective],
      )).toBeUndefined();
    }
    expect(contextualGmailReplyPreflightAttestationFromObjective(
      'mcp__google-contacts__gmail_reply_preflight', {
        ...preflightInput,
        expectedRecipientEmail: 'alice@example.com',
        expectedSenderEmail: undefined,
      }, [`Reply in thread message ${messageId}, From alice@example.com.`],
    )).toMatchObject({ expectedRecipientEmail: 'alice@example.com' });
    expect(checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_reply_bound', {
        ...preflightInput,
        recipientBinding: binding,
      }, objective, options,
    ).type).toBe('allow');

    expect(checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_reply_bound', {
        ...preflightInput,
        expectedSenderEmail: undefined,
        recipientBinding: binding,
      }, objective, options,
    )).toMatchObject({
      type: 'block',
      reason: expect.stringContaining('expectedSenderEmail'),
    });
    expect(checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_reply_bound', {
        ...preflightInput,
        expectedSenderEmail: 'other@example.test',
        recipientBinding: binding,
      }, objective, options,
    )).toMatchObject({
      type: 'block',
      reason: expect.stringContaining('expectedSenderEmail'),
    });
    expect(checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_reply_bound', {
        ...preflightInput,
        expectedRecipientEmail: 'other@example.com',
        recipientBinding: binding,
      }, objective, options,
    )).toMatchObject({
      type: 'block',
      reason: expect.stringContaining('exact recipient'),
    });
    expect(checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_reply_bound', {
        ...preflightInput,
        body: `${body}\nAjout non autorisé.`,
        recipientBinding: binding,
      }, objective, options,
    )).toMatchObject({
      type: 'block',
      reason: expect.stringContaining('exact delimited body'),
    });
  });

  it('keeps an explicit absence check followed by one exact API reply authoritative', () => {
    const messageId = '1a0a917ea946a540';
    const recipient = 'laurent@example.test';
    const body = 'Bonjour Ludovic,\n\nNous attendons l’ouverture de la clé API.';
    const root = [
      `Réponds dans le fil Gmail ${messageId}, cible exacte : ${recipient}, From: sender@example.test, CC vide, sujet « RE: Compte-rendu PLC ».`,
      `Corps exact : «${body}»`,
    ].join('\n');
    const amendment = "Vérifie l’absence de cet effet exact puis, seulement s’il est absent, effectue une unique réponse API.";
    const objectiveSegments = [root, amendment];
    const preflightInput = {
      messageId,
      expectedRecipientEmail: recipient,
      expectedSenderEmail: 'sender@example.test',
      body,
      isHtml: false,
    };
    expect(isContextualGmailReplyRequestedByObjective(objectiveSegments)).toBeTrue();
    expect(isContextualGmailReplyRequestedByObjective([
      root,
      'Check that the exact effect is absent, then only if absent perform one API reply.',
    ])).toBeTrue();
    expect(contextualGmailReplyPreflightAttestationFromObjective(
      'mcp__google-contacts__gmail_reply_preflight', preflightInput, objectiveSegments,
    )).toMatchObject({
      messageId, expectedRecipientEmail: recipient, body,
      expectedCc: '', expectedSubject: 'RE: Compte-rendu PLC',
    });
    expect(contextualGmailExactEffectExpectationFromObjective(objectiveSegments)).toEqual({
      scope: 'reply',
      anchorMessageId: messageId,
      expectedRecipientEmail: recipient,
      expectedSenderEmail: 'sender@example.test',
      expectedCc: '',
      expectedSubject: 'RE: Compte-rendu PLC',
      expectedBody: body,
      expectedIsHtml: false,
    });
  });
});
