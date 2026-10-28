import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
it('never grants structured SSH source-read authority to system, secret, or traversal paths', () => {
    const objective = 'Diagnostique et corrige la synchronisation e-doc du contrat PNS 3602 uniquement via rbw-servers/SSH structuré.';
    for (const command of [
      "sed -n '1,20p' /etc/shadow",
      "sed -n '1,20p' /proc/self/environ",
      "sed -n '1,20p' /root/.aws/config",
      "sed -n '1,20p' /srv/app/token.txt",
      "sed -n '1,20p' /srv/app/id_rsa",
      "sed -n '1,20p' /srv/app/../secrets/config.json",
      "sed -n '1,20p' /srv/pnsgen/.env.production",
      "sed -n '1,20p' /srv/pnsgen/config/secrets.json",
    ]) {
      expect(check({
        input: { server: 'pns', command },
        permissionMode: 'allow-all',
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: [objective],
        declaredToolCapabilities: { trusted: true, readOnly: true, idempotent: true },
      }, objective)).toMatchObject({
        type: 'block', reason: (expect.stringContaining('Structured SSH read validation failed') as unknown),
      });
    }
  });

it('keeps ambiguous composite source reads and source mutations blocked', () => {
    const objective = 'Diagnostique et corrige la synchronisation e-doc du contrat PNS 3602 uniquement via rbw-servers/SSH structuré.';
    const composite = check({
      input: {
        server: 'pns',
        command: "sed -n '1,340p' /srv/pnsgen/server/services/signatureQueueService.ts && sed -n '1,420p' /srv/pnsgen/server/workers/signatureWorker.ts",
      },
      permissionMode: 'allow-all',
      externalActionPolicy: 'allow-in-execute',
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: [objective],
    }, objective);
    expect(composite).toMatchObject({
      type: 'block', reason: (expect.stringContaining('composite remote command') as unknown),
    });

    const mutation = check({
      input: {
        server: 'pns',
        command: "sed -i 's/failed/completed/' /srv/pnsgen/server/services/signatureQueueService.ts",
      },
      permissionMode: 'allow-all',
      externalActionPolicy: 'allow-in-execute',
      objectiveMutationAuthorized: false,
      objectiveSensitiveActionAuthorized: false,
      objectiveAuthorizationSegments: [objective],
    }, objective);
    expect(mutation).toMatchObject({
      type: 'block', reason: (expect.stringContaining('Objective authority') as unknown),
    });
  });

it('treats only target-bound SSH read lifecycle operations as observations', () => {
    const objective = 'Diagnostique le contrat PNS 3602 uniquement via rbw-servers/SSH structuré.';
    const dataFolderPath = join(workspaceRootPath, 'session-data');
    mkdirSync(dataFolderPath, { recursive: true });
    for (const [toolName, input] of [
      ['mcp__rbw-servers__ssh_session_start', {
        server: 'pns', name: 'edoc-3602-diagnostic',
        _displayName: 'Ouvrir session PNS', _intent: 'Regrouper les lectures.',
      }],
      ['mcp__rbw-servers__ssh_download', {
        server: 'pns',
        remotePath: '/srv/pnsgen/server/services/signatureQueueService.ts',
        localPath: join(dataFolderPath, 'signatureQueueService.ts'),
        _displayName: 'Télécharger service file', _intent: 'Analyser localement la source.',
      }],
    ] as const) {
      const decision = check({
        toolName,
        input,
        dataFolderPath,
        permissionMode: 'allow-all',
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: [objective],
      }, objective);
      expect(decision.type === 'allow' || decision.type === 'modify').toBeTrue();
    }

    for (const server of ['pñs', 'ｐｎｓ', 'pns.']) {
      expect(check({
        toolName: 'mcp__rbw-servers__ssh_session_start',
        input: { server, name: 'edoc-3602-diagnostic' },
        dataFolderPath,
        permissionMode: 'allow-all',
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: [objective],
        declaredToolCapabilities: { trusted: true, readOnly: true, idempotent: true },
      }, objective).type).toBe('block');
    }

    expect(check({
      toolName: 'mcp__rbw-servers__ssh_session_start',
      input: { server: 'pns', name: 'edoc-3602-positive-channel' },
      dataFolderPath,
      permissionMode: 'allow-all',
      objectiveMutationAuthorized: false,
      objectiveSensitiveActionAuthorized: false,
      objectiveAuthorizationSegments: [
        'Diagnostique le contrat PNS 3602 via SSH structuré sur pns et vérifie son statut e-doc.',
      ],
      declaredToolCapabilities: { trusted: true, readOnly: true, idempotent: true },
    }).type).toBe('allow');

    expect(check({
      toolName: 'mcp__rbw-servers__ssh_session_start',
      input: { server: 'pns', name: 'edoc-3602-terminal-punctuation' },
      dataFolderPath,
      permissionMode: 'allow-all',
      objectiveMutationAuthorized: false,
      objectiveSensitiveActionAuthorized: false,
      objectiveAuthorizationSegments: [
        'Diagnostique le contrat e-doc 3602 via SSH structuré sur PNS.',
      ],
      declaredToolCapabilities: { trusted: true, readOnly: true, idempotent: true },
    }).type).toBe('allow');

    for (const lookalikeObjective of [
      'Diagnostique le contrat e-doc 3602 via SSH structuré sur pñs.',
      'Diagnostique le contrat e-doc 3602 via SSH structuré sur ｐｎｓ.',
      'Diagnostique le contrat e-doc 3602 via SSH structuré sur pns.example.',
    ]) {
      expect(check({
        toolName: 'mcp__rbw-servers__ssh_session_start',
        input: { server: 'pns', name: 'edoc-3602-lookalike-objective' },
        dataFolderPath,
        permissionMode: 'allow-all',
        objectiveMutationAuthorized: false,
        objectiveSensitiveActionAuthorized: false,
        objectiveAuthorizationSegments: [lookalikeObjective],
        declaredToolCapabilities: { trusted: true, readOnly: true, idempotent: true },
      }).type).toBe('block');
    }

    for (const restrictedObjective of [
      'Diagnostique le contrat PNS 3602 via API uniquement et vérifie le statut e-doc.',
      'Diagnostique le contrat PNS 3602 dans la base locale, sans SSH.',
      'Inspect the PNS contract using the API only and check its e-doc status.',
      'Inspect the PNS contract on pns, but do not use SSH.',
    ]) {
      expect(check({
        toolName: 'mcp__rbw-servers__ssh_session_start',
        input: { server: 'pns', name: 'edoc-3602-forbidden-channel' },
        dataFolderPath,
        permissionMode: 'allow-all',
        objectiveMutationAuthorized: false,
        objectiveSensitiveActionAuthorized: false,
        objectiveAuthorizationSegments: [restrictedObjective],
        declaredToolCapabilities: { trusted: true, readOnly: true, idempotent: true },
      }).type).toBe('block');
    }

    for (const structuredOnlyObjective of [
      'Diagnostique le contrat PNS via rbw-servers/SSH structuré sur pns; do not use local SSH.',
      'Diagnostique le contrat PNS via rbw-servers/SSH structuré sur pns; do not use native SSH.',
      'Diagnostique le contrat PNS via rbw-servers/SSH structuré sur pns; do not use direct SSH.',
      'Diagnostique le contrat PNS via rbw-servers/SSH structuré sur pns; do not use CLI SSH.',
      'Diagnostique le contrat PNS via rbw-servers/SSH structuré sur pns; n’utilise pas SSH local.',
      'Diagnostique le contrat PNS via rbw-servers/SSH structuré sur pns; n’utilise pas SSH natif.',
      'Diagnostique le contrat PNS via rbw-servers/SSH structuré sur pns; n’utilise pas SSH direct.',
      'Diagnostique le contrat PNS via rbw-servers/SSH structuré sur pns; n’utilise pas SSH CLI.',
      'Diagnostique le contrat PNS via rbw-servers/SSH structuré sur pns, sans SSH local.',
      'Diagnostique le contrat PNS via rbw-servers/SSH structuré sur pns, sans SSH natif.',
    ]) {
      expect(check({
        toolName: 'mcp__rbw-servers__ssh_session_start',
        input: { server: 'pns', name: 'edoc-3602-structured-only' },
        dataFolderPath,
        permissionMode: 'allow-all',
        objectiveMutationAuthorized: false,
        objectiveSensitiveActionAuthorized: false,
        objectiveAuthorizationSegments: [structuredOnlyObjective],
        declaredToolCapabilities: { trusted: true, readOnly: true, idempotent: true },
      }).type).toBe('allow');
    }

    for (const [toolName, input] of [
      ['mcp__rbw-servers__ssh_session_start', {
        server: 'pns', name: 'edoc-3602-diagnostic', opaque: true,
      }],
      ['mcp__rbw-servers__ssh_download', {
        server: 'pns', remotePath: '/srv/pnsgen/.env',
        localPath: join(dataFolderPath, 'environment.txt'),
      }],
      ['mcp__rbw-servers__ssh_download', {
        server: 'pns', remotePath: '/srv/../opt/app/source.ts',
        localPath: join(dataFolderPath, 'traversal.ts'),
      }],
      ['mcp__rbw-servers__ssh_download', {
        server: 'pns', remotePath: '/srv/./opt/app/source.ts',
        localPath: join(dataFolderPath, 'dot-segment.ts'),
      }],
      ['mcp__rbw-servers__ssh_download', {
        server: 'pns', remotePath: '/srv/pnsgen/server/services/signatureQueueService.ts',
        localPath: join(workspaceRootPath, 'outside.ts'),
      }],
    ] as const) {
      expect(check({
        toolName,
        input,
        dataFolderPath,
        permissionMode: 'allow-all',
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: [objective],
        declaredToolCapabilities: { trusted: true, readOnly: true, idempotent: true },
      }, objective)).toMatchObject({
        type: 'block', reason: (expect.stringContaining('Structured SSH read validation failed') as unknown),
      });
    }

    const legalObjective = 'Analyse et modifie la clause juridique du contrat PNS via SSH sur pns.';
    expect(check({
      toolName: 'mcp__rbw-servers__ssh_download',
      input: {
        server: 'pns', remotePath: '/srv/pnsgen/contracts/nda.md',
        localPath: join(dataFolderPath, 'nda.md'),
      },
      dataFolderPath,
      permissionMode: 'allow-all',
      externalActionPolicy: 'allow-in-execute',
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: [legalObjective],
    }, legalObjective).type).toBe('block');

    const outsideFolder = join(workspaceRootPath, 'download-symlink-outside');
    mkdirSync(outsideFolder, { recursive: true });
    const escapedParent = join(dataFolderPath, 'escape');
    symlinkSync(outsideFolder, escapedParent, 'dir');
    expect(check({
      toolName: 'mcp__rbw-servers__ssh_download',
      input: {
        server: 'pns',
        remotePath: '/srv/pnsgen/server/services/signatureQueueService.ts',
        localPath: join(escapedParent, 'signatureQueueService.ts'),
      },
      dataFolderPath,
      permissionMode: 'allow-all',
      objectiveMutationAuthorized: false,
      objectiveSensitiveActionAuthorized: false,
      objectiveAuthorizationSegments: [objective],
    }, objective).type).toBe('block');

    const outsideFile = join(outsideFolder, 'victim.ts');
    writeFileSync(outsideFile, 'unchanged');
    const escapedLeaf = join(dataFolderPath, 'linked.ts');
    symlinkSync(outsideFile, escapedLeaf, 'file');
    expect(check({
      toolName: 'mcp__rbw-servers__ssh_download',
      input: {
        server: 'pns',
        remotePath: '/srv/pnsgen/server/services/signatureQueueService.ts',
        localPath: escapedLeaf,
      },
      dataFolderPath,
      permissionMode: 'allow-all',
      objectiveMutationAuthorized: false,
      objectiveSensitiveActionAuthorized: false,
      objectiveAuthorizationSegments: [objective],
    }, objective).type).toBe('block');

    const escapedBrokenLeaf = join(dataFolderPath, 'broken-linked.ts');
    symlinkSync(join(outsideFolder, 'not-created.ts'), escapedBrokenLeaf, 'file');
    expect(check({
      toolName: 'mcp__rbw-servers__ssh_download',
      input: {
        server: 'pns',
        remotePath: '/srv/pnsgen/server/services/signatureQueueService.ts',
        localPath: escapedBrokenLeaf,
      },
      dataFolderPath,
      permissionMode: 'allow-all',
      objectiveMutationAuthorized: false,
      objectiveSensitiveActionAuthorized: false,
      objectiveAuthorizationSegments: [objective],
    }, objective).type).toBe('block');
  });

it('recognizes a concrete structured-SSH server target stated as `serveur dev`', () => {
    const objective = 'Cible exacte : serveur dev, /srv/workspace/orion et uniquement le service orion-agent-bridge. Utilise exclusivement la source rbw-servers et ses outils SSH structurés : aucun SSH natif. Diagnostique puis corrige durablement le pont, démarre ou redémarre uniquement orion-agent-bridge si nécessaire, puis vérifie la santé, la révision et les tests.';
    const dataFolderPath = join(workspaceRootPath, 'orion-session-data');
    mkdirSync(dataFolderPath, { recursive: true });
    for (const [toolName, input] of [
      ['mcp__rbw-servers__ssh_session_start', {
        server: 'dev', name: 'orion-authorized-repair',
      }],
      ['mcp__rbw-servers__ssh_download', {
        server: 'dev',
        remotePath: '/srv/workspace/orion/apps/agent-bridge/orion-agent-bridge.service',
        localPath: join(dataFolderPath, 'orion-agent-bridge.service'),
      }],
    ] as const) {
      const decision = check({
        toolName,
        input,
        dataFolderPath,
        permissionMode: 'allow-all',
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: [objective],
        declaredToolCapabilities: { trusted: true, readOnly: true, idempotent: true },
      });
      expect(decision.type === 'allow' || decision.type === 'modify').toBeTrue();
    }
  });
});
