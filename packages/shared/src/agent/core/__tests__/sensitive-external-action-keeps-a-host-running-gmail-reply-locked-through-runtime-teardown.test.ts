import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { cleanupModeState, initializeModeState, type PermissionMode } from "../../mode-manager.ts";
import { beginContextualGmailHostExecution, clearContextualGmailPreflightAttestation, confirmContextualGmailRuntimeTeardown, invalidateContextualGmailSessionState, recordContextualGmailToolResult, runPreToolUseChecks, settleContextualGmailHostExecution, type PermissionManagerLike } from "../pre-tool-use.ts";
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

  it('keeps a host-running Gmail reply locked through runtime teardown until exact settle', () => {
    const scenario = createClosedExactGmailPreflightScenario();
    const binding = gmailRecipientBinding('2');
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight', scenario.preflightInput, 'running-preflight',
    ).type).toBe('allow');
    scenario.recordPreflight('running-preflight', binding);
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound',
      scenario.boundInput(binding),
      'running-send',
      ['google-contacts'],
      false,
      scenario.runtimeId,
    ).type).toBe('allow');

    const started = beginContextualGmailHostExecution({
      sessionId: scenario.sessionId,
      runtimeId: scenario.runtimeId,
      toolUseId: 'running-send',
      toolName: 'mcp__google-contacts__gmail_reply_bound',
      toolInput: scenario.boundInput(binding),
    });
    expect(started).toMatchObject({ applies: true, allowed: true });
    if (!started.allowed || !started.applies) throw new Error('expected an execution ticket');

    // Even an executed:false terminal event cannot restore authority after the
    // actual host boundary was crossed; only the exact finally ticket settles.
    scenario.recordBoundResult('running-send', false);
    invalidateContextualGmailSessionState(scenario.sessionId);
    expect(confirmContextualGmailRuntimeTeardown({
      sessionId: scenario.sessionId,
      runtimeId: scenario.runtimeId,
    })).toBeFalse();
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight', scenario.preflightInput, 'blocked-while-running',
    )).toMatchObject({ type: 'block' });
    expect(settleContextualGmailHostExecution(started.ticket)).toBeTrue();
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight', scenario.preflightInput, 'fresh-after-settle',
    ).type).toBe('allow');
  });

  it('does not let stale runtime teardown or execution tickets release a newer reservation', () => {
    const scenario = createClosedExactGmailPreflightScenario();
    const oldBinding = gmailRecipientBinding('3');
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight', scenario.preflightInput, 'old-runtime-preflight',
    ).type).toBe('allow');
    scenario.recordPreflight('old-runtime-preflight', oldBinding);
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound',
      scenario.boundInput(oldBinding),
      'old-runtime-send',
      ['google-contacts'],
      false,
      scenario.runtimeId,
    ).type).toBe('allow');
    const oldStart = beginContextualGmailHostExecution({
      sessionId: scenario.sessionId,
      runtimeId: scenario.runtimeId,
      toolName: 'mcp__google-contacts__gmail_reply_bound',
      toolInput: scenario.boundInput(oldBinding),
    });
    expect(oldStart).toMatchObject({ applies: true, allowed: true });
    if (!oldStart.allowed || !oldStart.applies) throw new Error('expected the old execution ticket');
    expect(settleContextualGmailHostExecution(oldStart.ticket)).toBeTrue();
    invalidateContextualGmailSessionState(scenario.sessionId);

    const newRuntimeId = `runtime-${randomUUID()}`;
    const newBinding = gmailRecipientBinding('4');
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight',
      scenario.preflightInput,
      'new-runtime-preflight',
      ['google-contacts'],
      false,
      newRuntimeId,
    ).type).toBe('allow');
    scenario.recordPreflight('new-runtime-preflight', newBinding);
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound',
      scenario.boundInput(newBinding),
      'old-runtime-send',
      ['google-contacts'],
      false,
      newRuntimeId,
    ).type).toBe('allow');
    // This terminal is indistinguishable by SDK id alone and belongs to the
    // old runtime. It must not release the newer runtime's reservation.
    scenario.recordBoundResult('old-runtime-send', false);

    expect(confirmContextualGmailRuntimeTeardown({
      sessionId: scenario.sessionId,
      runtimeId: scenario.runtimeId,
    })).toBeFalse();
    expect(settleContextualGmailHostExecution(oldStart.ticket)).toBeFalse();
    const newStart = beginContextualGmailHostExecution({
      sessionId: scenario.sessionId,
      runtimeId: newRuntimeId,
      toolUseId: 'old-runtime-send',
      toolName: 'mcp__google-contacts__gmail_reply_bound',
      toolInput: scenario.boundInput(newBinding),
    });
    expect(newStart).toMatchObject({ applies: true, allowed: true });
    if (!newStart.allowed || !newStart.applies) throw new Error('expected the new execution ticket');
    expect(settleContextualGmailHostExecution(newStart.ticket)).toBeTrue();
  });

  it('blocks duplicate or mismatched Gmail host execution starts', () => {
    const scenario = createClosedExactGmailPreflightScenario();
    const binding = gmailRecipientBinding('5');
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight', scenario.preflightInput, 'host-start-preflight',
    ).type).toBe('allow');
    scenario.recordPreflight('host-start-preflight', binding);
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound',
      scenario.boundInput(binding),
      'host-start-send',
      ['google-contacts'],
      false,
      scenario.runtimeId,
    ).type).toBe('allow');

    expect(beginContextualGmailHostExecution({
      sessionId: scenario.sessionId,
      runtimeId: scenario.runtimeId,
      toolUseId: 'host-start-send',
      toolName: 'mcp__google-contacts__gmail_reply_bound',
      toolInput: { ...scenario.boundInput(binding), body: 'different body' },
    })).toMatchObject({ applies: true, allowed: false });
    const first = beginContextualGmailHostExecution({
      sessionId: scenario.sessionId,
      runtimeId: scenario.runtimeId,
      toolName: 'mcp__google-contacts__gmail_reply_bound',
      toolInput: scenario.boundInput(binding),
    });
    expect(first).toMatchObject({ applies: true, allowed: true });
    if (!first.allowed || !first.applies) throw new Error('expected the first execution ticket');
    expect(first.ticket.toolUseId).toBe('host-start-send');
    expect(beginContextualGmailHostExecution({
      sessionId: scenario.sessionId,
      runtimeId: scenario.runtimeId,
      toolUseId: 'host-start-send',
      toolName: 'mcp__google-contacts__gmail_reply_bound',
      toolInput: scenario.boundInput(binding),
    })).toMatchObject({ applies: true, allowed: false });
    expect(settleContextualGmailHostExecution(first.ticket)).toBeTrue();
    expect(settleContextualGmailHostExecution(first.ticket)).toBeFalse();
  });

  it('does not poison a Gmail preflight id while the host activates its source', () => {
    const scenario = createClosedExactGmailPreflightScenario();
    const binding = gmailRecipientBinding('b');
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight',
      scenario.preflightInput,
      'activation-preflight',
      [],
    )).toMatchObject({ type: 'source_activation_needed' });
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight',
      scenario.preflightInput,
      'activation-preflight',
      ['google-contacts'],
      true,
    ).type).toBe('allow');
    scenario.recordPreflight('activation-preflight', binding);
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight',
      scenario.preflightInput,
      'activation-preflight',
      ['google-contacts'],
      true,
    )).toMatchObject({ type: 'block' });
    const freshBinding = gmailRecipientBinding('c');
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight',
      scenario.preflightInput,
      'activation-preflight-fresh',
    ).type).toBe('allow');
    scenario.recordPreflight('activation-preflight-fresh', freshBinding);
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound', scenario.boundInput(freshBinding), 'activation-send',
    ).type).toBe('allow');
  });
});
