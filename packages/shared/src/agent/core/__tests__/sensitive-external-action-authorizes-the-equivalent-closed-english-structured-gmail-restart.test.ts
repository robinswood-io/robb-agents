import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { cleanupModeState, initializeModeState, type PermissionMode } from "../../mode-manager.ts";
import { clearContextualGmailPreflightAttestation, recordContextualGmailToolResult, runPreToolUseChecks, type PermissionManagerLike } from "../pre-tool-use.ts";
import { contextualGmailReplyPreflightAttestationFromObjective, isContextualGmailReplyRequestedByObjective } from "../sensitive-external-action.ts";
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

  it('authorizes the equivalent closed English structured Gmail restart', () => {
    const body = 'Thank you Alice, the contract is approved.';
    const structuredObjective = [
      '[robb-resume:sensitive-action:804c81665de46593b0e26449756041ff7af3ab15:v5]',
      'The marker SHA identifies only the installed Robb Agents runtime. It is neither a remote revision nor a business artifact nor additional authorization.',
      '',
      'Complete the initial mission now. Reply in the Gmail thread with exact anchor 1a0a917ea946a540. Use only the canonical Gmail API, never the browser.',
      '',
      'Required and immutable payload:',
      '- From: sender@example.test',
      '- To: alice@example.com',
      '- CC: []',
      '- BCC: []',
      '- Subject: RE: HTML signature and attachments',
      '- Plain text only (`isHtml=false`)',
      '- Attachments: []',
      '- Signature: none, neither automatic nor manual',
      '- Exact body, without the BODY_BEGIN/BODY_END delimiters and without additions:',
      '',
      'BODY_BEGIN',
      body,
      'BODY_END',
      '',
      'Before any mutation, run a new complete `gmail_reply_preflight` on this anchor and exact payload. Do not use an old binding. Continue only if the anchor, From, To, CC, BCC, subject, body, no attachments, and no signature match exactly, if the SENT and DRAFT reconciliation is conclusive and fully paginated, and if `candidateCount=0`. If a candidate, an ambiguity, or incomplete evidence appears, do not send anything and close factually.',
      '',
      'Only if all of these conditions are satisfied, immediately use the fresh `recipientBinding` in at most one `gmail_reply_bound` call with the strictly identical payload. After the call, verify via API the messageId, thread, From, To, CC, BCC, subject, body, attachments, and no signature. Never repeat the effect if the call result is uncertain: reconcile SENT and DRAFT before any decision. Do not ask again for any already established element and continue until a genuinely verified end.',
    ].join('\n');
    const scenario = createClosedExactGmailPreflightScenario({
      objectiveTransform: () => structuredObjective,
      body,
      subject: 'RE: HTML signature and attachments',
    });

    expect(isContextualGmailReplyRequestedByObjective([structuredObjective])).toBeTrue();
    expect(contextualGmailReplyPreflightAttestationFromObjective(
      'mcp__google-contacts__gmail_reply_preflight',
      scenario.preflightInput,
      [structuredObjective],
    )).toMatchObject({
      messageId: scenario.messageId,
      expectedRecipientEmail: 'alice@example.com',
      expectedSenderEmail: 'sender@example.test',
      expectedCc: '',
      expectedSubject: 'RE: HTML signature and attachments',
      body,
      isHtml: false,
      requiresExactEffectReconciliation: true,
    });

    const recipientBinding = gmailRecipientBinding('d');
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_preflight',
      scenario.preflightInput,
      'english-structured-restart-preflight',
    ).type).toBe('allow');
    scenario.recordPreflight('english-structured-restart-preflight', recipientBinding);
    expect(scenario.run(
      'mcp__google-contacts__gmail_reply_bound',
      scenario.boundInput(recipientBinding),
      'english-structured-restart-bound',
    ).type).toBe('allow');

    for (const widened of [
      structuredObjective.replace('- BCC: []', '- BCC: mallory@example.com'),
      structuredObjective.replace('- Attachments: []', '- Attachments: [] then contract.pdf'),
      structuredObjective.replace('- Signature: none, neither automatic nor manual', '- Signature: automatic'),
      structuredObjective.replace('`isHtml=false`', '`isHtml=true`'),
    ]) {
      expect(isContextualGmailReplyRequestedByObjective([widened])).toBeFalse();
    }
  });

  it('invalidates older Gmail preflight generations on every newer terminal outcome', () => {
    const failed = createClosedExactGmailPreflightScenario();
    const failedA = gmailRecipientBinding('a');
    const failedB = gmailRecipientBinding('b');
    expect(failed.run(
      'mcp__google-contacts__gmail_reply_preflight', failed.preflightInput, 'failed-a',
    ).type).toBe('allow');
    failed.recordPreflight('failed-a', failedA);
    expect(failed.run(
      'mcp__google-contacts__gmail_reply_preflight', failed.preflightInput, 'failed-b',
    ).type).toBe('allow');
    failed.recordPreflight('failed-b', failedB, {
      ok: false,
      error: 'reply_exact_draft_exists',
      draftExists: true,
    });
    expect(failed.run(
      'mcp__google-contacts__gmail_reply_bound', failed.boundInput(failedA),
    )).toMatchObject({ type: 'block' });

    const ambiguous = createClosedExactGmailPreflightScenario();
    const ambiguousA = gmailRecipientBinding('c');
    const ambiguousB = gmailRecipientBinding('d');
    expect(ambiguous.run(
      'mcp__google-contacts__gmail_reply_preflight', ambiguous.preflightInput, 'ambiguous-a',
    ).type).toBe('allow');
    ambiguous.recordPreflight('ambiguous-a', ambiguousA);
    expect(ambiguous.run(
      'mcp__google-contacts__gmail_reply_preflight', ambiguous.preflightInput, 'ambiguous-b',
    ).type).toBe('allow');
    ambiguous.recordPreflight('ambiguous-b', ambiguousB, {
      exactEffectReconciliation: {
        checked: true,
        conclusive: false,
        paginationComplete: false,
        source: 'gmail_threads_get_full',
        scopes: ['SENT', 'DRAFT'],
        threadId: '1a0a917ea946a541',
        operationKey: 'f'.repeat(64),
        candidateCount: 0,
      },
    });
    expect(ambiguous.run(
      'mcp__google-contacts__gmail_reply_bound', ambiguous.boundInput(ambiguousA),
    )).toMatchObject({ type: 'block' });

    const latestSuccess = createClosedExactGmailPreflightScenario();
    const olderBinding = gmailRecipientBinding('e');
    const latestBinding = gmailRecipientBinding('f');
    expect(latestSuccess.run(
      'mcp__google-contacts__gmail_reply_preflight',
      latestSuccess.preflightInput,
      'out-of-order-a',
    ).type).toBe('allow');
    expect(latestSuccess.run(
      'mcp__google-contacts__gmail_reply_preflight',
      latestSuccess.preflightInput,
      'out-of-order-b',
    ).type).toBe('allow');
    latestSuccess.recordPreflight('out-of-order-b', latestBinding);
    latestSuccess.recordPreflight('out-of-order-a', olderBinding);
    expect(latestSuccess.run(
      'mcp__google-contacts__gmail_reply_bound', latestSuccess.boundInput(olderBinding),
    )).toMatchObject({ type: 'block' });
    expect(latestSuccess.run(
      'mcp__google-contacts__gmail_reply_bound', latestSuccess.boundInput(latestBinding),
    ).type).toBe('allow');

    const lateAfterFailure = createClosedExactGmailPreflightScenario();
    const lateA = gmailRecipientBinding('1');
    const lateB = gmailRecipientBinding('2');
    expect(lateAfterFailure.run(
      'mcp__google-contacts__gmail_reply_preflight',
      lateAfterFailure.preflightInput,
      'late-after-failure-a',
    ).type).toBe('allow');
    expect(lateAfterFailure.run(
      'mcp__google-contacts__gmail_reply_preflight',
      lateAfterFailure.preflightInput,
      'late-after-failure-b',
    ).type).toBe('allow');
    lateAfterFailure.recordPreflight('late-after-failure-b', lateB, {
      ok: false,
      error: 'preflight_failed',
    });
    lateAfterFailure.recordPreflight('late-after-failure-a', lateA);
    expect(lateAfterFailure.run(
      'mcp__google-contacts__gmail_reply_bound', lateAfterFailure.boundInput(lateA),
    )).toMatchObject({ type: 'block' });
  });

  it('restores a reserved Gmail attestation only while its generation is still current', () => {
    const retryable = createClosedExactGmailPreflightScenario();
    const retryableBinding = gmailRecipientBinding('3');
    expect(retryable.run(
      'mcp__google-contacts__gmail_reply_preflight', retryable.preflightInput, 'retry-preflight',
    ).type).toBe('allow');
    retryable.recordPreflight('retry-preflight', retryableBinding);
    expect(retryable.run(
      'mcp__google-contacts__gmail_reply_bound',
      retryable.boundInput(retryableBinding),
      'retry-send',
    ).type).toBe('allow');
    retryable.recordBoundResult('retry-send', false);
    expect(retryable.run(
      'mcp__google-contacts__gmail_reply_bound',
      retryable.boundInput(retryableBinding),
      'retry-send-2',
    ).type).toBe('allow');

    const executed = createClosedExactGmailPreflightScenario();
    const executedBinding = gmailRecipientBinding('4');
    expect(executed.run(
      'mcp__google-contacts__gmail_reply_preflight', executed.preflightInput, 'executed-preflight',
    ).type).toBe('allow');
    executed.recordPreflight('executed-preflight', executedBinding);
    expect(executed.run(
      'mcp__google-contacts__gmail_reply_bound',
      executed.boundInput(executedBinding),
      'executed-send',
    ).type).toBe('allow');
    executed.recordBoundResult('executed-send', true, true);
    expect(executed.run(
      'mcp__google-contacts__gmail_reply_bound', executed.boundInput(executedBinding),
    )).toMatchObject({ type: 'block' });

    const superseded = createClosedExactGmailPreflightScenario();
    const supersededA = gmailRecipientBinding('5');
    const supersededB = gmailRecipientBinding('6');
    expect(superseded.run(
      'mcp__google-contacts__gmail_reply_preflight',
      superseded.preflightInput,
      'superseded-preflight-a',
    ).type).toBe('allow');
    superseded.recordPreflight('superseded-preflight-a', supersededA);
    expect(superseded.run(
      'mcp__google-contacts__gmail_reply_bound',
      superseded.boundInput(supersededA),
      'superseded-send-a',
    ).type).toBe('allow');
    const concurrentPreflight = superseded.run(
      'mcp__google-contacts__gmail_reply_preflight',
      superseded.preflightInput,
      'superseded-preflight-b',
    );
    expect(concurrentPreflight).toMatchObject({ type: 'block' });
    if (concurrentPreflight.type === 'block') {
      expect(concurrentPreflight.reason).toContain('then run one fresh canonical preflight');
    }
    recordContextualGmailToolResult({
      sessionId: superseded.sessionId,
      toolUseId: 'superseded-preflight-b',
      toolName: 'mcp__google-contacts__gmail_reply_preflight',
      toolInput: superseded.preflightInput,
      result: 'blocked while a reply was in flight',
      isError: true,
      executed: false,
      objectiveAuthorizationSegments: superseded.objectiveAuthorizationSegments,
    });
    expect(superseded.run(
      'mcp__google-contacts__gmail_reply_preflight',
      superseded.preflightInput,
      'superseded-preflight-still-blocked',
    )).toMatchObject({ type: 'block' });
    superseded.recordBoundResult('superseded-send-a', false);
    expect(superseded.run(
      'mcp__google-contacts__gmail_reply_preflight',
      superseded.preflightInput,
      'superseded-preflight-b-fresh',
    ).type).toBe('allow');
    superseded.recordPreflight('superseded-preflight-b-fresh', supersededB);
    expect(superseded.run(
      'mcp__google-contacts__gmail_reply_bound', superseded.boundInput(supersededA),
    )).toMatchObject({ type: 'block' });
    expect(superseded.run(
      'mcp__google-contacts__gmail_reply_bound', superseded.boundInput(supersededB),
    ).type).toBe('allow');
  });
});
