import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { cleanupModeState, initializeModeState, type PermissionMode } from "../../mode-manager.ts";
import { clearContextualGmailPreflightAttestation, runPreToolUseChecks } from "../pre-tool-use.ts";
import { classifySensitiveExternalAction, isSensitiveExternalActionConfirmationRequestedByObjective } from "../sensitive-external-action.ts";
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
  const silaeConfirmationObjective = [
    'Reprends l’objectif explicite d’écrire à Benoît. Vérifie d’abord Sent/Brouillons pour éviter un doublon, exécute le préflight exact vers benoit@example.test, sans fallback navigateur, puis arrête-toi immédiatement avant l’envoi pour la confirmation d’action externe. Après confirmation, envoie une seule fois et vérifie le messageId.',
  ];

  it('turns an exact requested Silae confirmation boundary into a host prompt, never implicit authority', () => {
    const action = classifySensitiveExternalAction('mcp__google-contacts__gmail_send', {
      to: 'benoit@example.test',
      subject: 'Exemple — compte rendu de démonstration',
      body: 'Message prévalidé',
    });
    expect(action).not.toBeNull();
    expect(action && isSensitiveExternalActionConfirmationRequestedByObjective(
      action,
      silaeConfirmationObjective,
    )).toBeTrue();
    for (const confirmation of [
      'Envoyer maintenant',
      'Envoie l’e-mail à Benoît',
      'Envoie l’e-mail à Benoît maintenant',
      "Envoi l'e-mail à benoît",
    ]) {
      expect(action && isSensitiveExternalActionConfirmationRequestedByObjective(
        action,
        [...silaeConfirmationObjective, confirmation],
      )).toBeTrue();
    }
    expect(action && isSensitiveExternalActionConfirmationRequestedByObjective(action, [
      'N’écris jamais à Alice. Reprends l’objectif explicite d’écrire à Benoît. Vérifie le préflight exact vers benoit@example.test, puis arrête-toi immédiatement avant l’envoi pour confirmation. Après confirmation, envoie une seule fois.',
      'Envoie l’e-mail à Alice.',
    ])).toBeFalse();
    for (const ambiguousAlias of ['Alice', 'Benoît']) {
      expect(action && isSensitiveExternalActionConfirmationRequestedByObjective(action, [
        'Écris à Alice pour lui dire que le dossier avance. Reprends ensuite l’objectif explicite d’écrire à Benoît. Vérifie le préflight exact vers benoit@example.test, puis arrête-toi immédiatement avant l’envoi pour confirmation. Après confirmation, envoie une seule fois.',
        `Envoie l’e-mail à ${ambiguousAlias}.`,
      ])).toBeFalse();
    }

    for (const externalActionPolicy of ['confirm', 'allow-in-execute'] as const) {
      expect(checkMcp(
        'allow-all', 'mcp__google-contacts__gmail_send',
        { to: 'benoit@example.test', subject: 'Exemple — compte rendu de démonstration', body: 'Message prévalidé' },
        'The user answered a preference form.', {
          externalActionPolicy,
          objectiveMutationAuthorized: false,
          objectiveSensitiveActionAuthorized: false,
          objectiveAuthorizationSegments: silaeConfirmationObjective,
        },
      )).toMatchObject({
        type: 'prompt',
        requiresExplicitConfirmation: true,
        sensitiveActionCategory: 'external_send',
        sensitiveActionTargets: ['benoit@example.test'],
      });
    }

    expect(checkMcp(
      'safe', 'mcp__google-contacts__gmail_send',
      { to: 'benoit@example.test', subject: 'Exemple — compte rendu de démonstration', body: 'Message prévalidé' },
      'Poursuis', {
        objectiveMutationAuthorized: false,
        objectiveAuthorizationSegments: silaeConfirmationObjective,
      },
    ).type).toBe('block');
  });
});
