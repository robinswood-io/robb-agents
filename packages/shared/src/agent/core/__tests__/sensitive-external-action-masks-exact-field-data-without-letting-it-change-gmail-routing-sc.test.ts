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

  it('masks exact-field data without letting it change Gmail routing scope', () => {
    const messageId = '1a0a917ea946a540';
    const root = `Réponds à alice@example.com au message ${messageId}.`;
    for (const [amendment, expected] of [
      ['Utilise exactement ce corps : «Pouvez-vous confirmer ?»', {
        expectedBody: 'Pouvez-vous confirmer ?',
      }],
      ['Corps exact : «Merci.\nStop.\nÀ bientôt.»', {
        expectedBody: 'Merci.\nStop.\nÀ bientôt.',
      }],
      ['Sujet exact : «Pouvez-vous confirmer ?»', {
        expectedSubject: 'Pouvez-vous confirmer ?',
      }],
    ] as const) {
      const objective = [root, amendment];
      expect(isContextualGmailReplyRequestedByObjective(objective)).toBeTrue();
      expect(contextualGmailExactEffectExpectationFromObjective(objective))
        .toMatchObject({ scope: 'reply', ...expected });
    }

    for (const [bodyLabel, body] of [
      ['Exact body', 'Thanks.'],
      ['Body exact', 'Reply all'],
    ]) {
      const objective = [[
        `Reply to this email, message ${messageId}.`,
        'Subject exact: Reply all',
        `${bodyLabel}: «${body}»`,
      ].join('\n')];
      expect(contextualGmailExactEffectExpectationFromObjective(objective)).toMatchObject({
        scope: 'reply',
        expectedSubject: 'Reply all',
        expectedBody: body,
      });
      expect(contextualGmailReplyPreflightAttestationFromObjective(
        'mcp__google-contacts__gmail_reply_all_preflight',
        { messageId, body, isHtml: false },
        objective,
      )).toBeUndefined();
      expect(contextualGmailReplyPreflightAttestationFromObjective(
        'mcp__google-contacts__gmail_reply_preflight',
        { messageId, expectedRecipientEmail: 'alice@example.com', body, isHtml: false },
        objective,
      )?.scope).toBe('reply');
    }
  });

  it('requires an explicit structural Gmail anchor instead of hex in another field', () => {
    const body = 'Merci, nous revenons vers vous.';
    const withoutAnchor = [[
      'Réponds maintenant dans ce fil Gmail, cible exacte : deadbeefcafe@example.com, From: sender@example.test, CC vide, sujet exact « deadbeefcafe ».',
      `Corps exact : «${body}»`,
      'Seulement si l’absence exacte est concluante, exécute au plus une unique réponse liée à cette ancre.',
    ].join('\n')];
    expect(isContextualGmailReplyRequestedByObjective(withoutAnchor)).toBeFalse();
    expect(contextualGmailClosedExactEffectExpectationFromObjective(withoutAnchor))
      .toBeUndefined();

    const withAnchor = [withoutAnchor[0]!.replace(
      'dans ce fil Gmail,',
      'dans le fil Gmail 1a0a917ea946a540,',
    )];
    expect(contextualGmailClosedExactEffectExpectationFromObjective(withAnchor))
      .toMatchObject({ anchorMessageId: '1a0a917ea946a540' });
  });

  it('treats exact Gmail subject text as data and exact bodies as plain text', () => {
    const scenario = createClosedExactGmailPreflightScenario();
    const subjectWithControlWords = scenario.objectiveAuthorizationSegments[0]!.replace(
      'RE: Validation du contrat',
      'Reply all — Do not send — Attends mon accord',
    );
    expect(isContextualGmailReplyRequestedByObjective([subjectWithControlWords])).toBeTrue();
    expect(contextualGmailClosedExactEffectExpectationFromObjective([subjectWithControlWords]))
      .toMatchObject({ expectedSubject: 'Reply all — Do not send — Attends mon accord' });
    expect(isContextualGmailReplyRequestedByObjective([
      `${subjectWithControlWords}\nAttends mon accord avant tout envoi.`,
    ])).toBeFalse();

    const binding = gmailRecipientBinding('b');
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight', scenario.preflightInput, 'plain-preflight',
    ).type).toBe('allow');
    scenario.recordPreflight('plain-preflight', binding);
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound',
      { ...scenario.boundInput(binding), isHtml: true },
      'html-bound',
    )).toMatchObject({ type: 'block' });
  });

  it('extracts every exact field from the real duplicate-safe Gmail wording', () => {
    const body = [
      'Bonjour Ludovic,',
      '',
      'Nous n’avons à ce stade aucune question qui justifie un temps d’échange. La documentation est suffisamment claire et nous attendons l’ouverture de la clé API.',
      '',
      'Nous reviendrons vers vous dans un second temps si nous avons besoin d’aller plus loin, notamment sur les offres payantes.',
    ].join('\n');
    const objective = [
      'Envoie maintenant exactement une réponse Gmail dans le fil `1a0a917ea946a540` à `laurent@example.test`, depuis `sender@example.test`, avec CC vide, sujet `RE: Compte-rendu de l’échange du 25/08 - Example Org`, sans signature ajoutée, et avec exactement ce corps :',
      '', body, '',
      'Cet envoi exact est déjà autorisé par l’objectif en cours. Utilise uniquement l’API Gmail canonique : vérifie d’abord qu’aucun effet strictement identique n’existe, puis crée un préflight signé frais et appelle une seule fois gmail_reply_bound avec les mêmes fil, destinataire, CC, sujet, corps et expectedSenderEmail=sender@example.test. L’ancien message 1a0a917ea946a540 est seulement l’ancre du fil ; son corps et ses CC diffèrent. Après l’appel, vérifie le nouveau message. Aucun navigateur, aucun second envoi si l’effet exact apparaît entre les deux contrôles.',
    ].join('\n');
    expect(isContextualGmailReplyRequestedByObjective([objective])).toBeTrue();
    expect(contextualGmailExactEffectExpectationFromObjective([objective])).toEqual({
      scope: 'reply',
      anchorMessageId: '1a0a917ea946a540',
      expectedRecipientEmail: 'laurent@example.test',
      expectedSenderEmail: 'sender@example.test',
      expectedCc: '',
      expectedSubject: 'RE: Compte-rendu de l’échange du 25/08 - Example Org',
      expectedBody: body,
      expectedIsHtml: false,
    });
  });

  it('keeps recipient-bound Gmail replies closed to the signed preflight payload', () => {
    const messageId = '1a0aaa36e2769235';
    const objectiveAuthorizationSegments = [`Réponds-lui au message ${messageId}.`, 'Poursuis.'];
    const options = {
      externalActionPolicy: 'allow-in-execute' as const,
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments,
    };
    const binding = `v1.1789601856.${'b'.repeat(64)}`;
    const valid = {
      messageId,
      expectedRecipientEmail: 'laurent@example.test',
      recipientBinding: binding,
      body: 'Message',
      isHtml: false,
    };
    expect(checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_reply_bound', valid, 'Poursuis.', options,
    ).type).toBe('allow');

    const explicitRecipientOptions = {
      ...options,
      objectiveAuthorizationSegments: [
        `Réponds à alice@example.com au message ${messageId}.`,
        'Poursuis.',
      ],
    };
    expect(checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_reply_bound', {
        ...valid,
        expectedRecipientEmail: 'alice@example.com',
      }, 'Poursuis.', explicitRecipientOptions,
    ).type).toBe('allow');
    expect(checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_reply_bound', {
        ...valid,
        expectedRecipientEmail: 'bob@example.com',
      }, 'Poursuis.', explicitRecipientOptions,
    )).toMatchObject({
      type: 'block',
      reason: expect.stringContaining('does not match the exact recipient'),
    });

    for (const input of [
      { ...valid, expectedRecipientEmail: 'Laurent@example.test' },
      { ...valid, expectedRecipientEmail: 'not-an-email' },
      { ...valid, expectedRecipientEmail: '' },
      { ...valid, recipientBinding: 'forged' },
      { ...valid, recipientBinding: undefined },
      { ...valid, to: 'other@example.com' },
      { ...valid, cc: 'other@example.com' },
      { ...valid, messageId: 'another-message' },
    ]) {
      expect(checkMcp(
        'allow-all', 'mcp__google-contacts__gmail_reply_bound', input, 'Poursuis.', options,
      )).toMatchObject({ type: 'block' });
    }
  });
});
