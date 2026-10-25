import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { cleanupModeState, initializeModeState, type PermissionMode } from "../../mode-manager.ts";
import { clearContextualGmailPreflightAttestation, runPreToolUseChecks } from "../pre-tool-use.ts";
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

  it("blocks a redundant wait-choice question for an established third-party dependency", () => {
const objective = [
      'Implémente le connecteur ISAGRI vers SharePoint.',
      'Réponds dans le fil que nous attendons l’ouverture de la clé API.',
      'Poursuis.',
    ];

const redundant = checkMcp(
      'allow-all',
      'mcp__session__request_user_input',
      {
        questions: [{
          id: 'agir_next',
          question: 'Que souhaitez-vous faire pendant que nous attendons la clé ISAGRI ?',
          options: [
            { id: 'wait', label: 'Attendre ISAGRI' },
            { id: 'provide', label: 'Fournir la clé' },
          ],
        }],
      },
      'Poursuis.',
      {
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: objective,
      },
    );

expect(redundant).toMatchObject({
      type: 'block',
      reason: expect.stringContaining('already establishes'),
    });

expect(checkMcp(
      'allow-all',
      'session__request_user_input',
      {
        questions: [{
          id: 'session_alias_wait',
          question: 'Faut-il attendre la clé ISAGRI ?',
          options: [{ id: 'yes', label: 'Oui' }, { id: 'no', label: 'Non' }],
        }],
      },
      'Poursuis.',
      {
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: objective,
      },
    )).toMatchObject({ type: 'block' });

const rewordedWait = checkMcp(
      'allow-all',
      'mcp__session__request_user_input',
      {
        questions: [{
          id: 'agir_pause',
          question: 'Quelle suite pour la clé AGIRIS en attente ?',
          options: [
            { id: 'pause', label: 'Suspendre la mission' },
            { id: 'later', label: 'Patienter puis reprendre plus tard' },
          ],
        }],
      },
      'Poursuis.',
      {
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: objective,
      },
    );

expect(rewordedWait).toMatchObject({ type: 'block' });

expect(checkMcp(
      'allow-all',
      'mcp__session__request_user_input',
      {
        questions: [{
          id: 'agir_yes_no',
          question: 'Faut-il attendre la clé ISAGRI ?',
          options: [{ id: 'yes', label: 'Oui' }, { id: 'no', label: 'Non' }],
        }],
      },
      'Poursuis.',
      {
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: objective,
      },
    ).type).toBe('block');

expect(checkMcp(
      'allow-all',
      'mcp__session__request_user_input',
      {
        questions: [{
          id: 'format',
          question: 'Quel format de rapport métier faut-il produire ?',
          options: [{ id: 'pdf', label: 'PDF' }, { id: 'xlsx', label: 'Excel' }],
        }],
      },
      'Poursuis.',
      {
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: objective,
      },
    ).type).not.toBe('block');

expect(checkMcp(
      'allow-all',
      'mcp__session__request_user_input',
      {
        questions: [{
          id: 'substantive_provider_fork',
          question: 'Faut-il attendre la clé ACME ou utiliser un autre fournisseur ?',
          options: [
            { id: 'wait', label: 'Attendre ACME' },
            { id: 'switch', label: 'Changer de fournisseur' },
          ],
        }],
      },
      'Poursuis.',
      {
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: ['Nous attendons la clé API du fournisseur ACME.'],
      },
    ).type).not.toBe('block');

expect(checkMcp(
      'allow-all',
      'mcp__session__request_user_input',
      {
        questions: [{
          id: 'same_provider_follow_up',
          question: 'Faut-il attendre la clé ACME ou relancer le même fournisseur ?',
          options: [
            { id: 'wait', label: 'Attendre ACME' },
            { id: 'follow_up', label: 'Relancer ACME' },
          ],
        }],
      },
      'Poursuis.',
      {
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: ['Nous attendons la clé API du fournisseur ACME.'],
      },
    ).type).toBe('block');

expect(checkMcp(
      'allow-all',
      'mcp__session__request_user_input',
      {
        questions: [{
          id: 'other_vendor',
          question: 'Faut-il attendre la clé du fournisseur ACME ?',
          options: [{ id: 'yes', label: 'Oui' }, { id: 'no', label: 'Non' }],
        }],
      },
      'Poursuis.',
      {
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: objective,
      },
    ).type).not.toBe('block');

expect(checkMcp(
      'allow-all',
      'mcp__session__request_user_input',
      {
        questions: [{
          id: 'microsoft_access',
          question: 'Quel accès Microsoft faut-il utiliser pour la recette ?',
          options: [
            { id: 'admin', label: 'Fournir un accès administrateur' },
            { id: 'reader', label: 'Fournir un accès lecteur' },
          ],
        }],
      },
      'Poursuis.',
      {
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: objective,
      },
    ).type).not.toBe('block');

expect(checkMcp(
      'allow-all',
      'mcp__session__request_user_input',
      {
        questions: [{
          id: 'report_format_while_waiting',
          question: 'Pendant l’attente d’ISAGRI, quel format de rapport faut-il produire ?',
          options: [{ id: 'pdf', label: 'PDF' }, { id: 'xlsx', label: 'Excel' }],
        }],
      },
      'Poursuis.',
      {
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: objective,
      },
    ).type).not.toBe('block');

expect(checkMcp(
      'allow-all',
      'mcp__session__request_user_input',
      {
        questions: [{
          id: 'resolved_dependency',
          question: 'Faut-il attendre la clé ISAGRI ?',
          options: [{ id: 'yes', label: 'Oui' }, { id: 'no', label: 'Non' }],
        }],
      },
      'Poursuis.',
      {
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: [
          ...objective,
          'Nous n’attendons plus la clé ISAGRI : elle a été reçue.',
        ],
      },
    ).type).not.toBe('block');
});
});
