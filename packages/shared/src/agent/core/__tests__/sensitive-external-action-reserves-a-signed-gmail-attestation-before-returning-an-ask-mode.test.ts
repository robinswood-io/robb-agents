import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { cleanupModeState, initializeModeState, type PermissionMode } from "../../mode-manager.ts";
import { clearContextualGmailMutationLifecycleState, clearContextualGmailPreflightAttestation, recordContextualGmailToolResult, resolveContextualGmailPromptReservation, runPreToolUseChecks, type PermissionManagerLike } from "../pre-tool-use.ts";
import { gmailRecipientBinding, nonWhitelistedPermissionManager, whitelistedPermissionManager } from "./testing/sensitive-external-action-fixture.ts";

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

  it('reserves a signed Gmail attestation before returning an Ask-mode prompt', () => {
    const scenario = createClosedExactGmailPreflightScenario({
      permissionMode: 'ask',
      permissionManager: nonWhitelistedPermissionManager,
    });
    const binding = gmailRecipientBinding('d');
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight', scenario.preflightInput, 'ask-preflight',
    ).type).toBe('allow');
    scenario.recordPreflight('ask-preflight', binding);

    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound', scenario.boundInput(binding), 'ask-send',
    )).toMatchObject({ type: 'prompt' });
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound', scenario.boundInput(binding), 'ask-send-parallel',
    )).toMatchObject({ type: 'block' });

    // A denial/non-execution restores the same still-fresh attestation.
    scenario.recordBoundResult('ask-send', false);
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound', scenario.boundInput(binding), 'ask-send-retry',
    )).toMatchObject({ type: 'prompt' });
    scenario.recordBoundResult('ask-send-retry', true, false);
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound', scenario.boundInput(binding), 'ask-send-after-effect',
    )).toMatchObject({ type: 'block' });
  });

  it('atomically resolves denied and expired Gmail Ask reservations', () => {
    const now = new Date('2026-09-17T10:00:00.000Z');
    setSystemTime(now);
    const denied = createClosedExactGmailPreflightScenario({
      permissionMode: 'ask',
      permissionManager: nonWhitelistedPermissionManager,
    });
    const deniedBinding = gmailRecipientBinding('1');
    expect(denied.run(
      'mcp__google-contacts__gmail_reply_preflight', denied.preflightInput, 'deny-preflight',
    ).type).toBe('allow');
    denied.recordPreflight('deny-preflight', deniedBinding);
    expect(denied.run(
      'mcp__google-contacts__gmail_reply_bound', denied.boundInput(deniedBinding), 'deny-send',
    )).toMatchObject({ type: 'prompt' });
    expect(resolveContextualGmailPromptReservation({
      sessionId: denied.sessionId,
      toolUseId: 'deny-send',
      toolName: 'mcp__google-contacts__gmail_reply_bound',
      toolInput: denied.boundInput(deniedBinding),
      approved: false,
      objectiveAuthorizationSegments: denied.objectiveAuthorizationSegments,
    })).toMatchObject({ applies: true, allowed: false });
    expect(denied.run(
      'mcp__google-contacts__gmail_reply_bound',
      denied.boundInput(deniedBinding),
      'deny-send-retry',
    )).toMatchObject({ type: 'prompt' });

    const expired = createClosedExactGmailPreflightScenario({
      permissionMode: 'ask',
      permissionManager: nonWhitelistedPermissionManager,
    });
    const expiringBinding = gmailRecipientBinding('2');
    expect(expired.run(
      'mcp__google-contacts__gmail_reply_preflight', expired.preflightInput, 'expiry-preflight',
    ).type).toBe('allow');
    expired.recordPreflight('expiry-preflight', expiringBinding, { bindingExpiresInSeconds: 1 });
    expect(expired.run(
      'mcp__google-contacts__gmail_reply_bound', expired.boundInput(expiringBinding), 'expiry-send',
    )).toMatchObject({ type: 'prompt' });

    setSystemTime(new Date(now.getTime() + 2_000));
    const expiredApproval = resolveContextualGmailPromptReservation({
      sessionId: expired.sessionId,
      toolUseId: 'expiry-send',
      toolName: 'mcp__google-contacts__gmail_reply_bound',
      toolInput: expired.boundInput(expiringBinding),
      approved: true,
      objectiveAuthorizationSegments: expired.objectiveAuthorizationSegments,
    });
    expect(expiredApproval).toMatchObject({ applies: true, allowed: false });
    expect(expiredApproval.reason).toContain('fresh canonical preflight');

    const freshBinding = gmailRecipientBinding('3');
    expect(expired.run(
      'mcp__google-contacts__gmail_reply_preflight', expired.preflightInput, 'after-expiry-preflight',
    ).type).toBe('allow');
    expired.recordPreflight('after-expiry-preflight', freshBinding);
    expect(expired.run(
      'mcp__google-contacts__gmail_reply_bound',
      expired.boundInput(freshBinding),
      'after-expiry-send',
    )).toMatchObject({ type: 'prompt' });
  });

  it('revalidates the effective mode and active Gmail source before consuming Ask approval', () => {
    const approved = createClosedExactGmailPreflightScenario({
      permissionMode: 'ask',
      permissionManager: nonWhitelistedPermissionManager,
    });
    const approvedBinding = gmailRecipientBinding('7');
    expect(approved.run(
      'mcp__google-contacts__gmail_reply_preflight', approved.preflightInput, 'approved-preflight',
    ).type).toBe('allow');
    approved.recordPreflight('approved-preflight', approvedBinding);
    expect(approved.run(
      'mcp__google-contacts__gmail_reply_bound',
      approved.boundInput(approvedBinding),
      'approved-send',
    )).toMatchObject({ type: 'prompt' });
    expect(resolveContextualGmailPromptReservation({
      sessionId: approved.sessionId,
      toolUseId: 'approved-send',
      toolName: 'mcp__google-contacts__gmail_reply_bound',
      toolInput: approved.boundInput(approvedBinding),
      approved: true,
      permissionMode: 'ask',
      activeSourceSlugs: ['google-contacts'],
      objectiveAuthorizationSegments: approved.objectiveAuthorizationSegments,
    })).toMatchObject({ applies: true, allowed: true });

    const safe = createClosedExactGmailPreflightScenario({
      permissionMode: 'ask',
      permissionManager: nonWhitelistedPermissionManager,
    });
    const safeBinding = gmailRecipientBinding('8');
    expect(safe.run(
      'mcp__google-contacts__gmail_reply_preflight', safe.preflightInput, 'safe-preflight',
    ).type).toBe('allow');
    safe.recordPreflight('safe-preflight', safeBinding);
    expect(safe.run(
      'mcp__google-contacts__gmail_reply_bound', safe.boundInput(safeBinding), 'safe-send',
    )).toMatchObject({ type: 'prompt' });
    expect(resolveContextualGmailPromptReservation({
      sessionId: safe.sessionId,
      toolUseId: 'safe-send',
      toolName: 'mcp__google-contacts__gmail_reply_bound',
      toolInput: safe.boundInput(safeBinding),
      approved: true,
      permissionMode: 'safe',
      activeSourceSlugs: ['google-contacts'],
      objectiveAuthorizationSegments: safe.objectiveAuthorizationSegments,
    })).toMatchObject({ applies: true, allowed: false });

    const inactiveSource = createClosedExactGmailPreflightScenario({
      permissionMode: 'ask',
      permissionManager: nonWhitelistedPermissionManager,
    });
    const inactiveSourceBinding = gmailRecipientBinding('9');
    expect(inactiveSource.run(
      'mcp__google-contacts__gmail_reply_preflight',
      inactiveSource.preflightInput,
      'inactive-source-preflight',
    ).type).toBe('allow');
    inactiveSource.recordPreflight('inactive-source-preflight', inactiveSourceBinding);
    expect(inactiveSource.run(
      'mcp__google-contacts__gmail_reply_bound',
      inactiveSource.boundInput(inactiveSourceBinding),
      'inactive-source-send',
    )).toMatchObject({ type: 'prompt' });
    expect(resolveContextualGmailPromptReservation({
      sessionId: inactiveSource.sessionId,
      toolUseId: 'inactive-source-send',
      toolName: 'mcp__google-contacts__gmail_reply_bound',
      toolInput: inactiveSource.boundInput(inactiveSourceBinding),
      approved: true,
      permissionMode: 'ask',
      activeSourceSlugs: [],
      objectiveAuthorizationSegments: inactiveSource.objectiveAuthorizationSegments,
    })).toMatchObject({ applies: true, allowed: false });
  });

  it('tombstones blocked and cross-tool Gmail ids before any reservation', () => {
    const scenario = createClosedExactGmailPreflightScenario();
    const binding = gmailRecipientBinding('e');
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound', scenario.boundInput(binding), 'early-blocked-id',
    )).toMatchObject({ type: 'block' });
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight', scenario.preflightInput, 'fresh-preflight-id',
    ).type).toBe('allow');
    scenario.recordPreflight('fresh-preflight-id', binding);

    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound', scenario.boundInput(binding), 'early-blocked-id',
    )).toMatchObject({ type: 'block' });
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound', scenario.boundInput(binding), 'fresh-bound-id',
    )).toMatchObject({ type: 'block' });

    // The collision invalidates the old capability. A fresh proof can use a
    // new id, and the delayed terminal from the early blocked call cannot
    // release that later reservation.
    const newerBinding = gmailRecipientBinding('f');
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight', scenario.preflightInput, 'new-proof-id',
    ).type).toBe('allow');
    scenario.recordPreflight('new-proof-id', newerBinding);
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound', scenario.boundInput(newerBinding), 'new-bound-id',
    ).type).toBe('allow');
    scenario.recordBoundResult('early-blocked-id', false);
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight', scenario.preflightInput, 'must-remain-locked',
    )).toMatchObject({ type: 'block' });
    scenario.recordBoundResult('new-bound-id', false);

    clearContextualGmailMutationLifecycleState(scenario.sessionId);
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight', scenario.preflightInput, 'fresh-preflight-id',
    )).toMatchObject({ type: 'block' });
    const crossBinding = gmailRecipientBinding('a');
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight', scenario.preflightInput, 'cross-tool-id',
    ).type).toBe('allow');
    scenario.recordPreflight('cross-tool-id', crossBinding);
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound', scenario.boundInput(crossBinding), 'cross-tool-id',
    )).toMatchObject({ type: 'block' });
  });

  it('keeps a collided in-flight Gmail id poisoned until runtime teardown', () => {
    const scenario = createClosedExactGmailPreflightScenario();
    const binding = gmailRecipientBinding('7');
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight', scenario.preflightInput, 'lock-preflight',
    ).type).toBe('allow');
    scenario.recordPreflight('lock-preflight', binding);
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound', scenario.boundInput(binding), 'reused-send-id',
    ).type).toBe('allow');
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound', scenario.boundInput(binding), 'reused-send-id',
    )).toMatchObject({ type: 'block' });

    scenario.recordBoundResult('reused-send-id', false);
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight',
      scenario.preflightInput,
      'still-locked-preflight',
    )).toMatchObject({ type: 'block' });

    scenario.recordBoundResult('reused-send-id', false);
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound', scenario.boundInput(binding), 'restored-send-id',
    )).toMatchObject({ type: 'block' });

    clearContextualGmailMutationLifecycleState(scenario.sessionId);
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound', scenario.boundInput(binding), 'stale-after-collision',
    )).toMatchObject({ type: 'block' });
    const freshBinding = gmailRecipientBinding('c');
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight', scenario.preflightInput, 'fresh-after-collision',
    ).type).toBe('allow');
    scenario.recordPreflight('fresh-after-collision', freshBinding);
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound', scenario.boundInput(freshBinding), 'send-after-collision',
    ).type).toBe('allow');
  });
});
