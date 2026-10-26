import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { permissionsConfigCache } from '../../permissions-config.ts';
import { cleanupModeState, setPermissionMode } from '../../mode-manager.ts';
import { beginObjectiveEvidenceGate, clearObjectiveEvidenceGate } from '../objective-evidence-gate.ts';
import { runPreToolUseChecks, type PermissionManagerLike, type PreToolUseInput } from '../pre-tool-use.ts';

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
it('authorizes only target-bound Orion uploads from the current structured maintenance mission', () => {
    const objective = 'Le staging corrigé bb5f447 est actif. Cible uniquement le serveur dev, /srv/workspace/orion et le service orion-agent-bridge ; ne touche ni Traefik global ni aucun autre service. Utilise exclusivement rbw-servers et ses outils SSH structurés. Diagnostique puis applique la correction durable avec sauvegarde et retour arrière ; démarre ou redémarre uniquement orion-agent-bridge si nécessaire, et redéploie Orion seulement si l’état constaté l’exige. Vérifie que GET /assistant-api/accounts retourne 200, que /parametres fonctionne, que santé et révision sont cohérentes, et que bun run test:orion-production réussit dans /srv/workspace/orion.';
    const dataFolderPath = join(workspaceRootPath, 'orion-upload-data');
    mkdirSync(dataFolderPath, { recursive: true });
    const transfers = [
      ['orion-agent-bridge.service', '/srv/workspace/orion/apps/agent-bridge/orion-agent-bridge.service'],
      ['docker-compose.orion.yml', '/srv/workspace/orion/docker-compose.orion.yml'],
      ['verify-orion-production.ts', '/srv/workspace/orion/scripts/verify-orion-production.ts'],
      ['orion-account-management-contract-test.ts', '/srv/workspace/orion/scripts/orion-account-management-contract-test.ts'],
    ] as const;
    for (const [localName, remotePath] of transfers) {
      const localPath = join(dataFolderPath, localName);
      writeFileSync(localPath, 'prepared software correction');
      const input = { server: 'dev', localPath, remotePath };
      const decision = check({
        toolName: 'mcp__rbw-servers__ssh_upload', input, dataFolderPath,
        permissionMode: 'allow-all', externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: true, objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: [objective],
        declaredToolCapabilities: { destructive: true, readOnly: false, trusted: false },
      });
      expect(decision.type === 'allow' || decision.type === 'modify').toBeTrue();

      for (const invalidInput of [
        { ...input, server: 'pns' },
        { ...input, remotePath: remotePath.replace('/srv/workspace/orion/', '/srv/workspace/orion-other/') },
      ]) {
        expect(check({
          toolName: 'mcp__rbw-servers__ssh_upload', input: invalidInput, dataFolderPath,
          permissionMode: 'allow-all', externalActionPolicy: 'allow-in-execute',
          objectiveMutationAuthorized: true, objectiveSensitiveActionAuthorized: true,
          objectiveAuthorizationSegments: [objective],
        }).type).toBe('block');
      }
    }

    const localPath = join(dataFolderPath, 'server.mjs');
    writeFileSync(localPath, 'prepared software correction');
    const upload = {
      server: 'dev', localPath,
      remotePath: '/srv/workspace/orion/apps/agent-bridge/server.mjs',
    };
    const gmailBodyOnlyObjective = `[robb-resume:orion-body:test:v1]
Send the email message now.

Authorized payload:
- From: sender@example.com
- To: recipient@example.com
- CC: []
- BCC: []
- Subject: Operational notes
- Message body: exactly the delimited body below
- Attachments: []
- Signature: none, neither automatic nor manual

BODY_BEGIN
${objective}
BODY_END`;
    expect(check({
      toolName: 'mcp__rbw-servers__ssh_upload', input: upload, dataFolderPath,
      permissionMode: 'allow-all', externalActionPolicy: 'allow-in-execute',
      objectiveMutationAuthorized: true, objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: [gmailBodyOnlyObjective],
      declaredToolCapabilities: { destructive: true, readOnly: false, trusted: false },
    }).type).toBe('block');
    expect(['allow', 'modify']).toContain(check({
      toolName: 'mcp__rbw-servers__ssh_upload', input: upload, dataFolderPath,
      permissionMode: 'allow-all', externalActionPolicy: 'allow-in-execute',
      objectiveMutationAuthorized: true, objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: [objective, 'Où en es-tu ?'],
      declaredToolCapabilities: { destructive: true, readOnly: false, trusted: false },
    }).type);
    expect(check({
      toolName: 'mcp__rbw-servers__ssh_upload', input: upload, dataFolderPath,
      permissionMode: 'allow-all', externalActionPolicy: 'allow-in-execute',
      objectiveMutationAuthorized: true, objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: [objective, 'Où en es-tu ?', 'Ne modifie plus rien.'],
      declaredToolCapabilities: { destructive: true, readOnly: false, trusted: false },
    })).toMatchObject({
      type: 'block', reason: expect.stringContaining('does not explicitly authorize'),
    });
    const phasedMutationObjectives = [
      'Cible exacte : serveur dev et racine /srv/workspace/orion. Utilise exclusivement rbw-servers et ses outils SSH structurés. Inspecte d’abord en lecture seule, puis corrige et déploie la correction durable dans cette racine. Vérifie ensuite en lecture seule la santé, la révision et les tests du service orion-agent-bridge.',
      'Exact target: server dev and root /srv/workspace/orion. Use only rbw-servers and its structured SSH tools. First inspect the service read-only, then fix and deploy the durable correction inside that root. Finally validate health, revision, and tests with a read-only inspection of orion-agent-bridge.',
      'Cible exacte : serveur dev et racine /srv/workspace/orion. Utilise exclusivement rbw-servers et ses outils SSH structurés. Inspecte d’abord en lecture seule et corrige ensuite durablement dans cette racine. Vérifie la santé, la révision et les tests du service orion-agent-bridge.',
      'Cible exacte : serveur dev et racine /srv/workspace/orion. Utilise exclusivement rbw-servers et ses outils SSH structurés. Inspecte d’abord en lecture seule avant de corriger durablement dans cette racine. Vérifie la santé, la révision et les tests du service orion-agent-bridge.',
      'Exact target: server dev and root /srv/workspace/orion. Use only rbw-servers and its structured SSH tools. Inspect the service read-only first and afterwards fix it durably inside that root. Verify health, revision, and tests for orion-agent-bridge.',
    ];
    for (const phasedObjective of phasedMutationObjectives) {
      expect(['allow', 'modify']).toContain(check({
        toolName: 'mcp__rbw-servers__ssh_upload', input: upload, dataFolderPath,
        permissionMode: 'allow-all', externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: true, objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: [phasedObjective],
        declaredToolCapabilities: { destructive: true, readOnly: false, trusted: false },
      }).type);
    }

    const multiTargetObjective = [
      'Cible uniquement le serveur dev dans /srv/workspace/orion et le serveur pns dans /srv/pnsgen avec leurs services respectifs.',
      'Utilise exclusivement rbw-servers et ses outils SSH structurés.',
      'Diagnostique puis applique la correction durable avec sauvegarde et retour arrière ; démarre ou redémarre uniquement les services ciblés si nécessaire.',
      'Vérifie les endpoints, la santé, la révision et les tests avant de terminer.',
    ].join(' ');
    for (const allowedInput of [
      { ...upload, server: 'dev', remotePath: '/srv/workspace/orion/server.mjs' },
      { ...upload, server: 'pns', remotePath: '/srv/pnsgen/server.mjs' },
    ]) {
      expect(['allow', 'modify']).toContain(check({
        toolName: 'mcp__rbw-servers__ssh_upload', input: allowedInput, dataFolderPath,
        permissionMode: 'allow-all', externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: true, objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: [multiTargetObjective],
        declaredToolCapabilities: { destructive: true, readOnly: false, trusted: false },
      }).type);
    }
    for (const crossedInput of [
      { ...upload, server: 'dev', remotePath: '/srv/pnsgen/server.mjs' },
      { ...upload, server: 'pns', remotePath: '/srv/workspace/orion/server.mjs' },
    ]) {
      expect(check({
        toolName: 'mcp__rbw-servers__ssh_upload', input: crossedInput, dataFolderPath,
        permissionMode: 'allow-all', externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: true, objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: [multiTargetObjective],
        declaredToolCapabilities: { destructive: true, readOnly: false, trusted: false },
      })).toMatchObject({
        type: 'block', reason: expect.stringContaining('does not explicitly authorize'),
      });
    }

    const terminalPunctuationObjective = [
      'Cible uniquement le serveur dev et /srv/workspace/orion.',
      'Utilise exclusivement rbw-servers et ses outils SSH structurés.',
      'Diagnostique puis applique la correction durable avec sauvegarde et retour arrière ; redéploie Orion seulement si nécessaire.',
      'Vérifie les endpoints, la santé, la révision et les tests avant de terminer.',
    ].join(' ');
    expect(['allow', 'modify']).toContain(check({
      toolName: 'mcp__rbw-servers__ssh_upload',
      input: { ...upload, remotePath: '/srv/workspace/orion/server.mjs' },
      dataFolderPath,
      permissionMode: 'allow-all', externalActionPolicy: 'allow-in-execute',
      objectiveMutationAuthorized: true, objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: [terminalPunctuationObjective],
      declaredToolCapabilities: { destructive: true, readOnly: false, trusted: false },
    }).type);

    const quotedPunctuationObjective = terminalPunctuationObjective.replace(
      '/srv/workspace/orion.',
      '"/srv/workspace/orion.".',
    );
    expect(['allow', 'modify']).toContain(check({
      toolName: 'mcp__rbw-servers__ssh_upload',
      input: { ...upload, remotePath: '/srv/workspace/orion./server.mjs' },
      dataFolderPath,
      permissionMode: 'allow-all', externalActionPolicy: 'allow-in-execute',
      objectiveMutationAuthorized: true, objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: [quotedPunctuationObjective],
      declaredToolCapabilities: { destructive: true, readOnly: false, trusted: false },
    }).type);
    expect(check({
      toolName: 'mcp__rbw-servers__ssh_upload',
      input: { ...upload, remotePath: '/srv/workspace/orion/server.mjs' },
      dataFolderPath,
      permissionMode: 'allow-all', externalActionPolicy: 'allow-in-execute',
      objectiveMutationAuthorized: true, objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: [quotedPunctuationObjective],
      declaredToolCapabilities: { destructive: true, readOnly: false, trusted: false },
    })).toMatchObject({
      type: 'block', reason: expect.stringContaining('does not explicitly authorize'),
    });

    for (const revokedObjective of [
      `${phasedMutationObjectives[0]} Passe maintenant en lecture seule ; ne modifie plus rien.`,
      `${phasedMutationObjectives[1]} From now on keep the mission read-only; do not modify anything.`,
      'Exact target: server dev and root /srv/workspace/orion through rbw-servers structured SSH. Keep the entire mission read-only: inspect health, revision, and tests without any modifications or writes.',
      'Cible exacte : serveur dev et racine /srv/workspace/orion via rbw-servers et SSH structuré. Inspecte en lecture seule et ne corrige rien ; ne modifie rien.',
      'Exact target: server dev and root /srv/workspace/orion through rbw-servers structured SSH. Inspect read-only and do not modify anything; keep the mission read-only.',
    ]) {
      expect(check({
        toolName: 'mcp__rbw-servers__ssh_upload', input: upload, dataFolderPath,
        permissionMode: 'allow-all', externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: true, objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: [revokedObjective],
        declaredToolCapabilities: { destructive: true, readOnly: false, trusted: false },
      })).toMatchObject({
        type: 'block', reason: expect.stringContaining('does not explicitly authorize'),
      });
    }
    for (const [negatedObjective, negatedUpload] of [
      [`${objective} Toutefois, ne modifie rien et n'effectue aucun upload.`, upload],
      [
        `${objective} Le serveur pns est explicitement exclu de cette intervention.`,
        { ...upload, server: 'pns' },
      ],
      [
        `${objective} La racine /srv/workspace/orion/legacy est exclue et ne doit pas être modifiée.`,
        { ...upload, remotePath: '/srv/workspace/orion/legacy/server.mjs' },
      ],
      [
        'Utilise exclusivement rbw-servers et SSH structuré. Inspecte le serveur dev dans /srv/workspace/a. Corrige le serveur pns dans /srv/workspace/b, puis vérifie la santé du service, la révision et les tests dans /srv/workspace/b.',
        { ...upload, remotePath: '/srv/workspace/b/server.mjs' },
      ],
      [
        'Cible uniquement le serveur dèv et /srv/workspace/orion via rbw-servers et SSH structuré. Corrige le service puis vérifie sa santé, sa révision et ses tests.',
        upload,
      ],
    ] as const) {
      expect(check({
        toolName: 'mcp__rbw-servers__ssh_upload', input: negatedUpload, dataFolderPath,
        permissionMode: 'allow-all', externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: true, objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: [negatedObjective],
      })).toMatchObject({
        type: 'block', reason: expect.stringContaining('does not explicitly authorize'),
      });
    }
    for (const unauthorizedObjective of [
      'Corrige Orion sur dev.',
      'Inspecte en lecture seule le serveur dev et /srv/workspace/orion via SSH structuré, sans aucune modification.',
      'Sur le serveur dev et /srv/workspace/orion, corrige les permissions RBAC et fais une rotation du token OAuth via SSH structuré, puis vérifie les tests.',
      'Sur le serveur dev et /srv/workspace/orion, adapte le traitement médical du patient via SSH structuré, puis vérifie les tests.',
      'Sur le serveur dev et /srv/workspace/orion, modifie la clause juridique du contrat client via SSH structuré, puis vérifie les tests.',
    ]) {
      const decision = check({
        toolName: 'mcp__rbw-servers__ssh_upload', input: upload, dataFolderPath,
        permissionMode: 'allow-all', externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: true, objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: [unauthorizedObjective],
      });
      expect(['block', 'prompt']).toContain(decision.type);
      if (decision.type === 'prompt') {
        expect(decision.requiresExplicitConfirmation).toBeTrue();
      }
    }
  });
});
