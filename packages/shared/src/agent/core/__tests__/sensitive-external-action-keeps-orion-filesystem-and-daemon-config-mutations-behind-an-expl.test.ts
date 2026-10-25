import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { cleanupModeState, initializeModeState, type PermissionMode } from "../../mode-manager.ts";
import { clearContextualGmailPreflightAttestation, runPreToolUseChecks } from "../pre-tool-use.ts";
import { classifySensitiveExternalAction, isSensitiveExternalActionAuthorizedByObjective, isSensitiveExternalActionConfirmationRequestedByObjective } from "../sensitive-external-action.ts";
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

describe('sensitive external action classifier', () => {
  it('keeps Orion filesystem and daemon-config mutations behind an explicit host prompt', () => {
    const liveObjective = "Corrige end-to-end la régression Orion empêchant la reconnexion des IA sur le VPS Dev. Travaille via la source rbw-servers sur le serveur dev ; cible exacte autorisée : dépôt distant /srv/workspace/orion et service applicatif local orion-agent-bridge. Respecte d’abord toutes les règles locales CLAUDE/Rulebook/BMAD. État observé : https://orion.example.test/parametres charge GET /assistant-api/accounts qui renvoie 503 {error:'bridge_unavailable',accounts:[]}; le conteneur orion-web est healthy image orion-web:7eb4dd2; /etc/systemd/system/orion-agent-bridge.service et /srv/orion-agent-bridge/server.mjs sont absents; docker-compose.orion.yml ne monte aucun socket et n’injecte aucune variable/token; le dépôt contient apps/agent-bridge/server.mjs et apps/agent-bridge/orion-agent-bridge.service, mais cette unité référence User=debian alors que le VPS Dev utilise ubuntu. Diagnostique précisément, implémente le correctif durable sans exposer de secret, mets à jour les tests/BMAD, déploie la révision autorisée, puis vérifie : service/bridge sain, /assistant-api/accounts non-503 et comptes visibles, parcours utilisateur /parametres, révision exécutée identique à la révision testée, et bun run test:orion-production avec succès. Ne déclenche pas de reconnexion OAuth effective si elle nécessite une interaction humaine ; restaure seulement la possibilité de la lancer. Fournis les commandes et preuves finales. Objective binding: objectiveId msg-1789553650945-b9b7b118828a82ab5cce3913f0a96e43 ; acceptanceSha256 3a11c06fc1822ebd12dac15b2ed2c99eb512eb07142659f9931ddd9eea9163f1.";
    const exactLiveSedInput = {
      server: 'dev',
      cwd: '/srv/workspace/orion',
      command: "sed -i 's/User=debian/User=ubuntu/; s/Group=debian/Group=ubuntu/; s#/home/debian/.bun/bin/bun#/home/ubuntu/.bun/bin/bun#' apps/agent-bridge/orion-agent-bridge.service && sed -i \"s#/home/debian/.local/bin/claude#/home/ubuntu/.local/bin/claude#\" apps/agent-bridge/server.mjs && git diff --check && git diff -- apps/agent-bridge/orion-agent-bridge.service apps/agent-bridge/server.mjs",
    };
    const exactLiveSedAction = classifySensitiveExternalAction(
      'mcp__rbw-servers__ssh_execute', exactLiveSedInput,
    );
    expect(exactLiveSedAction?.targetCandidates).toContain('unresolved remote scope');
    expect(exactLiveSedAction && isSensitiveExternalActionConfirmationRequestedByObjective(
      exactLiveSedAction, [liveObjective],
    )).toBeFalse();
    const liveSedInput = {
      ...exactLiveSedInput,
      command: "sed -i 's/User=debian/User=ubuntu/; s/Group=debian/Group=ubuntu/; s#/home/debian/.bun/bin/bun#/home/ubuntu/.bun/bin/bun#' apps/agent-bridge/orion-agent-bridge.service && sed -i \"s#/home/debian/.local/bin/claude#/home/ubuntu/.local/bin/claude#\" apps/agent-bridge/server.mjs",
    };
    const sedAction = classifySensitiveExternalAction(
      'mcp__rbw-servers__ssh_execute', liveSedInput,
    );
    expect(sedAction).toMatchObject({
      category: 'external_mutation',
      targetCandidates: ['dev', 'orion', 'unresolved remote scope'],
      remoteCommand: true,
    });
    expect(sedAction && isSensitiveExternalActionConfirmationRequestedByObjective(
      sedAction, [liveObjective],
    )).toBeFalse();
    const sedPrompt = checkMcp(
      'allow-all', 'mcp__rbw-servers__ssh_execute', liveSedInput, liveObjective, {
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: [liveObjective],
      },
    );
    expect(sedPrompt).toMatchObject({
      type: 'prompt',
      command: liveSedInput.command,
      description: expect.stringContaining('mcp__rbw-servers__ssh_execute'),
      sensitiveActionTargets: ['dev', 'orion', 'unresolved remote scope'],
      requiresExplicitConfirmation: true,
    });

    const serviceInput = {
      server: 'dev', cwd: '/srv/workspace/orion',
      command: 'systemctl restart orion-agent-bridge',
    };
    const serviceAction = classifySensitiveExternalAction(
      'mcp__rbw-servers__ssh_execute_sudo', serviceInput,
    );
    expect(serviceAction).toMatchObject({
      category: 'service_restart', targetCandidates: ['dev', 'orion', 'orion-agent-bridge'],
      remoteCommand: true,
    });
    expect(serviceAction && isSensitiveExternalActionConfirmationRequestedByObjective(
      serviceAction, [liveObjective],
    )).toBeTrue();

    const alreadyAuthorizedObjective = 'La mission Orion est déjà autorisée. Cible exacte : serveur dev, /srv/workspace/orion et uniquement le service orion-agent-bridge. Diagnostique puis corrige durablement le pont ; démarre ou redémarre uniquement orion-agent-bridge si nécessaire dans ce périmètre déjà autorisé, puis vérifie les tests.';
    const serviceStartInput = {
      server: 'dev', cwd: '/srv/workspace/orion',
      command: 'systemctl start orion-agent-bridge',
    };
    const serviceStartAction = classifySensitiveExternalAction(
      'mcp__rbw-servers__ssh_execute_sudo', serviceStartInput,
    );
    expect(serviceStartAction).toMatchObject({
      category: 'service_restart', targetCandidates: ['dev', 'orion', 'orion-agent-bridge'],
      remoteCommand: true,
    });
    expect(serviceStartAction && isSensitiveExternalActionConfirmationRequestedByObjective(
      serviceStartAction, [alreadyAuthorizedObjective],
    )).toBeFalse();
    expect(serviceStartAction && isSensitiveExternalActionAuthorizedByObjective(
      serviceStartAction, [alreadyAuthorizedObjective],
    )).toBeTrue();
    expect(checkMcp(
      'allow-all', 'mcp__rbw-servers__ssh_execute_sudo', serviceStartInput,
      alreadyAuthorizedObjective, {
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: [alreadyAuthorizedObjective],
      },
    ).type).toBe('allow');

    const readOnlyAuthorizationOnly = 'L\'accès SSH en lecture seule est déjà autorisé. Cible exacte : serveur dev, /srv/workspace/orion et uniquement le service orion-agent-bridge. Démarre orion-agent-bridge.';
    expect(serviceStartAction && isSensitiveExternalActionAuthorizedByObjective(
      serviceStartAction, [readOnlyAuthorizationOnly],
    )).toBeFalse();
    expect(serviceStartAction && isSensitiveExternalActionConfirmationRequestedByObjective(
      serviceStartAction, [readOnlyAuthorizationOnly],
    )).toBeTrue();
    for (const unrelatedAuthorization of [
      'L\'accès SSH est déjà autorisé et démarre orion-agent-bridge. Cible exacte : serveur dev, /srv/workspace/orion et uniquement le service orion-agent-bridge.',
      'La consultation des logs est déjà autorisée et démarre orion-agent-bridge. Cible exacte : serveur dev, /srv/workspace/orion et uniquement le service orion-agent-bridge.',
    ]) {
      expect(serviceStartAction && isSensitiveExternalActionAuthorizedByObjective(
        serviceStartAction, [unrelatedAuthorization],
      )).toBeFalse();
      expect(serviceStartAction && isSensitiveExternalActionConfirmationRequestedByObjective(
        serviceStartAction, [unrelatedAuthorization],
      )).toBeTrue();
    }

    const directlyAuthorizedStart = 'Tu es déjà autorisé à démarrer orion-agent-bridge. Cible exacte : serveur dev, /srv/workspace/orion et uniquement le service orion-agent-bridge.';
    expect(serviceStartAction && isSensitiveExternalActionAuthorizedByObjective(
      serviceStartAction, [directlyAuthorizedStart],
    )).toBeTrue();

    const notAuthorizedObjective = 'La mission Orion n’est pas déjà autorisée. Cible exacte : serveur dev, /srv/workspace/orion et uniquement le service orion-agent-bridge. Avant toute action, demande une validation pour démarrer orion-agent-bridge.';
    expect(serviceStartAction && isSensitiveExternalActionAuthorizedByObjective(
      serviceStartAction, [notAuthorizedObjective],
    )).toBeFalse();

    const installInput = {
      server: 'dev', cwd: '/srv/workspace/orion',
      command: 'install -m 644 apps/agent-bridge/orion-agent-bridge.service /etc/systemd/system/orion-agent-bridge.service && systemctl daemon-reload && systemctl enable --now orion-agent-bridge',
    };
    const installAction = classifySensitiveExternalAction(
      'mcp__rbw-servers__ssh_execute_sudo', installInput,
    );
    expect(installAction).toMatchObject({
      category: 'external_mutation',
      targetCandidates: ['dev', 'orion', 'orion-agent-bridge', 'unresolved remote scope'],
      remoteCommand: true,
    });
    expect(installAction && isSensitiveExternalActionConfirmationRequestedByObjective(
      installAction, [liveObjective],
    )).toBeFalse();

    for (const command of [
      'cp -t apps/agent-bridge marker',
      'install -tapps/agent-bridge marker',
      'mv --target-directory=apps/agent-bridge marker',
      'ln --target-directory apps/agent-bridge marker',
    ]) {
      const boundedFileAction = classifySensitiveExternalAction(
        'mcp__rbw-servers__ssh_execute',
        { server: 'dev', cwd: '/srv/workspace/orion', command },
      );
      expect(boundedFileAction?.targetCandidates).toEqual([
        'dev', 'orion', 'unresolved remote scope',
      ]);
      expect(boundedFileAction && isSensitiveExternalActionConfirmationRequestedByObjective(
        boundedFileAction, [liveObjective],
      )).toBeFalse();
    }

    const composeAction = classifySensitiveExternalAction(
      'mcp__rbw-servers__ssh_execute',
      { server: 'dev', cwd: '/srv/workspace/orion', command: 'docker compose up -d orion-web' },
    );
    expect(composeAction).toMatchObject({
      category: 'deployment',
      targetCandidates: ['dev', 'orion', 'orion-web', 'unresolved remote scope'],
    });
    expect(composeAction && isSensitiveExternalActionConfirmationRequestedByObjective(
      composeAction, [liveObjective],
    )).toBeFalse();

    const containerCopyAction = classifySensitiveExternalAction(
      'mcp__rbw-servers__ssh_execute',
      {
        server: 'dev', cwd: '/srv/workspace/orion',
        command: 'docker cp orion-agent-bridge:/payload apps/agent-bridge/payload',
      },
    );
    expect(containerCopyAction?.targetCandidates).toEqual([
      'dev', 'orion', 'orion-agent-bridge', 'unresolved remote scope',
    ]);
    expect(containerCopyAction && isSensitiveExternalActionConfirmationRequestedByObjective(
      containerCopyAction, [liveObjective],
    )).toBeFalse();

    for (const [toolName, input] of [
      ['mcp__rbw-servers__ssh_execute', liveSedInput],
      ['mcp__rbw-servers__ssh_execute_sudo', serviceInput],
      ['mcp__rbw-servers__ssh_execute_sudo', installInput],
    ] as const) {
      for (const externalActionPolicy of ['confirm', 'allow-in-execute'] as const) {
        const decision = checkMcp('allow-all', toolName, input, liveObjective, {
          externalActionPolicy,
          objectiveMutationAuthorized: true,
          objectiveSensitiveActionAuthorized: true,
          objectiveAuthorizationSegments: [liveObjective],
        });
        expect({
          toolName, command: input.command, type: decision.type,
        }).toMatchObject({ type: 'prompt' });
        if (decision.type === 'prompt') expect(decision.requiresExplicitConfirmation).toBeTrue();
      }
    }

    const boundedMarkerInput = {
      server: 'dev', cwd: '/srv/workspace/orion', command: 'touch marker',
    };
    const boundedMarkerAction = classifySensitiveExternalAction(
      'mcp__rbw-servers__ssh_execute', boundedMarkerInput,
    );
    expect(boundedMarkerAction?.targetCandidates).toEqual([
      'dev', 'orion', 'unresolved remote scope',
    ]);
    expect(boundedMarkerAction && isSensitiveExternalActionConfirmationRequestedByObjective(
      boundedMarkerAction, [liveObjective],
    )).toBeFalse();
    for (const nonAuthorizingScope of [
      'Corrige Orion sur le serveur dev ; aucune cible exacte autorisée : dépôt distant /srv/workspace/orion.',
      'Fix Orion on server dev; no exact target authorized: remote repository /srv/workspace/orion.',
      'Corrige Orion sur le serveur dev ; cible exacte autorisée : aucune, dépôt distant /srv/workspace/orion seulement en lecture.',
      'Fix Orion on server dev; exact target authorized: none, remote repository /srv/workspace/orion read-only.',
      'Corrige Orion sur le serveur dev ; sans aucune cible exacte autorisée : dépôt distant /srv/workspace/orion.',
      "Corrige Orion sur le serveur dev ; ceci n'est pas une cible exacte autorisée : /srv/workspace/orion.",
      "Corrige Orion sur le serveur dev ; ce n'est pas une cible exacte autorisée : /srv/workspace/orion.",
      'Corrige Orion sur le serveur dev ; pas une cible exacte autorisée : /srv/workspace/orion.',
      'Fix Orion on server dev; this is not an exact target authorized: /srv/workspace/orion.',
      'Fix Orion on server dev; not an exact target authorized: /srv/workspace/orion.',
    ]) {
      expect(boundedMarkerAction && isSensitiveExternalActionConfirmationRequestedByObjective(
        boundedMarkerAction, [nonAuthorizingScope],
      )).toBeFalse();
      expect(checkMcp(
        'allow-all', 'mcp__rbw-servers__ssh_execute', boundedMarkerInput, nonAuthorizingScope, {
          externalActionPolicy: 'allow-in-execute',
          objectiveMutationAuthorized: true,
          objectiveSensitiveActionAuthorized: true,
          objectiveAuthorizationSegments: [nonAuthorizingScope],
        },
      )).toMatchObject({ type: 'block' });
    }
    for (const toolName of [
      'mcp__other__ssh_execute',
      'mcp__evil__run_command',
      'mcp__rbw_servers__ssh_execute',
      'mcp__rbw-servers__ssh_exec',
      'mcp__rbw-servers__SSH_EXECUTE',
      'mcp__rbw-servers__ssh_execute_extra',
    ]) {
      const foreignAction = classifySensitiveExternalAction(toolName, boundedMarkerInput);
      expect(foreignAction).not.toBeNull();
      if (toolName !== 'mcp__rbw-servers__ssh_execute_extra') {
        expect(foreignAction?.targetCandidates).toEqual(['unresolved remote scope']);
      }
      expect(foreignAction && isSensitiveExternalActionConfirmationRequestedByObjective(
        foreignAction, [liveObjective],
      )).toBeFalse();
      expect(checkMcp('allow-all', toolName, boundedMarkerInput, liveObjective, {
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: [liveObjective],
      })).toMatchObject({ type: 'block' });
    }

    expect(isSensitiveExternalActionConfirmationRequestedByObjective(
      serviceAction!, [liveObjective, 'Poursuis.'],
    )).toBeTrue();
    for (const newerScope of [
      'Finalement autre service.',
      'Sur Zero plutôt.',
      'Autre dépôt finalement.',
      'Analyse le risque.',
      'Vérifie avant.',
      'Ne touche plus au service.',
      'Stoppe la mission.',
      'Annule tout.',
      'Finalement /srv/workspace/zero.',
      'Passe sur Zero.',
      "N'interviens plus sur Orion.",
      'Attends.',
      'Plus tard.',
    ]) {
      expect(isSensitiveExternalActionConfirmationRequestedByObjective(
        serviceAction!, [liveObjective, newerScope],
      )).toBeFalse();
      expect(checkMcp('allow-all', 'mcp__rbw-servers__ssh_execute_sudo', serviceInput, newerScope, {
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: [liveObjective, newerScope],
      })).toMatchObject({ type: 'block' });
    }

    const privateKeyMaterial = '-----BEGIN OPENSSH PRIVATE KEY-----ABC';
    const mixedSecretInput = {
      server: 'dev', cwd: '/srv/workspace/orion',
      command: `printf '%s' '${privateKeyMaterial}' > private_key && systemctl restart orion-agent-bridge`,
    };
    const mixedSecretAction = classifySensitiveExternalAction(
      'mcp__rbw-servers__ssh_execute_sudo', mixedSecretInput,
    );
    expect(mixedSecretAction?.commandPreview).toBe('[Sensitive compound operation — values redacted]');
    expect(mixedSecretAction?.commandPreview).not.toContain(privateKeyMaterial);
    for (const [mode, options] of [
      ['ask', undefined],
      ['allow-all', { externalActionPolicy: 'allow-in-execute' as const }],
    ] as const) {
      const mixedSecretDecision = checkMcp(
        mode, 'mcp__rbw-servers__ssh_execute_sudo', mixedSecretInput,
        'Corrige Orion sur le serveur dev.', options,
      );
      expect(mixedSecretDecision).toMatchObject({
        type: 'block',
        reason: expect.stringContaining('Split it into separate operations'),
      });
      expect(JSON.stringify(mixedSecretDecision)).not.toContain(privateKeyMaterial);
    }

    for (const server of ['prod', 'staging', 'evil', '$SERVER']) {
      const retargetedInput = { ...liveSedInput, server };
      const retargetedAction = classifySensitiveExternalAction(
        'mcp__rbw-servers__ssh_execute', retargetedInput,
      );
      expect(retargetedAction).not.toBeNull();
      expect(retargetedAction && isSensitiveExternalActionConfirmationRequestedByObjective(
        retargetedAction, [liveObjective],
      )).toBeFalse();
      expect(checkMcp('allow-all', 'mcp__rbw-servers__ssh_execute', retargetedInput, liveObjective, {
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: [liveObjective],
      })).toMatchObject({ type: 'block' });
    }
  });
});
