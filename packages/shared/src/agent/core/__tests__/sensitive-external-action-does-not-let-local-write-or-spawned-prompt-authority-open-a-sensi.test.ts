import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { cleanupModeState, initializeModeState, type PermissionMode } from "../../mode-manager.ts";
import { clearContextualGmailPreflightAttestation, runPreToolUseChecks } from "../pre-tool-use.ts";
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

  it('does not let local-write or spawned-prompt authority open a sensitive external target', () => {
    const rootLocalObjective = ['Corrige le fichier /tmp/report.md et vérifie le résultat.'];
    expect(checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_send',
      { to: 'alice@example.com', subject: 'Rapport' },
      // Model-visible child prompt is deliberately explicit; only the separate
      // host-authenticated root segments may grant sensitive authority.
      'Envoie le rapport à alice@example.com.',
      {
        externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
        objectiveAuthorizationSegments: rootLocalObjective,
      },
    )).toMatchObject({ type: 'block', reason: expect.stringContaining('exact target') });
    expect(checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_send',
      { to: 'alice@example.com', subject: 'Rapport' }, 'Envoie le rapport à alice@example.com.',
      {
        externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true, objectiveAuthorizationSegments: [],
      },
    )).toMatchObject({ type: 'block', reason: expect.stringContaining('exact target') });
    expect(checkBash(
      'allow-all', 'git push origin main', 'Corrige le fichier',
      'allow-in-execute', true, rootLocalObjective,
    )).toMatchObject({ type: 'block', reason: expect.stringContaining('exact target') });
    expect(checkBash(
      'allow-all', "curl -X POST https://api.example.com/jobs -d '{\"run\":true}'",
      'Corrige le fichier', 'allow-in-execute', true, rootLocalObjective,
    )).toMatchObject({ type: 'block', reason: expect.stringContaining('exact target') });
    expect(checkBash(
      'allow-all', 'npm run deploy -- --environment prod', 'Corrige le fichier',
      'allow-in-execute', true, rootLocalObjective,
    )).toMatchObject({ type: 'block', reason: expect.stringContaining('exact target') });
    expect(checkMcp(
      'allow-all', 'mcp__rbw-servers__ssh_execute',
      { server: 'prod-server', command: 'git push origin main' }, 'Pousse origin main sur prod-server',
      {
        externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
        objectiveAuthorizationSegments: rootLocalObjective,
      },
    )).toMatchObject({ type: 'block', reason: expect.stringContaining('exact target') });
    expect(checkMcp(
      'allow-all', 'mcp__todo__delete_task', { task_id: 'task-7' }, 'Supprime la tâche task-7.',
      {
        externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
        objectiveAuthorizationSegments: rootLocalObjective,
      },
    )).toMatchObject({ type: 'block', reason: expect.stringContaining('exact target') });
    expect(checkMcp(
      'allow-all', 'api_jobs', { method: 'DELETE', path: '/jobs/7' }, 'Supprime /jobs/7.',
      {
        externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
        objectiveAuthorizationSegments: rootLocalObjective,
      },
    )).toMatchObject({ type: 'block', reason: expect.stringContaining('exact target') });
  });

  it('allows only a matching action and target from one authenticated objective segment', () => {
    expect(checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_send',
      { to: 'alice@example.com', subject: 'Rapport' }, 'Poursuis',
      {
        externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
        objectiveAuthorizationSegments: ['Envoie le rapport à alice@example.com.', 'Poursuis.'],
      },
    ).type).toBe('allow');
    expect(checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_send',
      { to: 'alice@example.com', bcc: 'other@example.com', subject: 'Rapport' }, 'Poursuis',
      {
        externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
        objectiveAuthorizationSegments: ['Envoie le rapport à alice@example.com.', 'Poursuis.'],
      },
    )).toMatchObject({ type: 'block', reason: expect.stringContaining('exact target') });
    expect(checkBash(
      'allow-all', 'git push origin main', 'Poursuis', 'allow-in-execute', true,
      ['Pousse origin main après les tests.', 'Poursuis.'],
    ).type).toBe('allow');
    expect(checkBash(
      'allow-all', "curl -X POST https://api.example.com/jobs -d '{\"run\":true}'",
      'Poursuis', 'allow-in-execute', true,
      ['Effectue le POST vers api.example.com.', 'Poursuis.'],
    ).type).toBe('allow');
    expect(checkBash(
      'allow-all', 'npm run deploy -- --environment prod', 'Poursuis', 'allow-in-execute', true,
      ['Déploie la version sur prod.', 'Poursuis.'],
    ).type).toBe('allow');
    expect(checkMcp(
      'allow-all', 'mcp__rbw-servers__ssh_execute',
      { server: 'prod-server', command: 'git push origin main' }, 'Poursuis',
      {
        externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
        objectiveAuthorizationSegments: ['Pousse origin main sur prod-server.', 'Poursuis.'],
      },
    )).toMatchObject({ type: 'prompt', requiresExplicitConfirmation: true });
    expect(checkMcp(
      'allow-all', 'mcp__todo__delete_task', { task_id: 'task-7' }, 'Poursuis',
      {
        externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
        objectiveAuthorizationSegments: ['Supprime la tâche task-7.', 'Poursuis.'],
      },
    ).type).toBe('allow');
    expect(checkMcp(
      'allow-all', 'api_jobs', { method: 'DELETE', path: '/jobs/7' }, 'Poursuis',
      {
        externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
        objectiveAuthorizationSegments: ['Supprime la ressource /jobs/7.', 'Poursuis.'],
      },
    ).type).toBe('allow');
    expect(checkMcp(
      'allow-all', 'api_jobs', { method: 'DELETE', path: '/jobs/7', id: '7' }, 'Poursuis',
      {
        externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
        objectiveAuthorizationSegments: ['Delete job 7.', 'Poursuis.'],
      },
    ).type).toBe('allow');
    expect(checkMcp(
      'allow-all', 'api_todos', { method: 'PATCH', path: '/todos/task-7', id: 'task-7' }, 'Poursuis',
      {
        externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
        objectiveAuthorizationSegments: ['Update task task-7.', 'Poursuis.'],
      },
    ).type).toBe('allow');
    expect(checkMcp(
      'allow-all', 'mcp__todo__update_task', { task_id: 'task-7' }, 'Poursuis',
      {
        externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
        objectiveAuthorizationSegments: ['Supprime la tâche task-7.'],
      },
    )).toMatchObject({ type: 'block', reason: expect.stringContaining('exact target') });
    expect(checkMcp(
      'allow-all', 'mcp__todo__delete_task', { task_id: 'task-7' }, 'Poursuis',
      {
        externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
        objectiveAuthorizationSegments: ['Supprime la tâche task-7.', 'Mets plutôt à jour la tâche task-7.'],
      },
    )).toMatchObject({ type: 'block', reason: expect.stringContaining('exact target') });

    // Never combine the target from one amendment with the action from another.
    expect(checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_send',
      { to: 'alice@example.com', subject: 'Rapport' }, 'Envoie le rapport',
      {
        externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
        objectiveAuthorizationSegments: ['Corrige le contact alice@example.com.', 'Envoie le rapport.'],
      },
    ).type).toBe('block');
    // The newest category-bearing amendment retargets and revokes the older target.
    expect(checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_send',
      { to: 'alice@example.com', subject: 'Rapport' }, 'Envoie plutôt à bob@example.com',
      {
        externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
        objectiveAuthorizationSegments: [
          'Envoie le rapport à alice@example.com.',
          'Envoie plutôt le rapport à bob@example.com.',
        ],
      },
    ).type).toBe('block');

    for (const amendment of [
      'Actually, to bob@example.com instead.',
      'Finalement à bob@example.com.',
      'Wait, wrong recipient: bob@example.com.',
    ]) {
      expect(checkMcp(
        'allow-all', 'mcp__google-contacts__gmail_send',
        { to: 'alice@example.com', subject: 'Rapport' }, amendment,
        {
          externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
          objectiveAuthorizationSegments: [
            'Send the report to alice@example.com.',
            amendment,
          ],
        },
      )).toMatchObject({ type: 'block', reason: expect.stringContaining('exact target') });
    }

    for (const amendment of [
      'Change the report to the final version.',
      'Wait for the build to finish.',
    ]) {
      expect(checkMcp(
        'allow-all', 'mcp__google-contacts__gmail_send',
        { to: 'alice@example.com', subject: 'Rapport' }, amendment,
        {
          externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
          objectiveAuthorizationSegments: [
            'Send the report to alice@example.com.',
            amendment,
          ],
        },
      ).type).toBe('allow');
    }

    expect(checkMcp(
      'allow-all', 'mcp__todo__find_or_delete_task',
      { task_id: 'task-7' }, 'Poursuis',
      {
        externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
        objectiveAuthorizationSegments: ['Inspecte la tâche task-7.', 'Poursuis.'],
      },
    )).toMatchObject({ type: 'block', reason: expect.stringContaining('exact target') });
  });

  it('keeps constraints local while negative and retargeting amendments revoke stale authority', () => {
    const liveObjective = 'Applique le correctif minimal strictement borné à Zero et au compte/test administrateur prévu, sans affaiblir l’authentification générale.';
    expect(checkMcp(
      'allow-all', 'mcp__rbw-servers__ssh_upload', {
        server: 'dev', localPath: '/tmp/patch.py', remotePath: '/srv/workspace/zero/patch.py',
      }, liveObjective, {
        externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
        objectiveAuthorizationSegments: [liveObjective],
      },
    )).toMatchObject({ type: 'block', reason: expect.stringContaining('exact target') });

    expect(checkBash(
      'allow-all', 'npm run deploy -- --environment prod',
      'Déploie prod sans redémarrer le service.', 'allow-in-execute', true,
      ['Déploie prod sans redémarrer le service.'],
    ).type).toBe('allow');
    expect(checkBash(
      'allow-all', 'systemctl restart Zero',
      'Déploie prod sans redémarrer Zero.', 'allow-in-execute', true,
      ['Déploie prod sans redémarrer Zero.'],
    )).toMatchObject({ type: 'block', reason: expect.stringContaining('exact target') });
    expect(checkBash(
      'allow-all', 'npm run deploy -- --environment prod',
      'Ne redémarre pas Zero; déploie prod.', 'allow-in-execute', true,
      ['Ne redémarre pas Zero; déploie prod.'],
    ).type).toBe('allow');

    for (const request of ['Pas de deploy prod.', 'Sans aucun deploy prod.', 'without any deploy prod.']) {
      expect(checkBash(
        'allow-all', 'npm run deploy -- --environment prod', request,
        'allow-in-execute', true, [request],
      )).toMatchObject({ type: 'block', reason: expect.stringContaining('exact target') });
    }

    expect(checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_send',
      { to: 'bob@example.com', subject: 'Rapport' }, 'N’envoie pas à bob@example.com.', {
        externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
        objectiveAuthorizationSegments: ['Envoie à bob@example.com.', 'N’envoie pas à bob@example.com.'],
      },
    )).toMatchObject({ type: 'block', reason: expect.stringContaining('exact target') });

    const remoteInput = { server: 'dev', cwd: '/srv/workspace/zero', command: 'touch marker' };
    for (const amendment of [
      'Implante plutôt sur Other.',
      'Implante la version Other.',
      'Apply it to Other.',
      'Fix Other instead.',
      'Ne modifie pas Zero.',
    ]) {
      expect(checkMcp(
        'allow-all', 'mcp__rbw-servers__ssh_execute', remoteInput, amendment, {
          externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
          objectiveAuthorizationSegments: ['Corrige Zero sur le serveur dev.', amendment],
        },
      )).toMatchObject({ type: 'block', reason: expect.stringContaining('exact target') });
    }
    expect(checkMcp(
      'allow-all', 'mcp__rbw-servers__ssh_execute', remoteInput, 'Continue les tests.', {
        externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
        objectiveAuthorizationSegments: ['Corrige Zero sur le serveur dev.', 'Continue les tests.'],
      },
    )).toMatchObject({ type: 'prompt', requiresExplicitConfirmation: true });

    for (const amendment of [
      'Recipient: bob@example.com.',
      'To bob@example.com.',
      'À bob@example.com.',
      'Use bob@example.com.',
      'Bob instead.',
    ]) {
      expect(checkMcp(
        'allow-all', 'mcp__google-contacts__gmail_send',
        { to: 'alice@example.com', subject: 'Rapport' }, amendment, {
          externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
          objectiveAuthorizationSegments: ['Send the report to alice@example.com.', amendment],
        },
      )).toMatchObject({ type: 'block', reason: expect.stringContaining('exact target') });
    }
  });

  it('keeps confirmation as the default and explicit policy', () => {
    expect(checkBash('allow-all', 'git push origin main', 'Poursuis').type).toBe('prompt');
    expect(checkBash(
      'allow-all',
      'git push origin main',
      'Poursuis',
      'confirm',
    ).type).toBe('prompt');
  });
});
