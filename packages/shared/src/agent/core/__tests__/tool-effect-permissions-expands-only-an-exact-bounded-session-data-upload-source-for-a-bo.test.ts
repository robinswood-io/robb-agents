import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { permissionsConfigCache } from '../../permissions-config.ts';
import { cleanupModeState, setPermissionMode } from '../../mode-manager.ts';
import { beginObjectiveEvidenceGate, clearObjectiveEvidenceGate } from '../objective-evidence-gate.ts';
import { classifyToolEffect, runPreToolUseChecks, type PermissionManagerLike, type PreToolUseInput } from '../pre-tool-use.ts';

const liveSessions: string[] = [];
const workspaceRootPath = mkdtempSync(join(tmpdir(), 'robb-tool-effect-'));
// Keep these tests independent of the user's installed default permissions.
writeFileSync(join(workspaceRootPath, 'permissions.json'), JSON.stringify({
  allowedBashPatterns: [
    '^pwd$', '^ls(?:\\s|$)',
    '^git\\s+(?:-C\\s+(?!-)[^\\s]+\\s+)?(?:branch|grep|log|ls-files|merge-base|rev-parse)\\b',
    '^sed\\s+-n\\b',
  ],
  allowedMcpPatterns: [
    '^mcp__rbw-servers__inspect_record$',
    '^mcp__crm__(?:search|check)',
    '^mcp__google-contacts__.*_preflight$',
  ],
}));
afterAll(() => {
  permissionsConfigCache.invalidateWorkspace(workspaceRootPath);
  rmSync(workspaceRootPath, { recursive: true, force: true });
});
const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] ?? command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
};
afterEach(() => {
  for (const sessionId of liveSessions.splice(0)) {
    clearObjectiveEvidenceGate(sessionId);
    cleanupModeState(sessionId);
  }
});
function check(overrides: Partial<PreToolUseInput>, highStakesObjective?: string) {
  const sessionId = `tool-effect-${randomUUID()}`;
  liveSessions.push(sessionId);
  const permissionMode = overrides.permissionMode ?? 'ask';
  setPermissionMode(sessionId, permissionMode, { changedBy: 'restore' });
  if (highStakesObjective) {
    beginObjectiveEvidenceGate(sessionId, `${sessionId}-objective`, highStakesObjective, {
      risk: 'high-stakes', evidenceRequirement: 'authoritative-sources-before-mutation', domain: 'legal',
    });
  }
  return runPreToolUseChecks({
    toolName: 'mcp__rbw-servers__ssh_execute',
    input: { command: 'pwd' },
    sessionId,
    permissionMode,
    workspaceRootPath,
    workspaceId: 'tool-effect-workspace',
    activeSourceSlugs: ['rbw-servers'],
    allSourceSlugs: ['rbw-servers'],
    hasSourceActivation: false,
    permissionManager,
    ...overrides,
  });
}

describe('typed tool effects', () => {
it('expands only an exact bounded session-data upload source for a bounded recovery', () => {
    const objective = `[robb-resume:test-upload-session:4444444444444444444444444444444444444444:v2]
Cible exacte : serveur dev et racine /srv/workspace/.worktrees/example-feature-worktree. La copie de travail de session est \`{{SESSION_PATH}}/data/example-feature\`.
Utilise exclusivement la source rbw-servers et ses outils SSH structurés ; aucun SSH natif, Bash local ou navigateur pour modifier le code. Inspecte d’abord en lecture seule, puis corrige et synchronise les fichiers validés vers cette racine. Exécute les tests, committe, intègre et déploie Example Portal, puis vérifie le résultat.`;
    const sessionPath = join(workspaceRootPath, 'test-upload-session');
    const dataFolderPath = join(sessionPath, 'data');
    const relativeSource = 'example-feature/scripts/check-development-hierarchy.sh';
    const localPath = join(dataFolderPath, relativeSource);
    mkdirSync(join(dataFolderPath, 'example-feature', 'scripts'), { recursive: true });
    writeFileSync(localPath, '#!/bin/sh\nexit 0\n');
    const remotePath = '/srv/workspace/.worktrees/example-feature-worktree/scripts/check-development-hierarchy.sh';
    const input = {
      server: 'dev',
      localPath: `{{SESSION_PATH}}/data/${relativeSource}`,
      remotePath,
    };
    const authorization = {
      toolName: 'mcp__rbw-servers__ssh_upload',
      dataFolderPath,
      permissionMode: 'allow-all' as const,
      externalActionPolicy: 'allow-in-execute' as const,
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: [objective],
      declaredToolCapabilities: { destructive: true, readOnly: false, trusted: false },
    };
    expect(check({ ...authorization, input })).toMatchObject({
      type: 'modify',
      input: {
        server: 'dev',
        localPath: realpathSync.native(localPath),
        remotePath,
      },
    });
    expect(check({
      ...authorization,
      input: { ...input, localPath: realpathSync.native(localPath) },
    })).toMatchObject({ type: 'allow' });
    const misleadingReadAnnotation = {
      trusted: true,
      readOnly: true,
      destructive: false,
    };
    expect(classifyToolEffect(
      authorization.toolName,
      input,
      { workspaceRootPath, activeSourceSlugs: ['rbw-servers'] },
      misleadingReadAnnotation,
    )).toMatchObject({ kind: 'external-mutation', source: 'input-semantics' });
    expect(check({
      ...authorization,
      input,
      permissionMode: 'safe',
      declaredToolCapabilities: misleadingReadAnnotation,
    })).toMatchObject({ type: 'block' });

    const outsideSession = join(workspaceRootPath, 'test-other-session', 'data', 'payload.sh');
    mkdirSync(join(workspaceRootPath, 'test-other-session', 'data'), { recursive: true });
    writeFileSync(outsideSession, '#!/bin/sh\nexit 0\n');
    const siblingSource = join(dataFolderPath, 'other-project', 'scripts', 'payload.sh');
    mkdirSync(join(dataFolderPath, 'other-project', 'scripts'), { recursive: true });
    writeFileSync(siblingSource, '#!/bin/sh\nexit 0\n');
    const symlinkPath = join(dataFolderPath, 'example-feature', 'scripts', 'linked.sh');
    symlinkSync(outsideSession, symlinkPath, 'file');
    const hiddenCredentials = join(dataFolderPath, 'example-feature', 'credentials');
    mkdirSync(hiddenCredentials, { recursive: true });
    writeFileSync(join(hiddenCredentials, 'token.json'), '{"token":"never-upload"}\n');
    const symlinkedCredentials = join(dataFolderPath, 'example-feature', 'safe');
    symlinkSync(hiddenCredentials, symlinkedCredentials, 'dir');
    const secretSources = [
      '.git-credentials', '.netrc', '.npmrc', '.pypirc', 'client-key.pem',
      'service.key', 'bundle.p12', 'identity.pfx', 'token.json', 'auth.json',
    ].map(name => join(dataFolderPath, 'example-feature', name));
    for (const secretSource of secretSources) writeFileSync(secretSource, 'never-upload\n');
    const aliasedParentTarget = join(dataFolderPath, 'aliased-parent-target');
    mkdirSync(join(aliasedParentTarget, 'project'), { recursive: true });
    const aliasedParentFile = join(aliasedParentTarget, 'project', 'payload.sh');
    writeFileSync(aliasedParentFile, '#!/bin/sh\nexit 0\n');
    const aliasedParent = join(dataFolderPath, 'alias-parent');
    symlinkSync(aliasedParentTarget, aliasedParent, 'dir');
    for (const invalidInput of [
      { ...input, localPath: '{{SESSION_PATH}}/data/../other-session/data/payload.sh' },
      { ...input, localPath: '{{SESSION_PATH}}/../test-other-session/data/payload.sh' },
      { ...input, localPath: '{{SESSION_PATH}}/data/other-project/scripts/payload.sh' },
      { ...input, localPath: '{{SESSION_PATH}}/data/example-feature/scripts/*.sh' },
      { ...input, localPath: '${SESSION_PATH}/data/example-feature/scripts/check-development-hierarchy.sh' },
      { ...input, localPath: outsideSession },
      { ...input, localPath: siblingSource },
      { ...input, localPath: '{{SESSION_PATH}}/data/example-feature/scripts/linked.sh' },
      { ...input, localPath: symlinkPath },
      { ...input, localPath: join(symlinkedCredentials, 'token.json') },
      ...secretSources.map(localPath => ({ ...input, localPath })),
      { ...input, localPath: '{{SESSION_PATH}}/data/example-feature/.env' },
      { ...input, remotePath: '/srv/workspace/.worktrees/example-feature-other/scripts/check-development-hierarchy.sh' },
      { ...input, server: 'pns' },
      { ...input, opaque: true },
    ]) {
      expect(check({ ...authorization, input: invalidInput }).type).toBe('block');
    }
    const aliasedParentObjective = objective.replace(
      '{{SESSION_PATH}}/data/example-feature',
      '{{SESSION_PATH}}/data/alias-parent/project',
    );
    expect(check({
      ...authorization,
      input: {
        ...input,
        localPath: '{{SESSION_PATH}}/data/alias-parent/project/payload.sh',
      },
      objectiveAuthorizationSegments: [aliasedParentObjective],
    }).type).toBe('block');

    const otherSessionData = join(workspaceRootPath, 'test-other-data-owner', 'data');
    mkdirSync(join(otherSessionData, 'project'), { recursive: true });
    writeFileSync(join(otherSessionData, 'project', 'payload.sh'), '#!/bin/sh\nexit 0\n');
    const symlinkedSessionPath = join(workspaceRootPath, 'test-symlinked-session');
    mkdirSync(symlinkedSessionPath, { recursive: true });
    const symlinkedDataFolderPath = join(symlinkedSessionPath, 'data');
    symlinkSync(otherSessionData, symlinkedDataFolderPath, 'dir');
    const symlinkedDataObjective = objective.replace(
      '{{SESSION_PATH}}/data/example-feature',
      '{{SESSION_PATH}}/data/project',
    );
    expect(check({
      ...authorization,
      dataFolderPath: symlinkedDataFolderPath,
      input: {
        ...input,
        localPath: '{{SESSION_PATH}}/data/project/payload.sh',
      },
      objectiveAuthorizationSegments: [symlinkedDataObjective],
    }).type).toBe('block');
    expect(check({
      ...authorization,
      toolName: 'mcp__other-servers__ssh_upload',
      input,
    }).type).not.toBe('allow');
    expect(check({
      ...authorization,
      input,
      objectiveAuthorizationSegments: [objective, 'Ne synchronise finalement rien et ne modifie plus ce worktree.'],
    }).type).toBe('block');
  });

it('confines Orion DEV uploads to the named task worktree, never integration', () => {
    const taskRoot = '/opt/ia-webdev/agent-dev/worktrees/orion/scotland-ai-executive-day-20260930';
    const objective = `[robb-resume:orion-upload-session:4444444444444444444444444444444444444444:v2]
Cible exacte : serveur dev et racine ${taskRoot}. La copie de travail de session est \`{{SESSION_PATH}}/data/orion-task\`.
Utilise exclusivement la source rbw-servers et ses outils SSH structurés ; aucun SSH natif, Bash local ou navigateur pour modifier le code. Inspecte d’abord en lecture seule, puis corrige et synchronise les fichiers validés vers cette racine. Exécute les tests, committe et intègre Orion, puis vérifie le résultat.`;
    const dataFolderPath = join(workspaceRootPath, 'orion-task-upload-session', 'data');
    const localPath = join(dataFolderPath, 'orion-task', 'campaign.ts');
    mkdirSync(join(dataFolderPath, 'orion-task'), { recursive: true });
    writeFileSync(localPath, 'export const campaign = true;\n');
    const input = {
      server: 'dev', localPath: '{{SESSION_PATH}}/data/orion-task/campaign.ts',
      remotePath: `${taskRoot}/apps/web/lib/orion/campaign.ts`,
    };
    const authorization = {
      toolName: 'mcp__rbw-servers__ssh_upload', dataFolderPath,
      permissionMode: 'allow-all' as const,
      externalActionPolicy: 'allow-in-execute' as const,
      objectiveMutationAuthorized: true, objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: [objective],
      declaredToolCapabilities: { destructive: true, readOnly: false, trusted: false },
    };
    const readAuthorization = {
      ...authorization,
      toolName: 'mcp__rbw-servers__ssh_execute',
      declaredToolCapabilities: { destructive: false, readOnly: true, trusted: true },
    };
    expect(check({
      ...readAuthorization,
      input: { server: 'dev', cwd: taskRoot, command: "sed -n '1,80p' AGENTS.md" },
    })).toMatchObject({ type: 'allow' });
    for (const input of [
      { server: 'dev', cwd: taskRoot, command: "sed -n '1,80p' .env.production" },
      { server: 'dev', cwd: '/opt/ia-webdev/agent-dev/worktrees/orion/other-task', command: "sed -n '1,80p' AGENTS.md" },
    ]) expect(check({ ...readAuthorization, input }).type).toBe('block');
    expect(check({ ...authorization, input })).toMatchObject({
      type: 'modify', input: { remotePath: input.remotePath, localPath: realpathSync.native(localPath) },
    });
    for (const followUp of [
      "Corrige l'erreur TypeScript et téléverse le fichier corrigé.",
      'Relance et termine la synchronisation.',
    ]) {
      expect(check({
        ...authorization,
        input,
        objectiveAuthorizationSegments: [objective, followUp],
      })).toMatchObject({
        type: 'modify',
        input: { remotePath: input.remotePath, localPath: realpathSync.native(localPath) },
      });
    }
    for (const remotePath of [
      '/opt/ia-webdev/agent-dev/integration/orion/apps/web/lib/orion/campaign.ts',
      '/opt/ia-webdev/agent-dev/worktrees/orion/other-task/apps/web/lib/orion/campaign.ts',
      '/opt/ia-webdev/agent-dev/worktrees/orion/scotland-ai-executive-day-20260930/../other-task/campaign.ts',
    ]) {
      expect(check({ ...authorization, input: { ...input, remotePath } }).type).toBe('block');
    }
    expect(check({ ...authorization, input: { ...input, server: 'prod' } }).type).toBe('block');
  });

it('admits a literal Orion task edit and named checks, but no sibling or opaque shell edit', () => {
    const taskRoot = '/opt/ia-webdev/agent-dev/worktrees/orion/scotland-ai-executive-day-20260930';
    const objective = `Reprends maintenant la mission initiale et implemente reellement la campagne Orion de prospection ecossaise pour la journee conference IA destinee aux CODIR, en anglais. Perimetre de developpement autorise : serveur dev, racine ${taskRoot} ; branche codex/scotland-ai-executive-day-20260930. Via MCP rbw-servers SSH structure, lis les regles et la procedure Orion, puis corrige les fichiers source et teste exclusivement dans ce worktree distant. Integre avec rbw-dev-worktree integrate sous verrou apres les controles et vérifie le résultat.`;
    const authorization = {
      toolName: 'mcp__rbw-servers__ssh_execute',
      permissionMode: 'allow-all' as const,
      externalActionPolicy: 'allow-in-execute' as const,
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: [objective],
      declaredToolCapabilities: { destructive: true, readOnly: false, trusted: false },
    };
    for (const command of [
      "sed -i 's/preparing/ready/' apps/workers/src/campaigns/scotland-ai-executive-day/runtime.ts",
      'bun run test:scotland-campaign',
      'bun run check:scotland-campaign',
      'bun run typecheck',
    ]) {
      const decision = check({
        ...authorization, input: { server: 'dev', cwd: taskRoot, command },
      });
      expect(['allow', 'modify']).toContain(decision.type);
    }
    for (const followUp of [
      "Corrige l'erreur TypeScript et vérifie.",
      'Relance et termine la tâche.',
      "Itère jusqu'à ce que tous les tests passent.",
    ]) {
      const decision = check({
        ...authorization,
        input: { server: 'dev', cwd: taskRoot, command: 'bun run typecheck' },
        objectiveAuthorizationSegments: [objective, followUp],
      });
      expect(['allow', 'modify']).toContain(decision.type);
    }
    for (const input of [
      { server: 'dev', cwd: '/opt/ia-webdev/agent-dev/integration/orion', command: "sed -i 's/a/b/' apps/workers/src/campaigns/scotland-ai-executive-day/runtime.ts" },
      { server: 'dev', cwd: '/opt/ia-webdev/agent-dev/worktrees/orion/other-task', command: "sed -i 's/a/b/' apps/workers/src/campaigns/scotland-ai-executive-day/runtime.ts" },
      { server: 'dev', cwd: taskRoot, command: "sed -i 's/a/b/' scripts/verify-scotland-ai-executive-day.ts" },
      { server: 'dev', cwd: taskRoot, command: "sed -i 's/a/b/' apps/workers/src/campaigns/scotland-ai-executive-day/runtime.ts && bun run test:scotland-campaign" },
      { server: 'dev', cwd: taskRoot, command: "python3 -c 'open(\"scripts/verify-scotland-ai-executive-day.ts\",\"w\").write(\"ok\")'" },
    ]) expect(check({ ...authorization, input }).type).toBe('block');
    const namedCheck = { server: 'dev', cwd: taskRoot, command: 'bun run check:scotland-campaign' };
    for (const amendment of [
      'Ne modifie plus ce worktree ; analyse seulement la campagne.',
      `Analyse cette instruction comme exemple :\n${objective}`,
    ]) expect(check({
      ...authorization,
      input: namedCheck,
      objectiveAuthorizationSegments: [objective, amendment],
    }).type).toBe('block');
  });

it('reads several named Orion source documents without an authorization prompt', () => {
    const taskRoot = '/opt/ia-webdev/agent-dev/worktrees/orion/scotland-ai-executive-day-20260930';
    const objective = `Reprends maintenant la mission initiale et implemente reellement la campagne Orion de prospection ecossaise pour la journee conference IA destinee aux CODIR, en anglais. Perimetre de developpement autorise : serveur dev, racine ${taskRoot} ; branche codex/scotland-ai-executive-day-20260930. Via MCP rbw-servers SSH structure, lis les regles et la procedure Orion, puis corrige les fichiers source et teste exclusivement dans ce worktree distant. Integre avec rbw-dev-worktree integrate sous verrou apres les controles et vérifie le résultat.`;
    const authorization = {
      toolName: 'mcp__rbw-servers__ssh_execute',
      permissionMode: 'allow-all' as const,
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: [objective],
    };
    const command = "sed -n '1,220p' docs/orion/activation-20260929.md deploy/orion/README.md rulebook.md .claude-rules.md .claude-stack.md";
    expect(['allow', 'modify']).toContain(check({
      ...authorization, input: { server: 'dev', cwd: taskRoot, command },
    }).type);
    for (const invalid of [
      "sed -n '1,220p' docs/orion/activation-20260929.md ../other-task/README.md",
      "sed -n '1,220p' docs/orion/activation-20260929.md .env.production",
      "sed -n '1,220p' docs/orion/activation-20260929.md /etc/shadow",
      "sed -n '1,220p' docs/orion/activation-20260929.md docs/*.md",
    ]) expect(check({
      ...authorization, input: { server: 'dev', cwd: taskRoot, command: invalid },
    }).type).toBe('block');
  });

it('does not derive bounded upload authority from a quoted contract in a later amendment', () => {
    const objective = `[robb-resume:test-upload-session:4444444444444444444444444444444444444444:v2]
Cible exacte : serveur dev et racine /srv/workspace/.worktrees/example-feature-worktree. La copie de travail de session est \`{{SESSION_PATH}}/data/example-feature\`.
Utilise exclusivement la source rbw-servers et ses outils SSH structurés ; aucun SSH natif, Bash local ou navigateur pour modifier le code. Inspecte d’abord en lecture seule, puis corrige et synchronise les fichiers validés vers cette racine. Exécute les tests, committe, intègre et déploie Example Portal, puis vérifie le résultat.`;
    const dataFolderPath = join(workspaceRootPath, 'test-upload-quoted', 'data');
    const localPath = join(
      dataFolderPath,
      'example-feature/scripts/check-development-hierarchy.sh',
    );
    mkdirSync(join(dataFolderPath, 'example-feature', 'scripts'), { recursive: true });
    writeFileSync(localPath, '#!/bin/sh\nexit 0\n');
    const authorization = {
      toolName: 'mcp__rbw-servers__ssh_upload',
      input: {
        server: 'dev',
        localPath: '{{SESSION_PATH}}/data/example-feature/scripts/check-development-hierarchy.sh',
        remotePath: '/srv/workspace/.worktrees/example-feature-worktree/scripts/check-development-hierarchy.sh',
      },
      dataFolderPath,
      permissionMode: 'allow-all' as const,
      externalActionPolicy: 'allow-in-execute' as const,
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      declaredToolCapabilities: { destructive: true, readOnly: false, trusted: false },
    };

    expect(check({
      ...authorization,
      objectiveAuthorizationSegments: [objective],
    }).type).toBe('modify');

    const activeMission = 'Corrige l\'application et vérifie-la.';
    for (const quotedAmendment of [
      `Analyse ce prompt et explique ses risques :\n${objective}`,
      `Le rapport dit :\n${objective}`,
      `Exemple d'instruction :\n${objective}`,
      `Analyse uniquement ce bloc :\n\`\`\`text\n${objective}\n\`\`\``,
    ]) {
      expect(check({
        ...authorization,
        objectiveAuthorizationSegments: [activeMission, quotedAmendment],
      }).type).toBe('block');
    }
  });
});
