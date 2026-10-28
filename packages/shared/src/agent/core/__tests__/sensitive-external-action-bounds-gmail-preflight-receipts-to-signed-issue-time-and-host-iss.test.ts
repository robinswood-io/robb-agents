import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { cleanupModeState, initializeModeState, type PermissionMode } from "../../mode-manager.ts";
import { clearContextualGmailPreflightAttestation, recordContextualGmailToolResult, runPreToolUseChecks, type PermissionManagerLike } from "../pre-tool-use.ts";
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
    ...(invocationRuntimeId !== undefined ? { runtimeId: invocationRuntimeId } : {}),
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

  it('bounds Gmail preflight receipts to signed issue time and host-issued tool ids', () => {
    const baseTime = new Date('2026-09-17T12:00:00.000Z');
    setSystemTime(baseTime);
    const nowSeconds = Math.floor(baseTime.getTime() / 1000);

    const noToolUseId = createClosedExactGmailPreflightScenario();
    const missingIdResult = noToolUseId.runWithoutToolUseId(
      'mcp__google-contacts__gmail_reply_bound',
      noToolUseId.boundInput(gmailRecipientBinding('7', nowSeconds)),
    );
    expect(missingIdResult).toMatchObject({ type: 'block' });
    if (missingIdResult.type === 'block') {
      expect(missingIdResult.reason).toContain('host-issued toolUseId');
    }

    const preflightWithoutId = createClosedExactGmailPreflightScenario();
    const preservedBinding = gmailRecipientBinding('7', nowSeconds);
    expect(preflightWithoutId.run(
      'mcp__google-contacts__gmail_reply_preflight',
      preflightWithoutId.preflightInput,
      'preserved-preflight',
    ).type).toBe('allow');
    preflightWithoutId.recordPreflight('preserved-preflight', preservedBinding);
    const missingPreflightIdResult = preflightWithoutId.runWithoutToolUseId(
      'mcp__google-contacts__gmail_reply_preflight',
      preflightWithoutId.preflightInput,
    );
    expect(missingPreflightIdResult).toMatchObject({ type: 'block' });
    if (missingPreflightIdResult.type === 'block') {
      expect(missingPreflightIdResult.reason).toContain('host-issued toolUseId');
    }
    expect(preflightWithoutId.run(
      'mcp__google-contacts__gmail_reply_bound',
      preflightWithoutId.boundInput(preservedBinding),
      'send-after-idless-preflight',
    ).type).toBe('allow');

    const expired = createClosedExactGmailPreflightScenario();
    const expiredBinding = gmailRecipientBinding('8', nowSeconds - 600);
    expect(expired.run(
      'mcp__google-contacts__gmail_reply_preflight', expired.preflightInput, 'expired-preflight',
    ).type).toBe('allow');
    expired.recordPreflight('expired-preflight', expiredBinding);
    expect(expired.run(
      'mcp__google-contacts__gmail_reply_bound', expired.boundInput(expiredBinding),
    )).toMatchObject({ type: 'block' });

    const future = createClosedExactGmailPreflightScenario();
    const futureBinding = gmailRecipientBinding('9', nowSeconds + 31);
    expect(future.run(
      'mcp__google-contacts__gmail_reply_preflight', future.preflightInput, 'future-preflight',
    ).type).toBe('allow');
    future.recordPreflight('future-preflight', futureBinding);
    expect(future.run(
      'mcp__google-contacts__gmail_reply_bound', future.boundInput(futureBinding),
    )).toMatchObject({ type: 'block' });

    const skewBoundary = createClosedExactGmailPreflightScenario();
    const skewBoundaryBinding = gmailRecipientBinding('a', nowSeconds + 30);
    expect(skewBoundary.run(
      'mcp__google-contacts__gmail_reply_preflight',
      skewBoundary.preflightInput,
      'skew-boundary-preflight',
    ).type).toBe('allow');
    skewBoundary.recordPreflight('skew-boundary-preflight', skewBoundaryBinding);
    expect(skewBoundary.run(
      'mcp__google-contacts__gmail_reply_bound', skewBoundary.boundInput(skewBoundaryBinding),
    ).type).toBe('allow');

    const signedAge = createClosedExactGmailPreflightScenario();
    const signedAgeBinding = gmailRecipientBinding('b', nowSeconds - 599);
    expect(signedAge.run(
      'mcp__google-contacts__gmail_reply_preflight',
      signedAge.preflightInput,
      'signed-age-preflight',
    ).type).toBe('allow');
    signedAge.recordPreflight('signed-age-preflight', signedAgeBinding, {
      bindingExpiresInSeconds: 3_600,
    });
    setSystemTime(new Date(baseTime.getTime() + 2_000));
    expect(signedAge.run(
      'mcp__google-contacts__gmail_reply_bound', signedAge.boundInput(signedAgeBinding),
    )).toMatchObject({ type: 'block' });

    setSystemTime(baseTime);
    const reportedTtl = createClosedExactGmailPreflightScenario();
    const reportedTtlBinding = gmailRecipientBinding('c', nowSeconds);
    expect(reportedTtl.run(
      'mcp__google-contacts__gmail_reply_preflight',
      reportedTtl.preflightInput,
      'reported-ttl-preflight',
    ).type).toBe('allow');
    reportedTtl.recordPreflight('reported-ttl-preflight', reportedTtlBinding, {
      bindingExpiresInSeconds: 1,
    });
    setSystemTime(new Date(baseTime.getTime() + 2_000));
    expect(reportedTtl.run(
      'mcp__google-contacts__gmail_reply_bound', reportedTtl.boundInput(reportedTtlBinding),
    )).toMatchObject({ type: 'block' });
  });

  it('rejects a preflight result whose tool input no longer matches the pending intent', () => {
    const scenario = createClosedExactGmailPreflightScenario();
    const binding = gmailRecipientBinding('d');
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight',
      scenario.preflightInput,
      'mismatched-input-preflight',
    ).type).toBe('allow');
    scenario.recordPreflight('mismatched-input-preflight', binding, {}, {
      ...scenario.preflightInput,
      body: `${scenario.body}\nTexte injecté après le départ.`,
    });
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound', scenario.boundInput(binding),
    )).toMatchObject({ type: 'block' });
  });

  it('poisons a reused preflight tool id even when both pending intents are identical', () => {
    const identical = createClosedExactGmailPreflightScenario();
    const olderBinding = gmailRecipientBinding('0');
    const newerBinding = gmailRecipientBinding('1');
    expect(identical.run(
      'mcp__google-contacts__gmail_reply_preflight',
      identical.preflightInput,
      'identical-reused-id',
    ).type).toBe('allow');
    expect(identical.run(
      'mcp__google-contacts__gmail_reply_preflight',
      identical.preflightInput,
      'identical-reused-id',
    )).toMatchObject({ type: 'block' });
    identical.recordPreflight('identical-reused-id', olderBinding);
    identical.recordPreflight('identical-reused-id', newerBinding, {
      ok: false,
      error: 'preflight_failed',
    });
    expect(identical.run(
      'mcp__google-contacts__gmail_reply_bound', identical.boundInput(olderBinding),
    )).toMatchObject({ type: 'block' });

    expect(identical.run(
      'mcp__google-contacts__gmail_reply_preflight',
      identical.preflightInput,
      'identical-fresh-id',
    ).type).toBe('allow');
    identical.recordPreflight('identical-fresh-id', newerBinding);
    expect(identical.run(
      'mcp__google-contacts__gmail_reply_bound', identical.boundInput(newerBinding),
    ).type).toBe('allow');
  });

  it('fails closed when a reused preflight tool id collides across two pending intents', () => {
    const messageId = '1a0aaa36e2769235';
    const objectiveAuthorizationSegments = ['Answer this email in the existing thread.'];
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
      objectiveAuthorizationSegments,
      permissionManager: whitelistedPermissionManager,
      currentUserRequest: objectiveAuthorizationSegments[0],
    });
    recordContextualGmailToolResult({
      sessionId,
      toolUseId: 'collision-read',
      toolName: 'mcp__google-contacts__gmail_get_message',
      toolInput: { messageId },
      result: JSON.stringify({ id: messageId, threadId: '1a0aaa36e2769236' }),
      isError: false,
      executed: true,
      objectiveAuthorizationSegments,
    });
    const firstInput = {
      messageId,
      expectedRecipientEmail: 'alice@example.com',
      body: 'Premier corps.',
      isHtml: false,
    };
    const latestInput = {
      messageId,
      expectedRecipientEmail: 'bob@example.com',
      body: 'Deuxième corps.',
      isHtml: false,
    };
    expect(run(
      'mcp__google-contacts__gmail_reply_preflight', firstInput, 'reused-preflight-id',
    ).type).toBe('allow');
    expect(run(
      'mcp__google-contacts__gmail_reply_preflight', latestInput, 'reused-preflight-id',
    )).toMatchObject({ type: 'block' });
    const record = (
      toolUseId: string,
      toolInput: Record<string, unknown>,
      recipientBinding: string,
      recipient: string,
      body: string,
    ) => recordContextualGmailToolResult({
      sessionId,
      toolUseId,
      toolName: 'mcp__google-contacts__gmail_reply_preflight',
      toolInput,
      result: JSON.stringify({
        ok: true,
        willSend: false,
        messageId,
        bodySha256: createHash('sha256').update(body).digest('hex'),
        isHtml: false,
        replyAll: false,
        expectedRecipientEmail: recipient,
        resolvedRecipients: { to: [recipient], cc: [] },
        recipientBinding,
        bindingExpiresInSeconds: 600,
      }),
      isError: false,
      executed: true,
      objectiveAuthorizationSegments,
    });
    const firstBinding = gmailRecipientBinding('e');
    const latestBinding = gmailRecipientBinding('f');
    record(
      'reused-preflight-id', firstInput, firstBinding, 'alice@example.com', 'Premier corps.',
    );
    record(
      'reused-preflight-id', latestInput, latestBinding, 'bob@example.com', 'Deuxième corps.',
    );
    expect(run('mcp__google-contacts__gmail_reply_bound', {
      ...latestInput,
      recipientBinding: latestBinding,
    })).toMatchObject({ type: 'block' });

    expect(run(
      'mcp__google-contacts__gmail_reply_preflight', latestInput, 'fresh-preflight-id',
    ).type).toBe('allow');
    record(
      'fresh-preflight-id', latestInput, latestBinding, 'bob@example.com', 'Deuxième corps.',
    );
    expect(run('mcp__google-contacts__gmail_reply_bound', {
      ...latestInput,
      recipientBinding: latestBinding,
    }).type).toBe('allow');
  });
});
