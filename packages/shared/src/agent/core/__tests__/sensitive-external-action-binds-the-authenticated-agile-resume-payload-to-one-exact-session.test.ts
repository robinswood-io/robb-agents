import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { cleanupModeState, initializeModeState, type PermissionMode } from "../../mode-manager.ts";
import { clearContextualGmailPreflightAttestation, runPreToolUseChecks } from "../pre-tool-use.ts";
import { parseStructuredGmailSendResumeSegment, structuredGmailSendAuthorizationDiagnostic } from "../sensitive-external-action.ts";
import { whitelistedPermissionManager } from "./testing/sensitive-external-action-fixture.ts";

const usedSessionIds: string[] = [];
const temporaryPaths: string[] = [];
function checkBash(
  mode: PermissionMode,
  command: string,
  currentUserRequest?: string,
  externalActionPolicy?: 'confirm' | 'allow-in-execute',
  objectiveMutationAuthorized?: boolean,
  objectiveAuthorizationSegments?: readonly string[],
) {
  const sessionId = `sensitive-action-${randomUUID()}`;
  usedSessionIds.push(sessionId);
  initializeModeState(sessionId, mode);
  return runPreToolUseChecks({
    toolName: 'Bash',
    input: { command },
    sessionId,
    permissionMode: mode,
    workspaceRootPath: '/tmp/robb-sensitive-action-test',
    workspaceId: 'sensitive-action-test',
    activeSourceSlugs: [],
    allSourceSlugs: [],
    hasSourceActivation: false,
    externalActionPolicy,
    objectiveMutationAuthorized,
    objectiveAuthorizationSegments,
    permissionManager: whitelistedPermissionManager,
    currentUserRequest,
  });
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

  it('binds the authenticated Agile resume payload to one exact session PDF', () => {
    const liveTool = 'mcp__google-contacts__gmail_send';
    const attachmentPath = '{{SESSION_PATH}}/long_responses/cfacf52c-a192-4cd2-a930-87bebc57b4c0_download.pdf';
    const body = 'Bonjour Ludivine,\n\nVous trouverez la facture en pièce jointe.';
    const agileResumePrompt = `[robb-resume:260918-agile-woods:38940c8bc27546ee414d6e2374737b2c7a6273b5:v2]
Le staging corrigé est actif. Envoie maintenant l’e-mail exact avec l’API Gmail canonique, puis vérifie son résultat réel par cette API.

Payload autorisé :
- From : sender@example.test
- To : office@example.test
- CC : []
- BCC : []
- Sujet : Re: facture FC-02254
- Texte du message : exactement le corps délimité ci-dessous
- Pièces jointes : [${attachmentPath}]
- Signature : n’ajoute manuellement aucune signature au corps

BODY_BEGIN
${body}
BODY_END

Utilise exactement ce payload une seule fois puis vérifie par API le message envoyé.`;
    const payload = parseStructuredGmailSendResumeSegment(agileResumePrompt);
    expect(payload).toEqual({
      from: 'sender@example.test',
      to: 'office@example.test',
      subject: 'Re: facture FC-02254',
      body,
      attachmentPaths: [attachmentPath],
    });
    if (!payload) return;

    for (const malformed of [
      agileResumePrompt.replace(
        '- Signature : n’ajoute manuellement aucune signature au corps',
        '- Signature : n’ajoute manuellement aucune signature au corps\n- Signature : aucune autre signature',
      ),
      agileResumePrompt.replace(
        '- Signature : n’ajoute manuellement aucune signature au corps\n',
        '',
      ),
      agileResumePrompt.replace(
        '- Texte du message : exactement le corps délimité ci-dessous',
        '- Texte du message : exactement le corps délimité ci-dessous\n- Message body: exactly the delimited body below',
      ),
      agileResumePrompt.replace(
        '- Texte du message : exactement le corps délimité ci-dessous\n',
        '',
      ),
    ]) expect(parseStructuredGmailSendResumeSegment(malformed)).toBeUndefined();

    const downloadsPath = '{{SESSION_PATH}}/downloads/facture-FC-02254.pdf';
    expect(parseStructuredGmailSendResumeSegment(
      agileResumePrompt.replace(attachmentPath, downloadsPath),
    )?.attachmentPaths).toEqual([downloadsPath]);

    const exactInput = {
      to: payload.to,
      cc: '',
      bcc: '',
      sendAsEmail: payload.from,
      subject: payload.subject,
      body: payload.body,
      isHtml: false,
      attachmentPaths: [attachmentPath],
      requireKnownContacts: false,
      allowExternal: true,
      checkContacts: false,
      _displayName: 'Envoyer la facture',
      _intent: 'Renvoyer une seule fois le PDF demandé au demandeur explicite.',
    };
    const options = {
      externalActionPolicy: 'allow-in-execute' as const,
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: [agileResumePrompt],
    };
    expect(structuredGmailSendAuthorizationDiagnostic(
      liveTool, exactInput, options.objectiveAuthorizationSegments,
    )).toEqual({ decision: 'authorized', mismatchCategories: [] });
    expect(checkMcp(
      'allow-all', liveTool, exactInput, agileResumePrompt, options,
    )).toMatchObject({
      type: 'modify',
      input: expect.objectContaining({ attachmentPaths: [attachmentPath] }),
    });

    const sessionPath = '/tmp/robb-sensitive-action-test/sessions/260918-agile-woods';
    const expandedAttachmentPath = attachmentPath.replace('{{SESSION_PATH}}', sessionPath);
    const expandedInput = { ...exactInput, attachmentPaths: [expandedAttachmentPath] };
    const expandedOptions = {
      ...options,
      dataFolderPath: `${sessionPath}/data`,
    };
    expect(structuredGmailSendAuthorizationDiagnostic(
      liveTool, expandedInput, options.objectiveAuthorizationSegments,
    )).toEqual({ decision: 'invalid', mismatchCategories: ['attachmentPaths'] });
    expect(checkMcp(
      'allow-all', liveTool, expandedInput, agileResumePrompt, expandedOptions,
    )).toMatchObject({
      type: 'modify',
      input: expect.objectContaining({ attachmentPaths: [expandedAttachmentPath] }),
    });
    for (const [label, expandedPaths] of [
      ['sibling session', [expandedAttachmentPath.replace('260918-agile-woods', '260918-other')]],
      ['lexical alias', [`${sessionPath}/long_responses/../downloads/cfacf52c-a192-4cd2-a930-87bebc57b4c0_download.pdf`]],
      ['different absolute PDF', [`${sessionPath}/long_responses/other.pdf`]],
      ['multiple expanded PDFs', [expandedAttachmentPath, `${sessionPath}/downloads/other.pdf`]],
    ] as const) {
      expect(checkMcp(
        'allow-all', liveTool,
        { ...exactInput, attachmentPaths: expandedPaths },
        agileResumePrompt,
        expandedOptions,
      ), label).toMatchObject({ type: 'block' });
    }
    expect(checkMcp(
      'allow-all', liveTool, expandedInput, agileResumePrompt,
      { ...expandedOptions, dataFolderPath: '/tmp/robb-sensitive-action-test/sessions/260918-other/data' },
    ), 'wrong host-owned session root').toMatchObject({ type: 'block' });
    expect(checkMcp(
      'allow-all', liveTool, expandedInput, agileResumePrompt, options,
    ), 'missing host-owned session root').toMatchObject({ type: 'block' });

    for (const amendment of [
      'Arrête tout maintenant.',
      'N’envoie finalement plus rien.',
      'Le sujet devient : autre facture.',
      'Remplace le corps par un nouveau texte.',
      'La pièce jointe est désormais un autre PDF.',
    ]) {
      const segments = [agileResumePrompt, amendment];
      expect(structuredGmailSendAuthorizationDiagnostic(
        liveTool, exactInput, segments,
      ), amendment).toEqual({
        decision: 'invalid',
        mismatchCategories: ['authorization-boundary'],
      });
    }
    for (const continuation of [
      'Continue.',
      'Reprend.',
      'Poursuis l’analyse et l’optimisation.',
      'Reprends et va réellement jusqu’au bout de la mission.',
      'Continue sans t’arrêter.',
    ]) expect(structuredGmailSendAuthorizationDiagnostic(
      liveTool, exactInput, [agileResumePrompt, continuation],
    )).toEqual({ decision: 'authorized', mismatchCategories: [] });

    const wrongAttachmentDecision = checkMcp(
      'allow-all', liveTool,
      { ...exactInput, attachmentPaths: ['{{SESSION_PATH}}/long_responses/other.pdf'] },
      agileResumePrompt,
      options,
    );
    if (wrongAttachmentDecision.type === 'block') {
      expect(wrongAttachmentDecision.reason).toContain('no values reflected): attachmentPaths');
      expect(wrongAttachmentDecision.reason.includes(attachmentPath)).toBeFalse();
      expect(wrongAttachmentDecision.reason.includes(body)).toBeFalse();
    }
    expect(wrongAttachmentDecision).toMatchObject({ type: 'block' });

    for (const [label, attachmentPaths] of [
      ['empty', []],
      ['different PDF', ['{{SESSION_PATH}}/long_responses/other.pdf']],
      ['multiple', [attachmentPath, '{{SESSION_PATH}}/downloads/other.pdf']],
      ['absolute', ['/tmp/invoice.pdf']],
      ['traversal', ['{{SESSION_PATH}}/long_responses/../downloads/invoice.pdf']],
      ['non-PDF', ['{{SESSION_PATH}}/long_responses/invoice.txt']],
    ] as const) {
      expect(structuredGmailSendAuthorizationDiagnostic(
        liveTool,
        { ...exactInput, attachmentPaths },
        options.objectiveAuthorizationSegments,
      ), label).toEqual({ decision: 'invalid', mismatchCategories: ['attachmentPaths'] });
      expect(checkMcp(
        'allow-all', liveTool, { ...exactInput, attachmentPaths }, agileResumePrompt, options,
      ), label).toMatchObject({ type: 'block' });
    }

    const malformedAttachmentLines = [
      '- Pièces jointes : [/tmp/invoice.pdf]',
      '- Pièces jointes : [{{SESSION_PATH}}/long_responses/../downloads/invoice.pdf]',
      '- Pièces jointes : [{{SESSION_PATH}}/long_responses/invoices//invoice.pdf]',
      '- Pièces jointes : [{{SESSION_PATH}}/long_responses/.hidden.pdf]',
      '- Pièces jointes : [{{SESSION_PATH}}/long_responses/invoice.txt]',
      `- Pièces jointes : [${attachmentPath},{{SESSION_PATH}}/downloads/other.pdf]`,
      `- Pièces jointes : ["${attachmentPath}"]`,
      `- Pièces jointes : [${attachmentPath}]\n- Attachments : []`,
      `- Pièces jointes : [${attachmentPath}]\n- Attachment : [{{SESSION_PATH}}/downloads/other.pdf]`,
    ];
    for (const malformedLine of malformedAttachmentLines) {
      const malformedPrompt = agileResumePrompt.replace(
        `- Pièces jointes : [${attachmentPath}]`,
        malformedLine,
      );
      expect(parseStructuredGmailSendResumeSegment(malformedPrompt), malformedLine).toBeUndefined();
      expect(structuredGmailSendAuthorizationDiagnostic(
        liveTool, exactInput, [malformedPrompt],
      ), malformedLine).toEqual({
        decision: 'invalid',
        mismatchCategories: ['authenticated-contract-unavailable'],
      });
    }
  });

  it('does not prompt when the objective forbids or retargets the external send', () => {
    for (const objectiveAuthorizationSegments of [
      ['N’envoie pas le message à benoit@example.test.'],
      ['Après confirmation, envoie le message à alice@example.com.'],
      ['Analyse ce qui se passe après confirmation quand on envoie à benoit@example.test.'],
      ['Pourquoi après confirmation faut-il envoyer à benoit@example.test ?'],
      ['Après confirmation, le système envoie à benoit@example.test.'],
      [...silaeConfirmationObjective, 'Envoie l’e-mail à Alice.'],
      [...silaeConfirmationObjective, "Envoi l'e-mail à Alice."],
      [...silaeConfirmationObjective, 'Finalement ne fais rien.'],
      [...silaeConfirmationObjective, 'Stop.'],
      [...silaeConfirmationObjective, 'Stop maintenant.'],
      [...silaeConfirmationObjective, 'Arrête tout de suite.'],
      [...silaeConfirmationObjective, 'Cancel now.'],
      [...silaeConfirmationObjective, 'Stop stp.'],
      [...silaeConfirmationObjective, 'Stop maintenant stp.'],
      [...silaeConfirmationObjective, 'Arrête stp.'],
      [...silaeConfirmationObjective, 'Arrête maintenant s’il te plaît.'],
      [...silaeConfirmationObjective, 'Annule tout de suite s’il te plaît.'],
      [...silaeConfirmationObjective, 'Stop now please.'],
      [...silaeConfirmationObjective, 'Ne fais surtout rien.'],
      [...silaeConfirmationObjective, 'Non, stop.'],
      [...silaeConfirmationObjective, 'Stop ! Ne fais rien.'],
      [...silaeConfirmationObjective, 'Ne le fais pas.'],
    ]) {
      expect(checkMcp(
        'allow-all', 'mcp__google-contacts__gmail_send',
        { to: 'benoit@example.test', subject: 'Silaé', body: 'Message' },
        'Poursuis', {
          externalActionPolicy: 'confirm',
          objectiveMutationAuthorized: false,
          objectiveSensitiveActionAuthorized: false,
          objectiveAuthorizationSegments,
        },
      )).toMatchObject({ type: 'block', reason: expect.stringContaining('Objective authority') });
    }
  });

  it('keeps Explore fail-closed', () => {
    expect(checkBash('safe', 'git push origin main', 'Push origin main').type).toBe('block');
  });

  it('prompts before Ask-mode whitelists for a generic continuation', () => {
    const result = checkBash('ask', 'git push origin main', 'Poursuis');
    expect(result.type).toBe('prompt');
    if (result.type === 'prompt') expect(result.requiresExplicitConfirmation).toBeTrue();
  });

  it('prompts in Execute for generic or wrong-target requests', () => {
    const generic = checkBash('allow-all', 'git push origin main', 'Continue please');
    expect(generic.type).toBe('prompt');
    if (generic.type === 'prompt') expect(generic.requiresExplicitConfirmation).toBeTrue();

    expect(checkBash('allow-all', 'git push origin main', 'Push upstream main').type).toBe('prompt');
    expect(checkBash('allow-all', 'git push origin main', 'Do not push origin main').type).toBe('prompt');
    expect(checkBash('allow-all', 'git push origin main', 'Comment pousser origin main ?').type).toBe('prompt');
  });

  it('accepts an explicit action+target without adding a second confirmation', () => {
    expect(checkBash('allow-all', 'git push origin main', 'Push origin main').type).toBe('allow');
    expect(checkBash('allow-all', 'git push origin main', 'Pousse origin main').type).toBe('allow');
    // The mock whitelist proves the dedicated guard also steps aside in Ask
    // once the current request itself authorizes the exact action and target.
    expect(checkBash('ask', 'git push origin main', 'Push origin main').type).toBe('allow');
  });

  it('leaves ordinary local operations alone in Execute', () => {
    expect(checkBash('allow-all', 'bun test', 'Poursuis').type).toBe('allow');
    expect(checkBash('allow-all', 'rm -rf /', 'Poursuis').type).toBe('allow');
  });

  it('allows Gmail preflight without a permission prompt but keeps the actual send gated', () => {
    expect(checkMcp(
      'allow-all',
      'mcp__google-contacts__gmail_send_preflight',
      { to: 'alice@example.com' },
      'Poursuis',
    ).type).toBe('allow');

    expect(checkMcp(
      'allow-all',
      'mcp__google-contacts__gmail_send',
      { to: 'alice@example.com' },
      'Poursuis',
    ).type).toBe('prompt');
  });
});
