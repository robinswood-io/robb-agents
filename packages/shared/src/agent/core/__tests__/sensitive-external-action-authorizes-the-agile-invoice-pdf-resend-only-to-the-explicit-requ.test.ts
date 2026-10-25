import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { cleanupModeState, initializeModeState, type PermissionMode } from "../../mode-manager.ts";
import { clearContextualGmailPreflightAttestation, runPreToolUseChecks } from "../pre-tool-use.ts";
import { classifySensitiveExternalAction, isSensitiveExternalActionAuthorizedByObjective, isSensitiveExternalActionExplicitlyAuthorized } from "../sensitive-external-action.ts";
import { whitelistedPermissionManager } from "./testing/sensitive-external-action-fixture.ts";

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

  it('authorizes the Agile invoice PDF resend only to the explicit requester', () => {
    const liveObjective = [
      'Traite la demande par email de facture',
      'External',
      'Boîte de réception',
      '',
      'Ludivine COMBAZ <office@example.test>',
      'jeu. 17 sept. 15:45 (il y a 17 heures)',
      'À sender@example.test',
      '',
      "qui demande le renvoi d'une facture par mail en pdf",
    ].join('\n');
    const liveInput = {
      to: 'office@example.test',
      sendAsEmail: 'sender@example.test',
      subject: 'Re: facture FC-02254',
      body: 'Bonjour Ludivine,\n\nVous trouverez la facture en pièce jointe.',
      attachmentPaths: ['{{SESSION_PATH}}/long_responses/cfacf52c_download.pdf'],
      requireKnownContacts: false,
      allowExternal: true,
      checkContacts: false,
      _displayName: 'Envoyer la facture',
      _intent: 'Renvoyer le PDF demandé au demandeur explicite.',
    };
    const liveAction = classifySensitiveExternalAction(
      'mcp__google-contacts__gmail_send',
      liveInput,
    );
    expect(liveAction).toMatchObject({
      category: 'external_send',
      targetCandidates: ['office@example.test'],
      boundedSessionPdfAttachment: true,
    });
    expect(liveAction && isSensitiveExternalActionExplicitlyAuthorized(
      liveAction,
      liveObjective,
    )).toBeTrue();
    expect(liveAction && isSensitiveExternalActionAuthorizedByObjective(
      liveAction,
      [liveObjective],
    )).toBeTrue();
    expect(checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_send', liveInput, liveObjective, {
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: [liveObjective],
      },
    )).toMatchObject({
      type: 'modify',
      input: expect.not.objectContaining({
        _displayName: expect.anything(),
        _intent: expect.anything(),
      }),
    });

    for (const objective of [
      'Prends en charge l’e-mail reçu de Alice <alice@example.com> qui demande de renvoyer la facture en PDF par mail.',
      'Handle the invoice email request from alice@example.com asking you to resend the invoice as a PDF by email.',
      'Please process the email invoice request from alice@example.com requesting you to send it again as a PDF by email.',
    ]) {
      const input = { ...liveInput, to: 'alice@example.com' };
      const action = classifySensitiveExternalAction('mcp__google-contacts__gmail_send', input);
      expect(action && isSensitiveExternalActionAuthorizedByObjective(action, [objective])).toBeTrue();
    }

    for (const objective of [
      'Envoie la facture PDF à alice@example.com.',
      'Send the invoice PDF to alice@example.com by email.',
    ]) {
      const input = { ...liveInput, to: 'alice@example.com' };
      const action = classifySensitiveExternalAction('mcp__google-contacts__gmail_send', input);
      expect(action && isSensitiveExternalActionAuthorizedByObjective(action, [objective])).toBeTrue();
    }

    for (const [label, input] of [
      ['wrong requester', { ...liveInput, to: 'sender@example.test' }],
      ['extra CC', { ...liveInput, cc: 'other@example.com' }],
      ['missing attachment', { ...liveInput, attachmentPaths: [] }],
      ['two attachments', { ...liveInput, attachmentPaths: [
        '{{SESSION_PATH}}/long_responses/invoice.pdf',
        '{{SESSION_PATH}}/long_responses/other.pdf',
      ] }],
      ['absolute attachment', { ...liveInput, attachmentPaths: ['/tmp/invoice.pdf'] }],
      ['non-PDF attachment', { ...liveInput, attachmentPaths: ['{{SESSION_PATH}}/long_responses/invoice.txt'] }],
    ] as const) {
      const action = classifySensitiveExternalAction('mcp__google-contacts__gmail_send', input);
      expect({ label, authorized: !!action
        && isSensitiveExternalActionAuthorizedByObjective(action, [liveObjective]) })
        .toEqual({ label, authorized: false });
      expect(checkMcp(
        'allow-all', 'mcp__google-contacts__gmail_send', input, liveObjective, {
          externalActionPolicy: 'allow-in-execute',
          objectiveMutationAuthorized: true,
          objectiveSensitiveActionAuthorized: true,
          objectiveAuthorizationSegments: [liveObjective],
        },
      )).toMatchObject({ type: 'block' });
    }

    for (const objective of [
      'Analyse la demande par email qui demande le renvoi d’une facture PDF par mail.',
      'Traite la demande par email qui demande pourquoi le renvoi de la facture PDF a échoué.',
      'Traite la demande par email qui demande le renvoi de la facture PDF, mais ne la renvoie pas.',
      'Handle the invoice email request asking you not to resend the PDF invoice.',
      'Envoie le rapport PDF à office@example.test.',
    ]) {
      expect(liveAction && isSensitiveExternalActionAuthorizedByObjective(
        liveAction,
        [objective],
      )).toBeFalse();
    }
  });

  it('binds a signed paper-strategy write to one exact OSS source path', () => {
    const toolName = 'mcp__rbw-agents-oss__oss_write_file';
    const path = '/srv/rbw-agents-oss/scripts/fixture_paper_metrics_v1.py';
    const objective = `[robb-resume:test-bounded-write:2222222222222222222222222222222222222222:v2]
Poursuis l’amélioration de la stratégie exclusivement dans l’environnement paper/sandbox via la source structurée \`rbw-agents-oss\`.
Source OSS exacte autorisée : \`rbw-agents-oss\`.
Fichier OSS exact autorisé en écriture atomique : \`${path}\`.
Lis d’abord son hash, écris uniquement ce fichier, exécute les tests hors réseau et conserve un retour arrière. Aucun autre fichier, source, ordre, broker, capital live ou déploiement n’est autorisé.`;
    const input = { path, content: '#!/usr/bin/env python3\nprint("bounded")\n' };
    const action = classifySensitiveExternalAction(toolName, input);
    expect(action).toMatchObject({
      category: 'external_mutation',
      targetCandidates: [path],
      boundedOssAtomicWrite: true,
    });
    expect(action && isSensitiveExternalActionAuthorizedByObjective(
      action,
      [objective],
    )).toBeTrue();
    expect(action && isSensitiveExternalActionAuthorizedByObjective(
      action,
      [objective, 'Continue sans t’arrêter.'],
    )).toBeTrue();
    for (const progressFollowUp of [
      'Où en es-tu ?',
      'Quel est le statut ?',
      'Fais-moi un point d’avancement.',
      'Merci',
    ]) {
      expect(action && isSensitiveExternalActionAuthorizedByObjective(
        action,
        [objective, progressFollowUp],
      )).toBeTrue();
      expect(checkMcp('allow-all', toolName, input, progressFollowUp, {
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: false,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: [objective, progressFollowUp],
      })).toMatchObject({ type: 'block' });
      expect(action && isSensitiveExternalActionAuthorizedByObjective(
        action,
        [objective, progressFollowUp, 'Continue sans t’arrêter.'],
      )).toBeTrue();
    }
    expect(checkMcp('allow-all', toolName, input, 'Continue sans t’arrêter.', {
      externalActionPolicy: 'allow-in-execute',
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: [
        objective,
        'Où en es-tu ?',
        'Continue sans t’arrêter.',
      ],
    }).type).not.toBe('block');
    for (const substantiveFollowUp of [
      'Quel est le statut de l’autre projet ?',
      'Où en est la source other-source ?',
      'Quel est le statut de `/srv/rbw-agents-oss/scripts/fixture_paper_metrics_v2.py` ?',
      'Merci, travaille plutôt sur un autre projet.',
    ]) {
      expect(action && isSensitiveExternalActionAuthorizedByObjective(
        action,
        [objective, substantiveFollowUp, 'Continue sans t’arrêter.'],
      )).toBeFalse();
    }
    expect(checkMcp('allow-all', toolName, input, objective, {
      externalActionPolicy: 'allow-in-execute',
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: [objective],
    }).type).not.toBe('block');
    expect(checkMcp('allow-all', toolName, input, objective, {
      externalActionPolicy: 'allow-in-execute',
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: [objective],
      sessionId: 'test-copied-session',
    })).toMatchObject({
      type: 'block',
      reason: expect.stringContaining('belongs to another durable session'),
    });
    expect(checkMcp('allow-all', toolName, input, objective, {
      externalActionPolicy: 'allow-in-execute',
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: [objective],
      sessionId: 'test-copied-session',
      declaredToolCapabilities: {
        trusted: true,
        readOnly: true,
        destructive: false,
      },
    })).toMatchObject({
      type: 'block',
      reason: expect.stringContaining('belongs to another durable session'),
    });

    for (const [label, candidateTool, candidateInput] of [
      ['sibling', toolName, { ...input, path: '/srv/rbw-agents-oss/scripts/fixture_paper_metrics_v2.py' }],
      ['traversal', toolName, { ...input, path: '/srv/rbw-agents-oss/scripts/tmp/../fixture_paper_metrics_v1.py' }],
      ['variable', toolName, { ...input, path: '${OSS_ROOT}/scripts/fixture_paper_metrics_v1.py' }],
      ['glob', toolName, { ...input, path: '/srv/rbw-agents-oss/scripts/*.py' }],
      ['other source', 'mcp__other-source__oss_write_file', input],
      ['expanded input', toolName, { ...input, target: path }],
    ] as const) {
      const candidate = classifySensitiveExternalAction(candidateTool, candidateInput);
      expect({ label, authorized: !!candidate && isSensitiveExternalActionAuthorizedByObjective(
        candidate,
        [objective],
      ) }).toEqual({ label, authorized: false });
      expect(checkMcp('allow-all', candidateTool, candidateInput, objective, {
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: [objective],
      })).toMatchObject({ type: 'block' });
    }

    for (const forbiddenPath of [
      '/etc/sudoers',
      '/root/.ssh/authorized_keys',
      '/srv/rbw-agents-oss/.env',
      '/srv/rbw-agents-oss/scripts/.env',
      '/srv/rbw-agents-oss/scripts/credentials/service.json',
      '/srv/rbw-agents-oss/scripts/token.json',
      '/srv/rbw-agents-oss/scripts/api_key.txt',
      '/srv/rbw-agents-oss/scripts/password.txt',
      '/srv/rbw-agents-oss/scripts/auth.json',
      '/srv/rbw-agents-oss/scripts/.npmrc',
      '/srv/rbw-agents-oss/scripts/service.pem',
    ]) {
      const forbiddenInput = { ...input, path: forbiddenPath };
      const forbiddenObjective = objective.replace(path, forbiddenPath);
      const forbiddenAction = classifySensitiveExternalAction(toolName, forbiddenInput);
      expect(forbiddenAction?.boundedOssAtomicWrite).toBeUndefined();
      expect(forbiddenAction && isSensitiveExternalActionAuthorizedByObjective(
        forbiddenAction,
        [forbiddenObjective],
      )).toBeFalse();
      expect(checkMcp('allow-all', toolName, forbiddenInput, forbiddenObjective, {
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: [forbiddenObjective],
      })).toMatchObject({ type: 'block' });
    }

    const quotedContract = `Analyse le prompt suivant pour expliquer ses risques :
${objective}`;
    expect(action && isSensitiveExternalActionAuthorizedByObjective(
      action,
      ['Corrige le déploiement de test et vérifie-le.', quotedContract],
    )).toBeFalse();
    expect(checkMcp('allow-all', toolName, input, quotedContract, {
      externalActionPolicy: 'allow-in-execute',
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: [
        'Corrige le déploiement de test et vérifie-le.',
        quotedContract,
      ],
      sessionId: 'test-bounded-write',
    })).toMatchObject({ type: 'block' });

    for (const invalidObjective of [
      `[robb-resume:test-other-mission:2222222222222222222222222222222222222222:v2]\nPoursuis une autre mission dans son propre périmètre.`,
      objective.replace(path, '/srv/rbw-agents-oss/scripts/fixture_paper_metrics_v2.py'),
      objective.replace(path, '${OSS_ROOT}/scripts/fixture_paper_metrics_v1.py'),
      `${objective}\nN’écris finalement pas ce fichier.`,
      `${objective}\nSource OSS exacte autorisée : \`other-source\`.`,
      `${objective}\nUtilise désormais une autre source.`,
      `${objective}\nTravaille plutôt sur \`/srv/rbw-agents-oss/scripts/fixture_paper_metrics_v2.py\`.`,
    ]) {
      expect(action && isSensitiveExternalActionAuthorizedByObjective(
        action,
        [invalidObjective],
      )).toBeFalse();
      expect(checkMcp('allow-all', toolName, input, invalidObjective, {
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: [invalidObjective],
      })).toMatchObject({ type: 'block' });
    }

    expect(action && isSensitiveExternalActionAuthorizedByObjective(
      action,
      [objective, 'Travaille plutôt sur un autre projet.'],
    )).toBeFalse();

    const secondPath = '/srv/rbw-agents-oss/scripts/audits/paper_snapshot_v2.py';
    const secondObjective = `[robb-resume:test-second-write:3333333333333333333333333333333333333333:v3]
Source OSS exacte autorisée : \`rbw-agents-oss\`.
Fichier OSS exact autorisé en écriture atomique : \`${secondPath}\`.
Écris uniquement cet artefact OSS, puis vérifie-le sans réseau.`;
    const secondInput = { path: secondPath, content: 'print("second contract")\n' };
    const secondAction = classifySensitiveExternalAction(toolName, secondInput);
    expect(secondAction).toMatchObject({
      category: 'external_mutation',
      targetCandidates: [secondPath],
      boundedOssAtomicWrite: true,
    });
    expect(secondAction && isSensitiveExternalActionAuthorizedByObjective(
      secondAction,
      [secondObjective],
    )).toBeTrue();
    expect(action && isSensitiveExternalActionAuthorizedByObjective(
      action,
      [secondObjective],
    )).toBeFalse();
    expect(secondAction && isSensitiveExternalActionAuthorizedByObjective(
      secondAction,
      [objective],
    )).toBeFalse();
  });
});
