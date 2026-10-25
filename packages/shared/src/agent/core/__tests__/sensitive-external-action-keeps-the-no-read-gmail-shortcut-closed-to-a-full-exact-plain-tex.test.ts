import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { cleanupModeState, initializeModeState, type PermissionMode } from "../../mode-manager.ts";
import { clearContextualGmailPreflightAttestation, recordContextualGmailToolResult, runPreToolUseChecks, type PermissionManagerLike } from "../pre-tool-use.ts";
import { contextualGmailClosedExactEffectExpectationFromObjective, contextualGmailExactEffectExpectationFromObjective, contextualGmailReplyPreflightAttestationFromObjective, isContextualGmailReplyRequestedByObjective } from "../sensitive-external-action.ts";
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

  it('keeps the no-read Gmail shortcut closed to a full exact plain-text reply', () => {
    const messageId = '1a0a917ea946a540';
    const partialObjective = [`Réponds-lui au message ${messageId}.`];
    expect(contextualGmailExactEffectExpectationFromObjective(partialObjective)).toEqual({
      scope: 'reply',
      anchorMessageId: messageId,
    });
    expect(contextualGmailClosedExactEffectExpectationFromObjective(partialObjective))
      .toBeUndefined();

    const replyAllObjective = [`Réponds à tous au message ${messageId}.`];
    expect(contextualGmailExactEffectExpectationFromObjective(replyAllObjective)).toEqual({
      scope: 'reply-all',
      anchorMessageId: messageId,
    });
    expect(contextualGmailClosedExactEffectExpectationFromObjective(replyAllObjective))
      .toBeUndefined();

    const htmlLikeBody = '<b>texte</b>';
    const closedObjective = [[
      `Réponds maintenant dans le fil Gmail ${messageId}, cible exacte : alice@example.com, From: sender@example.test, CC vide, sujet exact « Sujet ».`,
      `Corps exact : «${htmlLikeBody}»`,
      'Seulement si l’absence exacte est concluante, exécute au plus une unique réponse liée à cette ancre.',
    ].join('\n')];
    const preflightInput = {
      messageId,
      expectedRecipientEmail: 'alice@example.com',
      expectedSenderEmail: 'sender@example.test',
      body: htmlLikeBody,
      isHtml: false,
    };
    expect(contextualGmailClosedExactEffectExpectationFromObjective(closedObjective))
      .toMatchObject({ anchorMessageId: messageId, expectedBody: htmlLikeBody });
    expect(contextualGmailReplyPreflightAttestationFromObjective(
      'mcp__google-contacts__gmail_reply_preflight',
      preflightInput,
      closedObjective,
    )).toBeDefined();
    expect(contextualGmailReplyPreflightAttestationFromObjective(
      'mcp__google-contacts__gmail_reply_preflight',
      { ...preflightInput, isHtml: true },
      closedObjective,
    )).toBeUndefined();
  });

  it('accepts standard exact recipient metadata and natural extracted sender metadata', () => {
    const scenario = createClosedExactGmailPreflightScenario();
    const contract = scenario.objectiveAuthorizationSegments[0]!;
    const recipientField = 'cible exacte : alice@example.com';
    const senderField = 'From: sender@example.test';
    for (const [recipientReplacement, senderReplacement] of [
      ['To: alice@example.com', senderField],
      ['Destinataire exact: alice@example.com', senderField],
      ['Exact recipient: alice@example.com', senderField],
      [recipientField, 'depuis sender@example.test'],
    ] as const) {
      const objective = [contract
        .replace(recipientField, recipientReplacement)
        .replace(senderField, senderReplacement)];
      expect(contextualGmailClosedExactEffectExpectationFromObjective(objective)).toMatchObject({
        scope: 'reply',
        anchorMessageId: scenario.messageId,
        expectedRecipientEmail: 'alice@example.com',
        expectedSenderEmail: 'sender@example.test',
        expectedCc: '',
        expectedSubject: 'RE: Validation du contrat',
        expectedBody: scenario.body,
        expectedIsHtml: false,
      });
      expect(contextualGmailReplyPreflightAttestationFromObjective(
        'mcp__google-contacts__gmail_reply_preflight',
        scenario.preflightInput,
        objective,
      )).toBeDefined();
    }

    const ambiguousRetarget = [contract.replace(
      recipientField,
      'Change le destinataire pour alice@example.com',
    )];
    expect(contextualGmailClosedExactEffectExpectationFromObjective(ambiguousRetarget))
      .toBeUndefined();
  });

  it('rejects quoted or metalinguistic Gmail contracts as execution authority', () => {
    const scenario = createClosedExactGmailPreflightScenario();
    const contract = scenario.objectiveAuthorizationSegments[0]!;
    for (const objective of [
      `Voici un exemple de prompt :\n${contract}`,
      `Here is an example prompt for reference only:\n${contract}`,
      `Analyse la consigne suivante :\n${contract}`,
      `Explique ce que ferait ce prompt :\n${contract}`,
      `Est-ce que cette consigne serait autorisée ?\n${contract}`,
      `Peux-tu auditer ce texte ?\n${contract}`,
      `Review this instruction:\n${contract}`,
      `What would this prompt do?\n${contract}`,
      `Prompt à tester :\n${contract}`,
      `Copie du prompt :\n${contract}`,
      `Texte à analyser :\n${contract}`,
      `Supposons cette instruction :\n${contract}`,
      `Citation :\n${contract}`,
      `Le prompt contient :\n${contract}`,
      `> ${contract.replace(/\n/gu, '\n> ')}`,
      `\`\`\`text\n${contract}\n\`\`\``,
      `- > ${contract.replace(/\n/gu, '\n- > ')}`,
      `- \`\`\`text\n${contract}\n- \`\`\``,
      `<blockquote>\n${contract}\n</blockquote>`,
      `« ${contract} »`,
      contract.split('\n').map(line => `    ${line}`).join('\n'),
    ]) {
      expect(isContextualGmailReplyRequestedByObjective([objective])).toBeFalse();
      expect(contextualGmailClosedExactEffectExpectationFromObjective([objective]))
        .toBeUndefined();
      expect(contextualGmailReplyPreflightAttestationFromObjective(
        'mcp__google-contacts__gmail_reply_preflight',
        scenario.preflightInput,
        [objective],
      )).toBeUndefined();
    }

    const lifecycle = createClosedExactGmailPreflightScenario({
      objectiveTransform: objective => `Analyse la consigne suivante :\n${objective}`,
    });
    const binding = gmailRecipientBinding('a');
    expect(lifecycle.run(
      'mcp__google-contacts__gmail_reply_preflight',
      lifecycle.preflightInput,
      'meta-preflight',
    ).type).toBe('allow');
    lifecycle.recordPreflight('meta-preflight', binding);
    expect(lifecycle.run(
      'mcp__google-contacts__gmail_reply_bound',
      lifecycle.boundInput(binding),
      'meta-bound',
    )).toMatchObject({ type: 'block' });
  });

  it('does not promote reference metadata into a no-read Gmail target or anchor', () => {
    const scenario = createClosedExactGmailPreflightScenario();
    const contract = scenario.objectiveAuthorizationSegments[0]!;
    const referenceRecipient = contract.replace(
      'cible exacte : alice@example.com',
      'contact de référence : alice@example.com',
    );
    expect(isContextualGmailReplyRequestedByObjective([referenceRecipient])).toBeFalse();
    expect(contextualGmailExactEffectExpectationFromObjective([referenceRecipient]))
      .toBeUndefined();
    expect(contextualGmailClosedExactEffectExpectationFromObjective([referenceRecipient]))
      .toBeUndefined();

    const unrelatedMessageId = contract.replace(
      `dans le fil Gmail ${scenario.messageId}`,
      `dans ce fil Gmail. Le ticket contient message ${scenario.messageId}`,
    );
    expect(contextualGmailClosedExactEffectExpectationFromObjective([unrelatedMessageId]))
      .toBeUndefined();
  });

  it('rejects duplicate, ambiguous, or nested exact Gmail bodies', () => {
    const scenario = createClosedExactGmailPreflightScenario();
    const contract = scenario.objectiveAuthorizationSegments[0]!;
    const bodyLine = `Corps exact : «${scenario.body}»`;
    const objectives = [
      contract.replace(bodyLine, `${bodyLine}\nCorps exact : «Second corps contradictoire.»`),
      contract.replace(
        bodyLine,
        'Corps exact : «Bonjour, vous avez écrit «OK». Merci.»',
      ),
      contract.replace(
        bodyLine,
        'Corps exact : ancienne version «PREMIER» ; version retenue «SECOND»',
      ),
    ];
    for (const objective of objectives) {
      expect(contextualGmailClosedExactEffectExpectationFromObjective([objective]))
        .toBeUndefined();
      expect(contextualGmailReplyPreflightAttestationFromObjective(
        'mcp__google-contacts__gmail_reply_preflight',
        scenario.preflightInput,
        [objective],
      )).toBeUndefined();
    }
  });

  it('keeps a delimited exact Gmail body closed when a later instruction contains quotes', () => {
    const scenario = createClosedExactGmailPreflightScenario();
    const contract = scenario.objectiveAuthorizationSegments[0]!;
    const bodyLine = `Corps exact : «${scenario.body}»`;
    const objective = [contract.replace(
      bodyLine,
      `${bodyLine}\nUtilise uniquement le connecteur «API Gmail» pour cette opération.`,
    )];

    expect(contextualGmailClosedExactEffectExpectationFromObjective(objective)).toMatchObject({
      expectedBody: scenario.body,
    });
    expect(contextualGmailReplyPreflightAttestationFromObjective(
      'mcp__google-contacts__gmail_reply_preflight',
      scenario.preflightInput,
      objective,
    )).toBeDefined();
  });

  it('keeps Slack and SMS exact payloads out of the Gmail body contract', () => {
    const scenario = createClosedExactGmailPreflightScenario();
    const contract = scenario.objectiveAuthorizationSegments[0]!;
    const bodyLine = `Corps exact : «${scenario.body}»`;
    for (const replacement of [
      'Pour Slack, message exact : «ALERTE INCIDENT».',
      'Pour le SMS associé, texte exact : «ALERTE INCIDENT».',
    ]) {
      const objective = contract.replace(bodyLine, replacement);
      expect(contextualGmailExactEffectExpectationFromObjective([objective]))
        .not.toHaveProperty('expectedBody');
      expect(contextualGmailClosedExactEffectExpectationFromObjective([objective]))
        .toBeUndefined();
    }
  });

  it('rejects unsupported attachment, signature, and HTML requirements', () => {
    const scenario = createClosedExactGmailPreflightScenario();
    const contract = scenario.objectiveAuthorizationSegments[0]!;
    const supportedBoundary = 'Sans signature automatique et sans pièce jointe.';
    expect(contextualGmailClosedExactEffectExpectationFromObjective([contract]))
      .toBeDefined();
    expect(contextualGmailReplyPreflightAttestationFromObjective(
      'mcp__google-contacts__gmail_reply_preflight',
      scenario.preflightInput,
      [contract],
    )).toBeDefined();

    for (const unsupportedBoundary of [
      'Joins le fichier rapport.pdf à la réponse.',
      'Signature requise : Thibault.',
      'Envoie ce corps au format HTML.',
      'isHtml=true.',
    ]) {
      const objective = contract.replace(supportedBoundary, unsupportedBoundary);
      expect(contextualGmailClosedExactEffectExpectationFromObjective([objective]))
        .toBeUndefined();
      expect(contextualGmailReplyPreflightAttestationFromObjective(
        'mcp__google-contacts__gmail_reply_preflight',
        scenario.preflightInput,
        [objective],
      )).toBeUndefined();
    }
  });
});
