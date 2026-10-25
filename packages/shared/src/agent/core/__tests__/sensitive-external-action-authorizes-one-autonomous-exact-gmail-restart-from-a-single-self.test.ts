import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { cleanupModeState, initializeModeState, type PermissionMode } from "../../mode-manager.ts";
import { clearContextualGmailPreflightAttestation, recordContextualGmailToolResult, runPreToolUseChecks, type PermissionManagerLike } from "../pre-tool-use.ts";
import { contextualGmailClosedExactEffectExpectationFromObjective, contextualGmailReplyPreflightAttestationFromObjective, isContextualGmailReplyRequestedByObjective } from "../sensitive-external-action.ts";
import { gmailRecipientBinding, whitelistedPermissionManager } from "./testing/sensitive-external-action-fixture.ts";

const usedSessionIds: string[] = [];
const temporaryPaths: string[] = [];
function createClosedExactGmailPreflightScenario(options: {
  body?: string;
  objectiveTransform?: (objective: string) => string;
  permissionMode?: PermissionMode;
  permissionManager?: PermissionManagerLike;
  subject?: string;
} = {}) {
  const messageId = '1a0a917ea946a540';
  const threadId = '1a0a917ea946a541';
  const recipient = 'alice@example.com';
  const sender = 'sender@example.test';
  const subject = options.subject ?? 'RE: Validation du contrat';
  const body = options.body ?? 'Merci Alice, le contrat est validé.';
  const operationKey = 'f'.repeat(64);
  const canonicalObjective = [
    'Marqueur de relance autonome : gmail-reply-exact-v1.',
    `Réponds maintenant dans le fil Gmail ${messageId}, cible exacte : ${recipient}, From: ${sender}, CC vide, sujet exact « ${subject} ».`,
    `Corps exact : «${body}»`,
    'Sans signature automatique et sans pièce jointe.',
    'Utilise uniquement l’API Gmail, jamais le navigateur. Un préflight signé frais est obligatoire avant toute réponse.',
    'Respecte le résultat du connecteur et clôture si le préflight signale un doublon ou une ambiguïté.',
    'Seulement si l’absence exacte est concluante, exécute au plus une unique réponse liée à cette ancre, puis vérifie le messageId et tous les champs par API.',
  ].join('\n');
  const objective = options.objectiveTransform?.(canonicalObjective) ?? canonicalObjective;
  const objectiveAuthorizationSegments = [objective];
  const preflightInput = {
    messageId,
    expectedRecipientEmail: recipient,
    expectedSenderEmail: sender,
    body,
    isHtml: false,
  };
  const sessionId = `sensitive-action-${randomUUID()}`;
  const runtimeId = `runtime-${randomUUID()}`;
  usedSessionIds.push(sessionId);
  const permissionMode = options.permissionMode ?? 'allow-all';
  initializeModeState(sessionId, permissionMode);

  const run = (
    toolName: string,
    input: Record<string, unknown>,
    toolUseId = `call-${randomUUID()}`,
    activeSourceSlugs: string[] = ['google-contacts'],
    sourceActivationReentry = false,
    invocationRuntimeId?: string,
  ) => runPreToolUseChecks({
    toolName,
    input,
    sessionId,
    toolUseId,
    runtimeId: invocationRuntimeId,
    sourceActivationReentry,
    permissionMode,
    workspaceRootPath: '/tmp/robb-sensitive-action-test',
    workspaceId: 'sensitive-action-test',
    activeSourceSlugs,
    allSourceSlugs: ['google-contacts'],
    hasSourceActivation: false,
    externalActionPolicy: 'allow-in-execute',
    objectiveMutationAuthorized: true,
    objectiveSensitiveActionAuthorized: true,
    objectiveAuthorizationSegments,
    permissionManager: options.permissionManager ?? whitelistedPermissionManager,
    currentUserRequest: objective,
  });
  const runWithoutToolUseId = (
    toolName: string,
    input: Record<string, unknown>,
  ) => runPreToolUseChecks({
    toolName,
    input,
    sessionId,
    permissionMode,
    workspaceRootPath: '/tmp/robb-sensitive-action-test',
    workspaceId: 'sensitive-action-test',
    activeSourceSlugs: ['google-contacts'],
    allSourceSlugs: ['google-contacts'],
    hasSourceActivation: false,
    externalActionPolicy: 'allow-in-execute',
    objectiveMutationAuthorized: true,
    objectiveSensitiveActionAuthorized: true,
    objectiveAuthorizationSegments,
    permissionManager: options.permissionManager ?? whitelistedPermissionManager,
    currentUserRequest: objective,
  });
  const recordPreflight = (
    toolUseId: string,
    recipientBinding: string,
    receiptOverrides: Record<string, unknown> = {},
    resultToolInput: Record<string, unknown> = preflightInput,
  ) => recordContextualGmailToolResult({
    sessionId,
    toolUseId,
    toolName: 'mcp__google-contacts__gmail_reply_preflight',
    toolInput: resultToolInput,
    result: JSON.stringify({
      ok: true,
      willSend: false,
      messageId,
      threadId,
      operationKey,
      bodySha256: createHash('sha256').update(body).digest('hex'),
      isHtml: false,
      replyAll: false,
      expectedRecipientEmail: recipient,
      expectedSenderEmail: sender,
      primarySenderEmail: sender,
      subject,
      resolvedRecipients: { to: [recipient], cc: [] },
      recipientBinding,
      bindingExpiresInSeconds: 600,
      exactEffectReconciliation: {
        checked: true,
        conclusive: true,
        paginationComplete: true,
        source: 'gmail_threads_get_full',
        scopes: ['SENT', 'DRAFT'],
        threadId,
        operationKey,
        candidateCount: 0,
      },
      ...receiptOverrides,
    }),
    isError: false,
    executed: true,
    objectiveAuthorizationSegments,
  });
  const recordBoundResult = (
    toolUseId: string,
    executed: boolean,
    isError = !executed,
  ) => recordContextualGmailToolResult({
    sessionId,
    toolUseId,
    toolName: 'mcp__google-contacts__gmail_reply_bound',
    toolInput: preflightInput,
    result: isError ? JSON.stringify({ error: 'transport_failed' }) : JSON.stringify({ ok: true }),
    isError,
    executed,
    objectiveAuthorizationSegments,
  });
  const boundInput = (recipientBinding: string): Record<string, unknown> => ({
    ...preflightInput,
    recipientBinding,
  });

  return {
    body,
    boundInput,
    messageId,
    objectiveAuthorizationSegments,
    preflightInput,
    recordBoundResult,
    recordPreflight,
    run,
    runWithoutToolUseId,
    runtimeId,
    sessionId,
  };
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

  it('authorizes one autonomous exact Gmail restart from a single self-contained segment', () => {
    const messageId = '1a0a917ea946a540';
    const recipient = 'laurent@example.test';
    const sender = 'sender@example.test';
    const subject = 'RE: Compte-rendu de l’échange du 25/08 - Example Org';
    const body = [
      'Bonjour Ludovic,',
      '',
      'Nous n’avons à ce stade aucune question qui justifie un temps d’échange. La documentation est suffisamment claire et nous attendons l’ouverture de la clé API.',
      '',
      'Nous reviendrons vers vous dans un second temps si nous avons besoin d’aller plus loin, notamment sur les offres payantes.',
    ].join('\n');
    const objective = [
      'Marqueur de relance autonome : gmail-reply-exact-v1.',
      `Réponds maintenant dans le fil Gmail ${messageId}, cible exacte : ${recipient}, From: ${sender}, CC vide, sujet exact « ${subject} ».`,
      `Corps exact : «${body}»`,
      'Utilise uniquement l’API Gmail, jamais le navigateur. Un préflight signé frais est obligatoire avant toute réponse.',
      'Respecte le résultat du connecteur et clôture si le préflight signale un doublon ou une ambiguïté.',
      'Seulement si l’absence exacte est concluante, exécute au plus une unique réponse liée à cette ancre, puis vérifie le messageId et tous les champs par API.',
    ].join('\n');
    const objectiveSegments = [objective];
    const preflightInput = {
      messageId,
      expectedRecipientEmail: recipient,
      expectedSenderEmail: sender,
      body,
      isHtml: false,
    };

    expect(isContextualGmailReplyRequestedByObjective(objectiveSegments)).toBeTrue();
    expect(contextualGmailReplyPreflightAttestationFromObjective(
      'mcp__google-contacts__gmail_reply_preflight',
      preflightInput,
      objectiveSegments,
    )).toMatchObject({
      scope: 'reply',
      messageId,
      expectedRecipientEmail: recipient,
      expectedSenderEmail: sender,
      expectedCc: '',
      expectedSubject: subject,
      body,
      isHtml: false,
      requiresExactEffectReconciliation: true,
    });
    expect(contextualGmailClosedExactEffectExpectationFromObjective(objectiveSegments)).toEqual({
      scope: 'reply',
      anchorMessageId: messageId,
      expectedRecipientEmail: recipient,
      expectedSenderEmail: sender,
      expectedCc: '',
      expectedSubject: subject,
      expectedBody: body,
      expectedIsHtml: false,
    });

    const sessionId = `sensitive-action-${randomUUID()}`;
    usedSessionIds.push(sessionId);
    initializeModeState(sessionId, 'allow-all');
    const run = (
      toolName: string,
      input: Record<string, unknown>,
      toolUseId = `call-${randomUUID()}`,
    ) => runPreToolUseChecks({
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
      objectiveAuthorizationSegments: objectiveSegments,
      permissionManager: whitelistedPermissionManager,
      currentUserRequest: objective,
    });
    const threadId = '1a0a917ea946a541';
    const operationKey = 'f'.repeat(64);
    const recipientBinding = gmailRecipientBinding('e');

    expect(run('mcp__google-contacts__gmail_reply_bound', {
      ...preflightInput,
      recipientBinding,
    })).toMatchObject({ type: 'block' });
    expect(run(
      'mcp__google-contacts__gmail_reply_preflight',
      preflightInput,
      'restart-preflight',
    ).type).toBe('allow');
    recordContextualGmailToolResult({
      sessionId,
      toolUseId: 'restart-preflight',
      toolName: 'mcp__google-contacts__gmail_reply_preflight',
      toolInput: preflightInput,
      result: JSON.stringify({
        ok: true,
        willSend: false,
        messageId,
        threadId,
        operationKey,
        bodySha256: createHash('sha256').update(body).digest('hex'),
        isHtml: false,
        replyAll: false,
        expectedRecipientEmail: recipient,
        expectedSenderEmail: sender,
        primarySenderEmail: sender,
        subject,
        resolvedRecipients: { to: [recipient], cc: [] },
        recipientBinding,
        bindingExpiresInSeconds: 600,
        exactEffectReconciliation: {
          checked: true,
          conclusive: true,
          paginationComplete: true,
          source: 'gmail_threads_get_full',
          scopes: ['SENT', 'DRAFT'],
          threadId,
          operationKey,
          candidateCount: 0,
        },
      }),
      isError: false,
      executed: true,
      objectiveAuthorizationSegments: objectiveSegments,
    });

    expect(run('mcp__google-contacts__gmail_reply_bound', {
      ...preflightInput,
      body: `${body}\nAjout non autorisé.`,
      recipientBinding,
    })).toMatchObject({ type: 'block' });
    expect(run('mcp__google-contacts__gmail_reply_bound', {
      ...preflightInput,
      expectedRecipientEmail: 'other@example.com',
      recipientBinding,
    })).toMatchObject({ type: 'block' });
    expect(run('mcp__google-contacts__gmail_reply_bound', {
      ...preflightInput,
      recipientBinding,
    }).type).toBe('allow');
    expect(run('mcp__google-contacts__gmail_reply_bound', {
      ...preflightInput,
      recipientBinding,
    })).toMatchObject({ type: 'block' });
  });

  it('authorizes the live immutable BODY_BEGIN restart while keeping duplicate guards conditional', () => {
    const body = 'Merci Alice, le contrat est validé.';
    const structuredObjective = [
      '[robb-resume:sensitive-action:804c81665de46593b0e26449756041ff7af3ab15:v4]',
      'Le SHA du marqueur identifie uniquement le runtime Robb Agents installé. Il ne constitue ni une révision distante, ni un artefact métier, ni une autorisation supplémentaire.',
      '',
      'Termine maintenant la mission initiale en répondant dans le fil Gmail d’ancre exacte 1a0a917ea946a540. Utilise exclusivement l’API Gmail canonique, jamais le navigateur.',
      '',
      'Payload obligatoire et immuable :',
      '- From : sender@example.test',
      '- To : alice@example.com',
      '- CC : []',
      '- BCC : []',
      '- Sujet : RE: Validation du contrat',
      '- Texte brut uniquement (`isHtml=false`)',
      '- Pièces jointes : []',
      '- Signature : aucune, ni automatique ni manuelle',
      '- Corps exact, sans les délimiteurs BODY_BEGIN/BODY_END et sans ajout :',
      '',
      'BODY_BEGIN',
      body,
      'BODY_END',
      '',
      'Ce corps fait exactement 35 caractères et son SHA-256 UTF-8 est 2e7ecdde6b499a6ef8e76cf54a7963055693140e7f4c7df4e4aadc17b7422751.',
      '',
      'Avant toute mutation, exécute un nouveau `gmail_reply_preflight` complet sur cette ancre et ce payload exact. N’utilise aucun ancien binding. Continue uniquement si l’ancre, From, To, CC, BCC, sujet, corps, absence de pièce jointe et absence de signature correspondent exactement, si la réconciliation SENT et DRAFT est concluante et entièrement paginée, et si `candidateCount=0`. Si un candidat, une ambiguïté ou une preuve incomplète apparaît, n’envoie rien et clôture factuellement.',
      '',
      'Seulement si toutes ces conditions sont satisfaites, utilise immédiatement le `recipientBinding` frais dans au plus un unique `gmail_reply_bound` au payload strictement identique. Après l’appel, vérifie par API le messageId, le fil, From, To, CC, BCC, sujet, corps, pièces jointes et absence de signature. Ne répète jamais l’effet si le résultat de l’appel est incertain : réconcilie SENT et DRAFT avant toute décision. Ne redemande aucun élément déjà établi et poursuis jusqu’à une fin réellement vérifiée.',
    ].join('\n');
    const scenario = createClosedExactGmailPreflightScenario({
      objectiveTransform: () => structuredObjective,
    });
    const repeatedObjective = structuredObjective.replace(
      '804c81665de46593b0e26449756041ff7af3ab15:v4',
      '9e9060e3dd6b8af1027e909903a2acaf56b34f71:v3',
    );

    expect(isContextualGmailReplyRequestedByObjective([structuredObjective])).toBeTrue();
    expect(isContextualGmailReplyRequestedByObjective([
      repeatedObjective,
      structuredObjective,
    ])).toBeTrue();
    expect(contextualGmailReplyPreflightAttestationFromObjective(
      'mcp__google-contacts__gmail_reply_preflight',
      scenario.preflightInput,
      [repeatedObjective, structuredObjective],
    )).toMatchObject({
      messageId: scenario.messageId,
      expectedRecipientEmail: 'alice@example.com',
      expectedSenderEmail: 'sender@example.test',
      expectedCc: '',
      expectedSubject: 'RE: Validation du contrat',
      body,
      isHtml: false,
      requiresExactEffectReconciliation: true,
    });
    expect(contextualGmailClosedExactEffectExpectationFromObjective([
      repeatedObjective,
      structuredObjective,
    ])).toMatchObject({
      anchorMessageId: scenario.messageId,
      expectedRecipientEmail: 'alice@example.com',
      expectedSenderEmail: 'sender@example.test',
      expectedCc: '',
      expectedSubject: 'RE: Validation du contrat',
      expectedBody: body,
      expectedIsHtml: false,
    });

    for (const subject of [
      'RE: Signature du contrat et pièces jointes',
      'RE: Format HTML — ne pas envoyer',
    ]) {
      const subjectBearingControlWords = structuredObjective.replace(
        'RE: Validation du contrat',
        subject,
      );
      expect(isContextualGmailReplyRequestedByObjective([
        subjectBearingControlWords,
      ])).toBeTrue();
      expect(contextualGmailClosedExactEffectExpectationFromObjective([
        subjectBearingControlWords,
      ])).toMatchObject({ expectedSubject: subject });
    }

    const recipientBinding = gmailRecipientBinding('c');
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight',
      scenario.preflightInput,
      'structured-restart-preflight',
    ).type).toBe('allow');
    scenario.recordPreflight('structured-restart-preflight', recipientBinding);
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound',
      scenario.boundInput(recipientBinding),
      'structured-restart-bound',
    ).type).toBe('allow');

    for (const widened of [
      structuredObjective.replace('- BCC : []', '- BCC : mallory@example.com'),
      structuredObjective.replace('- CC : []', '- CC : []\n- CC : mallory@example.com'),
      structuredObjective.replace('- Pièces jointes : []', '- Pièces jointes : [contrat.pdf]'),
      structuredObjective.replace('- Pièces jointes : []', '- Pièces jointes : [] puis contrat.pdf'),
      structuredObjective.replace('- Signature : aucune, ni automatique ni manuelle', '- Signature : automatique'),
      structuredObjective.replace('- Signature : aucune, ni automatique ni manuelle', '- Signature : aucune, puis automatique'),
      structuredObjective.replace('`isHtml=false`', '`isHtml=true`'),
      structuredObjective.replace('`isHtml=false`', '`isHtml=false` puis `isHtml=true`'),
    ]) {
      expect(isContextualGmailReplyRequestedByObjective([widened])).toBeFalse();
    }

    expect(isContextualGmailReplyRequestedByObjective([
      `${structuredObjective}\nN’envoie rien quoi qu’il arrive.`,
    ])).toBeFalse();
  });
});
