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

  it("blocks wait-choice variants for unavailable third-party credentials", () => {
const objective = [
      'Implémente le connecteur ISAGRI vers SharePoint.',
      'Réponds dans le fil que nous attendons l’ouverture de la clé API.',
      'Poursuis.',
    ];

for (const scenario of [
      {
        pending: 'Nous attendons la clé API du fournisseur ACME.',
        resolved: 'ACME nous a fourni la clé API.',
        question: 'Faut-il attendre la clé ACME ?',
      },
      {
        pending: 'The ACME API key is still pending.',
        resolved: 'ACME provided the API key.',
        question: 'Should we wait for the ACME key?',
      },
      {
        pending: 'Nous attendons la clé API du fournisseur ACME.',
        resolved: 'La clé API ACME est maintenant disponible et prête.',
        question: 'Faut-il attendre la clé ACME ?',
      },
      {
        pending: 'The ACME API key is still pending.',
        resolved: 'The ACME API key is now available and ready.',
        question: 'Should we wait for the ACME key?',
      },
    ]) {
      expect(checkMcp(
        'allow-all',
        'mcp__session__request_user_input',
        {
          questions: [{
            id: 'resolved_dependency_synonym',
            question: scenario.question,
            options: [{ id: 'yes', label: 'Attendre' }, { id: 'no', label: 'Continuer' }],
          }],
        },
        'Poursuis.',
        {
          objectiveMutationAuthorized: true,
          objectiveSensitiveActionAuthorized: true,
          objectiveAuthorizationSegments: [scenario.pending, scenario.resolved],
        },
      ).type).not.toBe('block');
    }

for (const unresolved of [
      'ACME ne nous a pas fourni la clé API.',
      'The ACME API key is not available yet.',
      'The ACME API key is not ready.',
    ]) {
      expect(checkMcp(
        'allow-all',
        'mcp__session__request_user_input',
        {
          questions: [{
            id: 'still_unresolved_dependency',
            question: 'Faut-il attendre la clé ACME ?',
            options: [{ id: 'yes', label: 'Attendre' }, { id: 'no', label: 'Continuer' }],
          }],
        },
        'Poursuis.',
        {
          objectiveMutationAuthorized: true,
          objectiveSensitiveActionAuthorized: true,
          objectiveAuthorizationSegments: [
            'Nous attendons la clé API du fournisseur ACME.',
            unresolved,
          ],
        },
      ).type).toBe('block');
    }

for (const segments of [
      [
        'Nous attendons le token du fournisseur Guardtek.',
        'Si Guardtek fournit le token, continue le déploiement.',
      ],
      [
        'We are waiting for the token from Guardtek.',
        'If Guardtek provides the token, continue the deployment.',
      ],
    ]) {
      expect(checkMcp(
        'allow-all',
        'mcp__session__request_user_input',
        {
          questions: [{
            id: 'conditional_dependency_remains_pending',
            question: 'Faut-il attendre le token Guardtek ?',
            options: [{ id: 'yes', label: 'Attendre' }, { id: 'no', label: 'Continuer' }],
          }],
        },
        'Poursuis.',
        {
          objectiveMutationAuthorized: true,
          objectiveSensitiveActionAuthorized: true,
          objectiveAuthorizationSegments: segments,
        },
      ).type).toBe('block');
    }

for (const segments of [
      [
        'Nous attendons la clé API du fournisseur ACME.',
        'Utilise request_user_input pour me demander s’il faut attendre ACME.',
        'Ne me redemande plus : poursuis tout le travail indépendant.',
      ],
      [
        'We are waiting for the API key from ACME.',
        'Use request_user_input to ask me whether we should wait for ACME.',
        'Do not ask me again; continue all independent work.',
      ],
    ]) {
      expect(checkMcp(
        'allow-all',
        'mcp__session__request_user_input',
        {
          questions: [{
            id: 'revoked_explicit_wait_question',
            question: 'Faut-il attendre la clé ACME ?',
            options: [{ id: 'yes', label: 'Attendre' }, { id: 'no', label: 'Continuer' }],
          }],
        },
        'Poursuis.',
        {
          objectiveMutationAuthorized: true,
          objectiveSensitiveActionAuthorized: true,
          objectiveAuthorizationSegments: segments,
        },
      ).type).toBe('block');
    }

expect(checkMcp(
      'allow-all',
      'mcp__session__request_user_input',
      {
        questions: [{
          id: 'renewed_explicit_wait_question',
          question: 'Faut-il attendre la clé ACME ?',
          options: [{ id: 'yes', label: 'Attendre' }, { id: 'no', label: 'Continuer' }],
        }],
      },
      'Poursuis.',
      {
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: [
          'Nous attendons la clé API du fournisseur ACME.',
          'Ne me redemande plus s’il faut attendre.',
          'Finalement, utilise request_user_input pour me demander s’il faut attendre ACME.',
        ],
      },
    ).type).not.toBe('block');

for (const scenario of [
      {
        objective: 'Nous attendons la clé API de Microsoft.',
        question: 'Faut-il attendre la clé de Microsoft ?',
      },
      {
        objective: 'Le fournisseur Acme doit encore fournir la clé API.',
        question: 'Souhaitez-vous attendre la clé Acme ?',
      },
      {
        objective: 'La clé API ACME est en attente et non reçue.',
        question: 'Faut-il attendre la clé ACME ?',
      },
      {
        objective: 'The ACME API key is pending and has not been received.',
        question: 'Should we wait for the ACME key?',
      },
      {
        objective: 'Nous attendons toujours le token ACME, pas encore obtenu.',
        question: 'Faut-il attendre le token ACME ?',
      },
      {
        objective: 'Nous n’avons pas reçu la clé API d’ACME.',
        question: 'Faut-il attendre la clé ACME ?',
      },
      {
        objective: 'La clé API d’ACME n’a pas encore été reçue.',
        question: 'Faut-il attendre la clé ACME ?',
      },
      {
        objective: 'The ACME API key has not yet arrived.',
        question: 'Should we wait for the ACME key?',
      },
      {
        objective: 'ACME doit nous envoyer la clé API.',
        question: 'Faut-il attendre la clé ACME ?',
      },
      {
        objective: 'La clé API est attendue de la part d’ACME.',
        question: 'Faut-il attendre la clé API d’ACME ?',
      },
      {
        objective: 'Il manque la clé API d’ACME.',
        question: 'Faut-il attendre la clé ACME ?',
      },
      {
        objective: 'ACME has yet to provide the API key.',
        question: 'Should we wait for the ACME key?',
      },
      {
        objective: 'The ACME API key is still outstanding.',
        question: 'Should we wait for the ACME key?',
      },
      {
        objective: 'Nous attendons la clé API du fournisseur acme.',
        question: 'Faut-il attendre cette clé ?',
      },
      {
        objective: 'We are waiting for the API key from acme.',
        question: 'Should we wait for their key?',
      },
      {
        objective: 'Le prestataire foobar doit nous envoyer le token.',
        question: 'Faut-il attendre leur token ?',
      },
    ]) {
      const result = checkMcp(
        'allow-all',
        'mcp__session__request_user_input',
        {
          questions: [{
            id: 'natural_party_wait',
            question: scenario.question,
            options: [{ id: 'yes', label: 'Attendre' }, { id: 'no', label: 'Continuer' }],
          }],
        },
        'Poursuis.',
        {
          objectiveMutationAuthorized: true,
          objectiveSensitiveActionAuthorized: true,
          objectiveAuthorizationSegments: [scenario.objective],
        },
      );
      expect({ ...scenario, ...result }).toMatchObject({ type: 'block' });
    }

for (const question of [
      'Faut-il attendre leur clé ?',
      'Doit-on patienter pour cette clé ?',
      'Should we wait for their key?',
      'Quelle suite pendant cette attente ?',
      'Faut-il simplement patienter ?',
      'Souhaitez-vous que je reste en attente de la clé API Microsoft ?',
      'Voulez-vous que je n’avance pas jusqu’à réception de cette clé ?',
      'Shall I hold off until Microsoft sends the API key?',
      'Do you want me to sit tight until Microsoft provides the API key?',
      'Faut-il rester en stand-by jusqu’à réception de cette clé ?',
    ]) {
      const result = checkMcp(
        'allow-all',
        'session__request_user_input',
        {
          questions: [{
            id: 'anaphoric_wait',
            question,
            options: [{ id: 'yes', label: 'Oui' }, { id: 'no', label: 'Non' }],
          }],
        },
        'Poursuis.',
        {
          objectiveMutationAuthorized: true,
          objectiveSensitiveActionAuthorized: true,
          objectiveAuthorizationSegments: ['Nous attendons la clé API de Microsoft.'],
        },
      );
      expect({ question, ...result }).toMatchObject({ question, type: 'block' });
    }

for (const question of [
      'Do you want me to wait for the long-running test suite or stop it?',
      'Faut-il attendre la fin du build local avant de redémarrer le serveur ?',
      'Should I postpone the database migration until tonight?',
    ]) {
      expect(checkMcp(
        'allow-all',
        'mcp__session__request_user_input',
        {
          questions: [{
            id: 'unrelated_wait_choice',
            question,
            options: [{ id: 'wait', label: 'Wait until later' }, { id: 'continue', label: 'Continue now' }],
          }],
        },
        'Poursuis.',
        {
          objectiveMutationAuthorized: true,
          objectiveSensitiveActionAuthorized: true,
          objectiveAuthorizationSegments: ['Nous attendons la clé API du fournisseur Acme.'],
        },
      ).type).not.toBe('block');
    }

for (const objectiveWithoutParty of [
      'URGENT : nous attendons la clé API.',
      'IMPORTANT : accès en attente.',
      'CLIENT : nous attendons le token.',
    ]) {
      expect(checkMcp(
        'allow-all',
        'mcp__session__request_user_input',
        {
          questions: [{
            id: 'unidentified_party',
            question: 'Faut-il attendre ce tiers ?',
            options: [{ id: 'yes', label: 'Attendre' }, { id: 'no', label: 'Continuer' }],
          }],
        },
        'Poursuis.',
        {
          objectiveMutationAuthorized: true,
          objectiveSensitiveActionAuthorized: true,
          objectiveAuthorizationSegments: [objectiveWithoutParty],
        },
      ).type).not.toBe('block');
    }

for (const resolvedObjective of [
      'Nous ne sommes pas en attente de la clé API ACME.',
      'The ACME API key is not pending.',
      'La clé ACME n’est pas en attente.',
      'Nous ne devons pas attendre la clé API d’ACME.',
      'Sans attendre la clé API d’ACME, continue.',
      'Si nous attendons la clé API d’ACME, le délai sera dépassé.',
      'Without waiting for the ACME API key, continue.',
    ]) {
      expect(checkMcp(
        'allow-all',
        'mcp__session__request_user_input',
        {
          questions: [{
            id: 'not_pending',
            question: 'Faut-il attendre la clé ACME ?',
            options: [{ id: 'yes', label: 'Attendre' }, { id: 'no', label: 'Continuer' }],
          }],
        },
        'Poursuis.',
        {
          objectiveMutationAuthorized: true,
          objectiveSensitiveActionAuthorized: true,
          objectiveAuthorizationSegments: [resolvedObjective],
        },
      ).type).not.toBe('block');
    }
});
});
