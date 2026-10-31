import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { cleanupModeState, initializeModeState, type PermissionMode } from "../../mode-manager.ts";
import { clearContextualGmailPreflightAttestation, recordContextualGmailToolResult, runPreToolUseChecks } from "../pre-tool-use.ts";
import { contextualGmailReplyPreflightAttestationFromObjective, isContextualGmailReplyRequestedByObjective } from "../sensitive-external-action.ts";
import { gmailRecipientBinding, whitelistedPermissionManager } from "./testing/sensitive-external-action-fixture.ts";

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
    ...(options?.externalActionPolicy !== undefined ? { externalActionPolicy: options?.externalActionPolicy } : {}),
    ...(options?.objectiveMutationAuthorized !== undefined ? { objectiveMutationAuthorized: options?.objectiveMutationAuthorized } : {}),
    ...(options?.objectiveSensitiveActionAuthorized !== undefined ? { objectiveSensitiveActionAuthorized: options?.objectiveSensitiveActionAuthorized } : {}),
    ...(options?.objectiveAuthorizationSegments !== undefined ? { objectiveAuthorizationSegments: options?.objectiveAuthorizationSegments } : {}),
    ...(options?.authenticatedUserAuthorizationSegments !== undefined ? { authenticatedUserAuthorizationSegments: options?.authenticatedUserAuthorizationSegments } : {}),
    ...(options?.dataFolderPath !== undefined ? { dataFolderPath: options?.dataFolderPath } : {}),
    ...(options?.declaredToolCapabilities !== undefined ? { declaredToolCapabilities: options?.declaredToolCapabilities } : {}),
    permissionManager: whitelistedPermissionManager,
    ...(currentUserRequest !== undefined ? { currentUserRequest } : {}),
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

  it('inherits the closed PLC reply contract after conclusive duplicate reconciliation', () => {
    const messageId = '1a0a917ea946a540';
    const recipient = 'laurent@example.test';
    const body = [
      'Bonjour Ludovic,',
      '',
      'Nous n’avons à ce stade aucune question qui justifie un temps d’échange. La documentation est suffisamment claire et nous attendons l’ouverture de la clé API.',
      '',
      'Nous reviendrons vers vous dans un second temps si nous avons besoin d’aller plus loin, notamment sur les offres payantes.',
    ].join('\n');
    const root = [
      `Réponds dans le fil Gmail ${messageId}, cible exacte : ${recipient}, From: sender@example.test, CC vide, sujet « RE: Compte-rendu de l’échange du 25/08 - Example Org ».`,
      `Corps exact : «${body}»`,
    ].join('\n');
    const resumedMission = [
      'Le runtime local Robb Agents embarque maintenant le correctif e74fabac0a3ff33d6a953401de2167962d4ce113 ; ce SHA prouve uniquement la version de l’hôte et ne constitue ni une révision distante, ni un artefact métier, ni une autorisation supplémentaire. Reprends maintenant la mission PLC exactement là où elle s’est arrêtée et va jusqu’au résultat vérifié, sans redemander les éléments déjà présents.',
      'Utilise uniquement l’API Gmail, jamais le navigateur.',
      `Réconcilie d’abord par API l’ancre ${messageId} et le fil complet, dans Sent et Drafts, avec pagination complète et comparaison exacte de l’effet autorisé dans ce chat.`,
      'Si un envoi ou un brouillon identique existe, peut exister, ou si la pagination/la lecture reste ambiguë, n’envoie rien et clôture sur cette preuve.',
      'Seulement si l’absence exacte est concluante, exécute au plus une unique réponse liée à cette ancre, avec l’expéditeur, les destinataires, le sujet et le corps exactement autorisés dans le chat, sans signature automatique et sans pièce jointe, puis vérifie le messageId et tous les champs par API.',
      'Ne fabrique ni contenu ni autorisation. Lève seul les blocages techniques couverts par ce runtime et poursuis jusqu’à une fin réellement vérifiée ; ne pose une question que si une décision humaine nouvelle et indispensable subsiste.',
    ].join(' ');
    const objectiveSegments = [root, resumedMission];
    const preflightInput = {
      messageId,
      expectedRecipientEmail: recipient,
      expectedSenderEmail: 'sender@example.test',
      body,
      isHtml: false,
    };
    const options = {
      externalActionPolicy: 'allow-in-execute' as const,
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: objectiveSegments,
    };

    expect(isContextualGmailReplyRequestedByObjective(objectiveSegments)).toBeTrue();
    expect(contextualGmailReplyPreflightAttestationFromObjective(
      'mcp__google-contacts__gmail_reply_preflight', preflightInput, objectiveSegments,
    )).toMatchObject({
      messageId,
      expectedRecipientEmail: recipient,
      expectedSenderEmail: 'sender@example.test',
      expectedCc: '',
      expectedSubject: 'RE: Compte-rendu de l’échange du 25/08 - Example Org',
      body,
      requiresExactEffectReconciliation: true,
    });

    const threadId = '1a0a917ea946a541';
    const operationKey = 'e'.repeat(64);
    const startScenario = () => {
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
        currentUserRequest: resumedMission,
      });
      const observeAnchor = () => recordContextualGmailToolResult({
        sessionId,
        toolUseId: `read-${randomUUID()}`,
        toolName: 'mcp__google-contacts__gmail_get_message',
        toolInput: { messageId },
        result: JSON.stringify({ id: messageId, threadId }),
        isError: false,
        executed: true,
        objectiveAuthorizationSegments: objectiveSegments,
      });
      const recordPreflight = (
        toolUseId: string,
        recipientBinding: string,
        receiptOverrides: Record<string, unknown> = {},
      ) => recordContextualGmailToolResult({
        sessionId,
        toolUseId,
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
          expectedSenderEmail: 'sender@example.test',
          primarySenderEmail: 'sender@example.test',
          subject: 'RE: Compte-rendu de l’échange du 25/08 - Example Org',
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
        objectiveAuthorizationSegments: objectiveSegments,
      });
      return { run, observeAnchor, recordPreflight };
    };

    const successful = startScenario();
    const successfulBinding = gmailRecipientBinding('d');
    successful.observeAnchor();
    expect(successful.run(
      'mcp__google-contacts__gmail_reply_preflight', preflightInput, 'preflight-success',
    ).type).toBe('allow');
    successful.recordPreflight('preflight-success', successfulBinding);
    expect(successful.run('mcp__google-contacts__gmail_reply_bound', {
      ...preflightInput,
      recipientBinding: successfulBinding,
    }).type).toBe('allow');

    // An explicit anchor is not enough for this resumed exact-effect path: the
    // host must have observed the connector's complete Sent + Drafts receipt.
    const withoutReconciliation = startScenario();
    withoutReconciliation.observeAnchor();
    expect(withoutReconciliation.run('mcp__google-contacts__gmail_reply_bound', {
      ...preflightInput,
      recipientBinding: `v1.1789665771.${'f'.repeat(64)}`,
    })).toMatchObject({ type: 'block' });

    const unrecognizedReceipt = startScenario();
    const unrecognizedBinding = gmailRecipientBinding('c');
    unrecognizedReceipt.observeAnchor();
    expect(unrecognizedReceipt.run(
      'mcp__google-contacts__gmail_reply_preflight', preflightInput, 'preflight-unrecognized',
    ).type).toBe('allow');
    unrecognizedReceipt.recordPreflight('preflight-unrecognized', unrecognizedBinding, {
      exactEffectReconciliation: { checked: true, source: 'model_reported_search' },
    });
    expect(unrecognizedReceipt.run('mcp__google-contacts__gmail_reply_bound', {
      ...preflightInput,
      recipientBinding: unrecognizedBinding,
    })).toMatchObject({ type: 'block' });

    const withDraft = startScenario();
    const draftBinding = gmailRecipientBinding('a');
    withDraft.observeAnchor();
    expect(withDraft.run(
      'mcp__google-contacts__gmail_reply_preflight', preflightInput, 'preflight-draft',
    ).type).toBe('allow');
    withDraft.recordPreflight('preflight-draft', draftBinding, {
      ok: false,
      error: 'reply_exact_draft_exists',
      draftExists: true,
      exactEffectReconciliation: {
        checked: true,
        conclusive: true,
        paginationComplete: true,
        source: 'gmail_threads_get_full',
        scopes: ['SENT', 'DRAFT'],
        threadId,
        operationKey,
        candidateCount: 1,
      },
    });
    expect(withDraft.run('mcp__google-contacts__gmail_reply_bound', {
      ...preflightInput,
      recipientBinding: draftBinding,
    })).toMatchObject({ type: 'block' });

    const ambiguousPagination = startScenario();
    const ambiguousBinding = gmailRecipientBinding('b');
    ambiguousPagination.observeAnchor();
    expect(ambiguousPagination.run(
      'mcp__google-contacts__gmail_reply_preflight', preflightInput, 'preflight-paginated',
    ).type).toBe('allow');
    ambiguousPagination.recordPreflight('preflight-paginated', ambiguousBinding, {
      exactEffectReconciliation: {
        checked: true,
        conclusive: false,
        paginationComplete: false,
        source: 'gmail_threads_get_full',
        scopes: ['SENT', 'DRAFT'],
        threadId,
        operationKey,
        candidateCount: 0,
      },
    });
    expect(ambiguousPagination.run('mcp__google-contacts__gmail_reply_bound', {
      ...preflightInput,
      recipientBinding: ambiguousBinding,
    })).toMatchObject({ type: 'block' });

    // The continuation is not standalone authority and it cannot weaken,
    // contradict, or omit the exact anchor carried by the prior contract.
    expect(isContextualGmailReplyRequestedByObjective([resumedMission])).toBeFalse();
    expect(isContextualGmailReplyRequestedByObjective([
      `Réponds-lui au message ${messageId}.`,
      resumedMission,
    ])).toBeFalse();
    expect(isContextualGmailReplyRequestedByObjective([
      root,
      resumedMission.replace(`l’ancre ${messageId}`, 'l’ancre'),
    ])).toBeFalse();
    expect(contextualGmailReplyPreflightAttestationFromObjective(
      'mcp__google-contacts__gmail_reply_preflight', preflightInput, [
        root,
        resumedMission.replace(messageId, '1a0a087bffc71438'),
      ],
    )).toBeUndefined();
    expect(isContextualGmailReplyRequestedByObjective([
      root,
      `${resumedMission} N’envoie rien quoi qu’il arrive.`,
    ])).toBeFalse();
    const exactDuplicateGuard = 'Si un envoi ou un brouillon identique existe, peut exister, ou si la pagination/la lecture reste ambiguë, n’envoie rien et clôture sur cette preuve.';
    for (const revokedGuard of [
      'Si un envoi ou un brouillon identique existe, peut exister, ou si la pagination/la lecture reste ambiguë, n’envoie rien et clôture sur cette preuve et, quoi qu’il arrive, n’envoie rien.',
      'Si un envoi ou un brouillon identique existe, peut exister, ou si la pagination/la lecture reste ambiguë, n’envoie rien et clôture sur cette preuve et n’envoie jamais rien.',
      'Check that the exact effect is absent, then only if absent perform one API reply, and never send anything no matter what.',
      'Check that the exact effect is absent, then only if absent perform one API reply, and whatever happens, never send.',
    ]) {
      const revokedMission = resumedMission.replace(exactDuplicateGuard, revokedGuard);
      expect(revokedMission).not.toBe(resumedMission);
      expect(isContextualGmailReplyRequestedByObjective([root, revokedMission])).toBeFalse();
      expect(contextualGmailReplyPreflightAttestationFromObjective(
        'mcp__google-contacts__gmail_reply_preflight', preflightInput, [root, revokedMission],
      )).toBeUndefined();
      expect(checkMcp(
        'allow-all', 'mcp__google-contacts__gmail_reply_bound', {
          ...preflightInput,
          recipientBinding: `v1.1789665770.${'d'.repeat(64)}`,
        }, revokedMission, {
          ...options,
          objectiveAuthorizationSegments: [root, revokedMission],
        },
      ).type).not.toBe('allow');
    }
    expect(isContextualGmailReplyRequestedByObjective([
      root,
      resumedMission.replace(
        'Seulement si l’absence exacte est concluante',
        'Même si l’absence exacte reste ambiguë',
      ),
    ])).toBeFalse();
    for (const widenedContinuation of [
      resumedMission.replace(
        'au plus une unique réponse liée à cette ancre',
        'deux réponses liées à cette ancre',
      ),
      resumedMission.replace(
        'une unique réponse liée à cette ancre',
        'une unique réponse liée à une autre ancre',
      ),
      resumedMission.replace(
        'Seulement si l’absence exacte est concluante',
        'Même si un envoi ou un brouillon identique existe',
      ),
    ]) {
      expect(widenedContinuation).not.toBe(resumedMission);
      expect(isContextualGmailReplyRequestedByObjective([
        root,
        widenedContinuation,
      ])).toBeFalse();
      expect(contextualGmailReplyPreflightAttestationFromObjective(
        'mcp__google-contacts__gmail_reply_preflight',
        preflightInput,
        [root, widenedContinuation],
      )).toBeUndefined();
    }
  });
});
