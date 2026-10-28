import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { cleanupModeState, initializeModeState, type PermissionMode } from "../../mode-manager.ts";
import { beginContextualGmailHostExecution, clearContextualGmailMutationLifecycleState, clearContextualGmailPreflightAttestation, confirmContextualGmailRuntimeTeardown, destroyContextualGmailSessionState, hasContextualGmailInFlightForRuntime, invalidateContextualGmailSessionState, recordContextualGmailToolResult, resolveContextualGmailPromptReservation, runPreToolUseChecks, settleContextualGmailHostExecution, type PermissionManagerLike } from "../pre-tool-use.ts";
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

  it('does not let a delayed duplicate terminal result release a newer Gmail reservation', () => {
    const scenario = createClosedExactGmailPreflightScenario();
    const binding = gmailRecipientBinding('8');
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight', scenario.preflightInput, 'delayed-preflight',
    ).type).toBe('allow');
    scenario.recordPreflight('delayed-preflight', binding);
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound', scenario.boundInput(binding), 'completed-send-id',
    ).type).toBe('allow');
    scenario.recordBoundResult('completed-send-id', false);

    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound', scenario.boundInput(binding), 'completed-send-id',
    )).toMatchObject({ type: 'block' });
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound', scenario.boundInput(binding), 'newer-send-id',
    )).toMatchObject({ type: 'block' });

    const freshBinding = gmailRecipientBinding('d');
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight',
      scenario.preflightInput,
      'fresh-after-reused-terminal-id',
    ).type).toBe('allow');
    scenario.recordPreflight('fresh-after-reused-terminal-id', freshBinding);
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound',
      scenario.boundInput(freshBinding),
      'post-collision-send-id',
    ).type).toBe('allow');

    scenario.recordBoundResult('completed-send-id', false);
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight',
      scenario.preflightInput,
      'must-stay-locked',
    )).toMatchObject({ type: 'block' });
    scenario.recordBoundResult('post-collision-send-id', false);
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound',
      scenario.boundInput(freshBinding),
      'after-newer-terminal',
    ).type).toBe('allow');
  });

  it('requires a fresh Gmail preflight after interrupted mutation lifecycle teardown', () => {
    const scenario = createClosedExactGmailPreflightScenario();
    const staleBinding = gmailRecipientBinding('9');
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight', scenario.preflightInput, 'teardown-preflight',
    ).type).toBe('allow');
    scenario.recordPreflight('teardown-preflight', staleBinding);
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound', scenario.boundInput(staleBinding), 'lost-terminal',
    ).type).toBe('allow');

    clearContextualGmailMutationLifecycleState(scenario.sessionId);
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound', scenario.boundInput(staleBinding), 'stale-after-reset',
    )).toMatchObject({ type: 'block' });

    const freshBinding = gmailRecipientBinding('a');
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight', scenario.preflightInput, 'fresh-after-reset',
    ).type).toBe('allow');
    scenario.recordPreflight('fresh-after-reset', freshBinding);
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound', scenario.boundInput(freshBinding), 'fresh-send',
    ).type).toBe('allow');
  });

  it('requires a fresh preflight when its runtime tears down before host execution starts', () => {
    const scenario = createClosedExactGmailPreflightScenario();
    const binding = gmailRecipientBinding('1');
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight', scenario.preflightInput, 'teardown-before-preflight',
    ).type).toBe('allow');
    scenario.recordPreflight('teardown-before-preflight', binding);
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound',
      scenario.boundInput(binding),
      'teardown-before-send',
      ['google-contacts'],
      false,
      scenario.runtimeId,
    ).type).toBe('allow');
    expect(hasContextualGmailInFlightForRuntime({
      sessionId: scenario.sessionId,
      runtimeId: scenario.runtimeId,
    })).toBeTrue();
    expect(hasContextualGmailInFlightForRuntime({
      sessionId: scenario.sessionId,
      runtimeId: 'older-runtime',
    })).toBeFalse();

    invalidateContextualGmailSessionState(scenario.sessionId);
    expect(confirmContextualGmailRuntimeTeardown({
      sessionId: scenario.sessionId,
      runtimeId: scenario.runtimeId,
    })).toBeTrue();
    expect(hasContextualGmailInFlightForRuntime({
      sessionId: scenario.sessionId,
      runtimeId: scenario.runtimeId,
    })).toBeFalse();
    expect(beginContextualGmailHostExecution({
      sessionId: scenario.sessionId,
      runtimeId: scenario.runtimeId,
      toolUseId: 'teardown-before-send',
      toolName: 'mcp__google-contacts__gmail_reply_bound',
      toolInput: scenario.boundInput(binding),
    })).toMatchObject({ applies: true, allowed: false });
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound',
      scenario.boundInput(binding),
      'teardown-before-stale-retry',
    )).toMatchObject({ type: 'block' });
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight',
      scenario.preflightInput,
      'teardown-before-fresh-preflight',
    ).type).toBe('allow');
  });

  it('defers definitive session cleanup until runtime teardown, then removes Gmail tombstones', () => {
    const scenario = createClosedExactGmailPreflightScenario();
    const binding = gmailRecipientBinding('b');
    const reusedToolUseId = 'deleted-session-preflight';
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight', scenario.preflightInput, reusedToolUseId,
    ).type).toBe('allow');
    scenario.recordPreflight(reusedToolUseId, binding);
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound',
      scenario.boundInput(binding),
      'deleted-session-send',
      ['google-contacts'],
      false,
      scenario.runtimeId,
    ).type).toBe('allow');

    destroyContextualGmailSessionState(scenario.sessionId);
    expect(hasContextualGmailInFlightForRuntime({
      sessionId: scenario.sessionId,
      runtimeId: scenario.runtimeId,
    })).toBeTrue();
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight',
      scenario.preflightInput,
      'blocked-during-final-cleanup',
    )).toMatchObject({ type: 'block' });

    expect(confirmContextualGmailRuntimeTeardown({
      sessionId: scenario.sessionId,
      runtimeId: scenario.runtimeId,
    })).toBeTrue();
    expect(hasContextualGmailInFlightForRuntime({
      sessionId: scenario.sessionId,
      runtimeId: scenario.runtimeId,
    })).toBeFalse();
    // Definitive deletion, unlike a runtime-only reset, removes terminal tool
    // id claims as well as short-lived observations.
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight', scenario.preflightInput, reusedToolUseId,
    ).type).toBe('allow');
  });

  it('keeps definitive cleanup closed until both a host ticket and its runtime terminate', () => {
    const scenario = createClosedExactGmailPreflightScenario();
    const binding = gmailRecipientBinding('c');
    const reusedToolUseId = 'deleted-running-preflight';
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight', scenario.preflightInput, reusedToolUseId,
    ).type).toBe('allow');
    scenario.recordPreflight(reusedToolUseId, binding);
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound',
      scenario.boundInput(binding),
      'deleted-running-send',
      ['google-contacts'],
      false,
      scenario.runtimeId,
    ).type).toBe('allow');
    const started = beginContextualGmailHostExecution({
      sessionId: scenario.sessionId,
      runtimeId: scenario.runtimeId,
      toolUseId: 'deleted-running-send',
      toolName: 'mcp__google-contacts__gmail_reply_bound',
      toolInput: scenario.boundInput(binding),
    });
    if (!started.applies || !started.allowed) throw new Error('expected a host ticket');

    destroyContextualGmailSessionState(scenario.sessionId);
    expect(settleContextualGmailHostExecution(started.ticket)).toBeTrue();
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight',
      scenario.preflightInput,
      'blocked-until-runtime-exit',
    )).toMatchObject({ type: 'block' });

    // No in-flight reservation remains, so the false return is expected; the
    // exact runtime correlation still completes the deferred final cleanup.
    expect(confirmContextualGmailRuntimeTeardown({
      sessionId: scenario.sessionId,
      runtimeId: scenario.runtimeId,
    })).toBeFalse();
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight', scenario.preflightInput, reusedToolUseId,
    ).type).toBe('allow');
  });

  it('does not restore a denied Ask reservation after its runtime was invalidated', () => {
    const scenario = createClosedExactGmailPreflightScenario({
      permissionMode: 'ask',
      permissionManager: nonWhitelistedPermissionManager,
    });
    const binding = gmailRecipientBinding('6');
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight', scenario.preflightInput, 'invalidated-ask-preflight',
    ).type).toBe('allow');
    scenario.recordPreflight('invalidated-ask-preflight', binding);
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound',
      scenario.boundInput(binding),
      'invalidated-ask-send',
      ['google-contacts'],
      false,
      scenario.runtimeId,
    )).toMatchObject({ type: 'prompt' });

    invalidateContextualGmailSessionState(scenario.sessionId);
    expect(resolveContextualGmailPromptReservation({
      sessionId: scenario.sessionId,
      toolUseId: 'invalidated-ask-send',
      toolName: 'mcp__google-contacts__gmail_reply_bound',
      toolInput: scenario.boundInput(binding),
      approved: false,
      objectiveAuthorizationSegments: scenario.objectiveAuthorizationSegments,
    })).toMatchObject({ applies: true, allowed: false });
    expect(confirmContextualGmailRuntimeTeardown({
      sessionId: scenario.sessionId,
      runtimeId: scenario.runtimeId,
    })).toBeFalse();
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound',
      scenario.boundInput(binding),
      'invalidated-ask-stale-retry',
    )).toMatchObject({ type: 'block' });
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight',
      scenario.preflightInput,
      'invalidated-ask-fresh-preflight',
    ).type).toBe('allow');
  });
});
