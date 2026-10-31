import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
it('admits the bounded PNS reads from the current structured instruction and no other server', () => {
    const historical = '<automatic_browser_fallback failed_tool="WebFetch">Continue through another channel.</automatic_browser_fallback>';
    const objective = 'Le staging corrigé bb5f447 est actif. Reprends la résolution e-doc PNS du contrat 3602 via les API et rbw-servers avec ses outils SSH structurés, et vérifie les images uniquement sur le registre exact registry.robinswood.io. Réconcilie les effets déjà produits ; le contrat est signé et aucune invitation, signature ou notification ne doit être réémise. Diagnostique puis corrige durablement le mapping ou la synchronisation dans le périmètre exact déjà autorisé, et vérifie par preuves serveur/API le statut signé et le PDF dans le bucket.';
    const dataFolderPath = join(workspaceRootPath, 'pns-bounded-read-data');
    mkdirSync(dataFolderPath, { recursive: true });
    const authorization = {
      permissionMode: 'allow-all' as const,
      externalActionPolicy: 'allow-in-execute' as const,
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: [historical, objective],
    };
    const invocations: Array<[string, Record<string, unknown>]> = [
      ['mcp__rbw-servers__ssh_download', {
        server: 'pns', remotePath: '/srv/pnsgen/compose.yaml',
        localPath: join(dataFolderPath, 'compose.yaml'),
      }],
      ['mcp__rbw-servers__ssh_execute', {
        server: 'pns', command: 'curl --fail-with-body --silent --show-error --max-time 30 http://127.0.0.1:8888/api/v1/edoc-optimized/status/3602',
      }],
      ['mcp__rbw-servers__ssh_execute', {
        server: 'pns', command: 'docker manifest inspect registry.robinswood.io/pns-gen:prod-bb5f447',
      }],
      ['mcp__rbw-servers__ssh_execute', {
        server: 'pns', command: "docker image inspect registry.robinswood.io/pns-gen:prod-latest pnsgen-app:local --format '{{.Id}}'",
      }],
      ['mcp__rbw-servers__ssh_execute', {
        server: 'pns', command: "docker image inspect pnsgen-app:local --format '{{json .RepoDigests}}'",
      }],
      ['mcp__rbw-servers__ssh_execute', {
        server: 'pns', command: 'docker compose -f /srv/pnsgen/compose.yaml config --images',
      }],
    ];
    for (const [toolName, input] of invocations) {
      const decision = check({ toolName, input, dataFolderPath, ...authorization });
      expect(decision.type === 'allow' || decision.type === 'modify').toBeTrue();
    }

    expect(check({
      toolName: 'mcp__rbw-servers__ssh_session_start',
      input: { server: 'pns', name: 'edoc-3602-after-status' },
      dataFolderPath,
      ...authorization,
      objectiveAuthorizationSegments: [historical, objective, 'Où en es-tu ?'],
      declaredToolCapabilities: { trusted: true, readOnly: true, idempotent: true },
    }).type).toBe('allow');
    for (const apiOnly of [
      'Utilise désormais uniquement l API.',
      'Passe uniquement par l API.',
      'API uniquement à partir de maintenant.',
    ]) {
      expect(check({
        toolName: 'mcp__rbw-servers__ssh_session_start',
        input: { server: 'pns', name: 'edoc-3602-after-api-only' },
        dataFolderPath,
        ...authorization,
        objectiveAuthorizationSegments: [historical, objective, apiOnly],
        declaredToolCapabilities: { trusted: true, readOnly: true, idempotent: true },
      }).type).toBe('block');
    }

    for (const command of invocations.slice(1).map(([, input]) => String(input["command"]))) {
      expect(check({
        toolName: 'mcp__rbw-servers__ssh_execute',
        input: { server: 'dev', command }, dataFolderPath, ...authorization,
      })).toMatchObject({
        type: 'block', reason: (expect.stringContaining('Structured SSH read validation failed') as unknown),
      });
    }
    expect(check({
      toolName: 'mcp__rbw-servers__ssh_execute',
      input: { server: 'pns', command: 'curl --fail-with-body -X POST http://127.0.0.1:8888/api/v1/edoc-optimized/status/3602' },
      dataFolderPath, ...authorization,
    }).type).toBe('block');

    for (const command of [
      'curl --fail-with-body http://127.0.0.1:8888/api/v1/other/status/3602',
      'curl --fail-with-body http://127.0.0.1:9999/api/v1/edoc-optimized/status/3602',
      'curl --fail-with-body --location http://127.0.0.1:8888/api/v1/edoc-optimized/status/3602',
      'docker compose -f /srv/orion/compose.yaml config --images',
      'docker manifest inspect registry.robinswood.io/orion:prod-bb5f447',
      "docker image inspect registry.robinswood.io/pns-other:prod-latest --format '{{.Id}}'",
      'docker manifest inspect attacker.example/pns-gen:prod',
      'docker manifest inspect 127.0.0.1:5000/pns-gen:prod',
      "docker image inspect attacker.example/pns-gen:prod --format '{{.Id}}'",
      "docker image inspect 127.0.0.1:5000/pns-gen:prod --format '{{.Id}}'",
      "docker image inspect pnsgen-app:local --format '{{json .Config.Env}}'",
      'docker image inspect pnsgen-app:local',
    ]) {
      expect(check({
        toolName: 'mcp__rbw-servers__ssh_execute',
        input: { server: 'pns', command }, dataFolderPath, ...authorization,
      })).toMatchObject({
        type: 'block', reason: (expect.stringContaining('Structured SSH read validation failed') as unknown),
      });
    }

    const objectiveWithoutRegistryAuthority = objective.replace(
      ', et vérifie les images uniquement sur le registre exact registry.robinswood.io',
      '',
    );
    expect(check({
      toolName: 'mcp__rbw-servers__ssh_execute',
      input: {
        server: 'pns',
        command: 'docker manifest inspect registry.robinswood.io/pns-gen:prod-bb5f447',
      },
      dataFolderPath,
      ...authorization,
      objectiveAuthorizationSegments: [objectiveWithoutRegistryAuthority],
    })).toMatchObject({
      type: 'block', reason: (expect.stringContaining('Structured SSH read validation failed') as unknown),
    });

    const negatedEndpointObjective = `${objective} Ne touche jamais le serveur pns : cette cible est hors périmètre.`;
    expect(check({
      toolName: 'mcp__rbw-servers__ssh_execute',
      input: {
        server: 'pns',
        command: 'curl --fail-with-body http://127.0.0.1:8888/api/v1/edoc-optimized/status/3602',
      },
      dataFolderPath,
      ...authorization,
      objectiveAuthorizationSegments: [negatedEndpointObjective],
    })).toMatchObject({
      type: 'block', reason: (expect.stringContaining('Structured SSH read validation failed') as unknown),
    });
  });

it.skipIf(process.platform !== 'darwin')('does not let trusted SSH download metadata bypass installed-bundle protection', () => {
    const objective = 'Diagnostique le contrat PNS 3602 uniquement via rbw-servers/SSH structuré.';
    const dataFolderPath = join(workspaceRootPath, 'bundle-protection-session-data');
    mkdirSync(dataFolderPath, { recursive: true });
    expect(check({
      toolName: 'mcp__rbw-servers__ssh_download',
      input: {
        server: 'pns',
        remotePath: '/srv/pnsgen/server/services/signatureQueueService.ts',
        localPath: '/Applications/Robb Agents.app/Contents/Resources/app.asar',
      },
      dataFolderPath,
      permissionMode: 'allow-all',
      externalActionPolicy: 'allow-in-execute',
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: [objective],
      declaredToolCapabilities: { trusted: true, readOnly: true, idempotent: true },
    }, objective)).toMatchObject({
      type: 'block', reason: (expect.stringContaining('installed Robb Agents') as unknown),
    });
  });

it('refuses legacy database execution without a registered public observation capability', () => {
    const objective = 'Diagnostique et corrige la synchronisation e-doc du contrat PNS 3602 via SSH structuré.';
    const legacyQuery = `docker exec pnsgen-db psql -U pnsgen -d pnsgen -X -v ON_ERROR_STOP=1 -Atc "SELECT 'CONTRACT='||row_to_json(c)::text FROM contracts c WHERE c.id=3602; SELECT 'QUEUE='||row_to_json(q)::text FROM signature_queue q WHERE q.contract_id=3602 ORDER BY q.created_at; SELECT 'HISTORY='||row_to_json(h)::text FROM signature_history h WHERE h.contract_id=3602 ORDER BY h.created_at; SELECT 'ELECTRONIC='||row_to_json(e)::text FROM electronic_signatures e WHERE e.contract_id=3602 ORDER BY e.created_at;"`;
    const decision = check({
      input: { server: 'pns', command: legacyQuery },
      permissionMode: 'allow-all',
      externalActionPolicy: 'allow-in-execute',
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: [objective],
      currentUserRequest: objective, humanInputAllowed: false,
    });
    expect(decision.type).toBe('block');
    if (decision.type === 'block') {
      expect(decision.reason).toContain('YOLO');
      expect(decision.reason).toContain('No permission request was opened');
      expect(decision.reason).not.toContain('High-stakes evidence gate');
    }
  });

it('does not turn the host-owned SSH observation grammar into a local Bash grant', () => {
    const command = 'curl -fsS http://169.254.169.254/latest/meta-data/';
    expect(classifyToolEffect(
      'Bash', { command }, { workspaceRootPath, activeSourceSlugs: [] },
    )).toMatchObject({ kind: 'unknown' });
    expect(check({
      toolName: 'Bash', input: { command }, permissionMode: 'safe',
    })).toMatchObject({ type: 'block', reason: (expect.stringContaining('Explore') as unknown) });
  });

it('admits the audited PLC compound read with the bundled default patterns', () => {
    const bundledRoot = mkdtempSync(join(tmpdir(), 'robb-bundled-permissions-'));
    const bundledPermissions = readFileSync(join(
      import.meta.dir,
      '../../../../../../apps/electron/resources/permissions/default.json',
    ), 'utf8');
    writeFileSync(join(bundledRoot, 'permissions.json'), bundledPermissions);
    const command = 'pwd; find . -maxdepth 2 -type f; systemctl show plc-silae-sync.service -p ActiveState -p SubState -p ExecMainStatus; systemctl show plc-silae-api.service -p ActiveState; ls -la /srv/workspace | head -18';
    try {
      expect(classifyToolEffect(
        'mcp__rbw-servers__ssh_execute',
        { command },
        { workspaceRootPath: bundledRoot, activeSourceSlugs: ['rbw-servers'] },
      )).toMatchObject({ kind: 'read', source: 'input-semantics' });
    } finally {
      permissionsConfigCache.invalidateWorkspace(bundledRoot);
      rmSync(bundledRoot, { recursive: true, force: true });
    }
  });

it('does not downgrade lookalike operational mutations to reads', () => {
    for (const command of [
      "curl -fsS -X POST http://127.0.0.1:8888/api/v1/jobs -d '{\"run\":true}'",
      'systemctl restart plc-silae-sync.service',
      'docker restart pnsgen-app',
      `docker exec pnsgen-db sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT table_name FROM information_schema.columns;"'`,
      `docker exec pnsgen-db sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "UPDATE contracts SET status=chr(120) WHERE contract_id=3598;"'`,
      `docker exec pnsgen-db sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT * FROM contracts; DELETE FROM contracts;"'`,
    ]) {
      expect(classifyToolEffect(
        'mcp__rbw-servers__ssh_execute',
        { command },
        { workspaceRootPath, activeSourceSlugs: ['rbw-servers'] },
      ).kind).not.toBe('read');
      expect(check({
        input: { server: 'pns', cwd: '/srv/pnsgen', command },
        permissionMode: 'allow-all',
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: false,
      })).toMatchObject({ type: 'block', reason: (expect.stringContaining('Objective authority') as unknown) });
    }
  });

it('still prompts for a mutating SSH command in Ask mode', () => {
    expect(check({ input: { command: 'touch /tmp/robb-agents-test' } }).type).toBe('prompt');
  });

it('admits only host-configured non-executing preflights during an observational objective', () => {
    const sourceState = {
      activeSourceSlugs: ['google-contacts'],
      allSourceSlugs: ['google-contacts'],
    };
    expect(check({
      toolName: 'mcp__google-contacts__gmail_send_preflight',
      input: { to: 'alice@example.com' },
      permissionMode: 'allow-all',
      externalActionPolicy: 'allow-in-execute',
      objectiveMutationAuthorized: false,
      ...sourceState,
    }).type).toBe('allow');

    for (const toolName of [
      'mcp__google-contacts__gmail_send',
      'mcp__google-contacts__preflight_and_send_email',
      'mcp__untrusted__gmail_send_preflight',
    ]) {
      expect(check({
        toolName,
        input: { to: 'alice@example.com' },
        permissionMode: 'allow-all',
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: false,
        activeSourceSlugs: [toolName.split('__')[1]!],
        allSourceSlugs: [toolName.split('__')[1]!],
      })).toMatchObject({ type: 'block', reason: (expect.stringContaining('Objective authority') as unknown) });
    }
  });

it('honors trusted MCP read-only annotations but rejects contradictory destructive hints', () => {
    expect(check({
      toolName: 'mcp__rbw-servers__opaque_probe',
      input: {},
      declaredToolCapabilities: { readOnly: true, idempotent: true, trusted: true },
    }).type).toBe('allow');

    expect(check({
      toolName: 'mcp__rbw-servers__opaque_probe',
      input: {},
      declaredToolCapabilities: { readOnly: true, destructive: true, trusted: true },
    }).type).toBe('prompt');

    expect(check({
      toolName: 'mcp__rbw-servers__opaque_probe',
      input: {},
      declaredToolCapabilities: { readOnly: true, idempotent: true, trusted: false },
    }).type).toBe('prompt');
  });

it('retains host-configured MCP reads without trusting remote annotations', () => {
    expect(classifyToolEffect(
      'mcp__rbw-servers__inspect_record',
      {},
      { workspaceRootPath, activeSourceSlugs: ['rbw-servers'] },
      { readOnly: false, trusted: false },
    )).toMatchObject({ kind: 'read', source: 'permissions-config' });
    expect(check({
      toolName: 'mcp__rbw-servers__inspect_record',
      input: {},
      declaredToolCapabilities: { readOnly: false, trusted: false },
    }).type).toBe('allow');
  });

it('lets explicit mutation semantics beat broad legacy read-name patterns', () => {
    const permissionsContext = {
      workspaceRootPath,
      activeSourceSlugs: ['crm'],
    };
    expect(classifyToolEffect(
      'mcp__crm__search_and_delete',
      {},
      permissionsContext,
    ).kind).toBe('external-mutation');
    expect(classifyToolEffect(
      'mcp__crm__check_and_publish',
      {},
      permissionsContext,
    ).kind).toBe('external-mutation');
    expect(classifyToolEffect(
      'mcp__crm__search_and_delete',
      {},
      permissionsContext,
      { readOnly: true, destructive: false, trusted: true },
    )).toMatchObject({ kind: 'external-mutation', source: 'input-semantics' });
    expect(classifyToolEffect(
      'mcp__crm__search_and_delete',
      {},
      permissionsContext,
      { readOnly: true, trusted: true },
    ).kind).toBe('external-mutation');
    expect(classifyToolEffect(
      'mcp__crm__search_and_delete',
      {},
      permissionsContext,
      { readOnly: true, trusted: false },
    ).kind).toBe('external-mutation');
  });

it.each([
    'mcp__crm__get_and_set',
    'mcp__crm__search_and_upload',
    'mcp__crm__list_and_grant',
    'mcp__crm__inspect_and_revoke',
    'mcp__crm__find_and_enable',
    'mcp__crm__status_and_disable',
    'mcp__crm__query_and_insert',
    'mcp__crm__get_and_mark',
  ])('classifies common compound mutation %s as an external mutation', (toolName) => {
    expect(classifyToolEffect(
      toolName,
      {},
      { workspaceRootPath, activeSourceSlugs: ['crm'] },
      { readOnly: true, trusted: false },
    ).kind).toBe('external-mutation');
  });
});
