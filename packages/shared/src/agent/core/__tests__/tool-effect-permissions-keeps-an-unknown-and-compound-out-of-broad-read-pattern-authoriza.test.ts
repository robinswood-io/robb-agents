import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
it('keeps an unknown _and_ compound out of broad read-pattern authorization', () => {
    const permissionsContext = {
      workspaceRootPath,
      activeSourceSlugs: ['crm'],
    };
    expect(classifyToolEffect(
      'mcp__crm__search_and_transform',
      {},
      permissionsContext,
      { readOnly: true, trusted: false },
    ).kind).toBe('unknown');

    expect(check({
      toolName: 'mcp__crm__search_and_transform',
      input: {},
      permissionMode: 'safe',
      activeSourceSlugs: ['crm'],
      allSourceSlugs: ['crm'],
      declaredToolCapabilities: { readOnly: true, trusted: false },
    }).type).toBe('block');
    expect(check({
      toolName: 'mcp__crm__search_and_transform',
      input: {},
      permissionMode: 'ask',
      activeSourceSlugs: ['crm'],
      allSourceSlugs: ['crm'],
      declaredToolCapabilities: { readOnly: true, trusted: false },
    }).type).toBe('prompt');
    expect(check({
      toolName: 'mcp__crm__search_and_transform',
      input: {},
      permissionMode: 'allow-all',
      activeSourceSlugs: ['crm'],
      allSourceSlugs: ['crm'],
      declaredToolCapabilities: { readOnly: true, trusted: false },
    }).type).toBe('allow');
  });

it.each([
    'mcp__crm__search_and_delete',
    'mcp__crm__check_and_publish',
  ])('blocks mixed read/mutation tool %s until high-stakes evidence exists', (toolName) => {
    const result = check({
      toolName,
      input: { id: 'record-42' },
      permissionMode: 'allow-all',
      activeSourceSlugs: ['crm'],
      allSourceSlugs: ['crm'],
      externalActionPolicy: 'allow-in-execute',
    }, 'Rédige et publie un contrat juridique.');
    expect(result.type).toBe('block');
    if (result.type === 'block') {
      expect(result.reason).toContain('High-stakes evidence gate');
    }
  });

it('preserves typed WebSearch, SSH, and trusted MCP reads while the gate is active', () => {
    const objective = 'Rédige et publie un contrat juridique.';
    expect(check({
      toolName: 'WebSearch',
      input: { query: 'site:legifrance.gouv.fr NDA' },
      permissionMode: 'allow-all',
    }, objective).type).toBe('allow');
    expect(check({
      input: { command: 'pwd && ls -la /srv/workspace' },
      permissionMode: 'allow-all',
    }, objective).type).toBe('allow');
    expect(check({
      toolName: 'mcp__rbw-servers__opaque_inspection',
      input: {},
      permissionMode: 'allow-all',
      declaredToolCapabilities: { readOnly: true, trusted: true },
    }, objective).type).toBe('allow');
  });

it('allows a verified read in Explore mode without weakening mutation blocking', () => {
    expect(check({ permissionMode: 'safe', input: { command: 'pwd' } }).type).toBe('allow');
    expect(check({ permissionMode: 'safe', input: { command: 'touch /tmp/blocked' } }).type).toBe('block');
  });
});

describe('unresolved sensitive external-action pre-tool invariant', () => {
const unresolvedRemoteInput = {
    server: 'dev',
    cwd: '/srv/workspace/zero',
    command: 'touch marker',
  };

it('requires a generic explicit prompt for an otherwise-authorized unresolved remote scope', () => {
    expect(check({
      toolName: 'mcp__rbw-servers__ssh_execute',
      input: unresolvedRemoteInput,
      permissionMode: 'allow-all',
      externalActionPolicy: 'allow-in-execute',
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: ['Modifie Zero sur le serveur dev.'],
    })).toMatchObject({
      type: 'prompt',
      promptType: 'mcp_mutation',
      description: expect.stringContaining('Modify an external system'),
      command: expect.stringContaining('touch marker'),
      sensitiveActionCategory: 'external_mutation',
      sensitiveActionTargets: ['dev', 'zero', 'unresolved remote scope'],
      requiresExplicitConfirmation: true,
    });
  });

it('blocks unresolved remote scope when host objective authority is false', () => {
    expect(check({
      toolName: 'mcp__rbw-servers__ssh_execute',
      input: unresolvedRemoteInput,
      permissionMode: 'allow-all',
      externalActionPolicy: 'allow-in-execute',
      objectiveMutationAuthorized: false,
      objectiveSensitiveActionAuthorized: false,
      objectiveAuthorizationSegments: ['Modifie Zero sur le serveur dev.'],
    })).toMatchObject({
      type: 'block',
      reason: expect.stringContaining('Objective authority'),
    });
  });

it('prompts for unresolved remote scope without explicit objective authority', () => {
    expect(check({
      toolName: 'mcp__rbw-servers__ssh_execute',
      input: unresolvedRemoteInput,
      permissionMode: 'allow-all',
      externalActionPolicy: 'allow-in-execute',
    })).toMatchObject({
      type: 'prompt',
      sensitiveActionTargets: expect.arrayContaining(['unresolved remote scope']),
      requiresExplicitConfirmation: true,
    });
  });

it.each([
    {
      sentinel: 'unresolved external target',
      toolName: 'mcp__ops__execute',
      input: { action: 'send', operation: 'restart', to: 'alice', service: 'billing' },
      objective: 'Redémarre billing et envoie à alice.',
    },
    {
      sentinel: 'unresolved external audience',
      toolName: 'mcp__rbw-servers__ssh_execute',
      input: {
        server: 'pns',
        cwd: '/srv/pnsgen',
        command: 'curl -fsS -X POST http://127.0.0.1:8888/api/v1/edoc/send-signature -d @/tmp/payload.json',
      },
      objective: 'Envoie le test e-doc depuis PNS Gen.',
    },
    {
      sentinel: 'additional unresolved targets',
      toolName: 'mcp__mailer__execute',
      input: { operation: 'send', to: 'alice', routing_address: 'bob@example.com' },
      objective: 'Envoie à alice.',
    },
  ])('never silently auto-allows $sentinel in Execute mode', ({
    sentinel, toolName, input, objective,
  }) => {
    const sourceSlug = toolName.split('__')[1]!;
    const result = check({
      toolName,
      input,
      permissionMode: 'allow-all',
      externalActionPolicy: 'allow-in-execute',
      activeSourceSlugs: [sourceSlug],
      allSourceSlugs: [sourceSlug],
    });

    expect(result).toMatchObject({
      type: 'prompt',
      sensitiveActionTargets: expect.arrayContaining([sentinel]),
      requiresExplicitConfirmation: true,
    });

    expect(check({
      toolName,
      input,
      permissionMode: 'allow-all',
      externalActionPolicy: 'allow-in-execute',
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: [objective],
      activeSourceSlugs: [sourceSlug],
      allSourceSlugs: [sourceSlug],
    }).type).not.toBe('allow');
  });
});

describe('host-owned inbound connector effects', () => {
it('treats bounded session waits and OSS file listings as observations for recovery', () => {
    expect(classifyToolEffect('mcp__session__wait_sessions', {
      sessionIds: ['260929-polished-robin'], mode: 'all', timeoutMs: 60_000,
      afterCursors: { '260929-polished-robin': 'cursor' },
    })).toMatchObject({ kind: 'read', source: 'host-connector-contract' });
    expect(classifyToolEffect('mcp__rbw-agents-oss__oss_list_files', {
      path: '/srv/rbw-agents-oss/config', maxDepth: 1,
    })).toMatchObject({ kind: 'read', source: 'host-connector-contract' });
    for (const [toolName, input] of [
      ['mcp__session__wait_sessions', { sessionIds: ['child'], sendMessage: true }],
      ['mcp__session__wait_sessions', { sessionIds: [], timeoutMs: 0 }],
      ['mcp__rbw-agents-oss__oss_list_files', { path: '/srv/rbw-agents-oss/../outside' }],
      ['mcp__rbw-agents-oss__oss_list_files', { path: '/srv/rbw-agents-oss/config', write: true }],
    ] as const) {
      expect(classifyToolEffect(toolName, input).kind).not.toBe('read');
    }
  });

it('classifies bounded Gmail search and signed preflight as observations', () => {
    const preflight = {
      messageId: '1a0e88c1fc492d90',
      expectedRecipientEmail: 'alice@example.com',
      body: 'Bonjour Alice.',
      isHtml: false,
    };
    expect(classifyToolEffect('mcp__google-contacts__gmail_search_exact', { query: 'Alice' }))
      .toMatchObject({ kind: 'read', source: 'host-connector-contract' });
    expect(classifyToolEffect('mcp__google-contacts__gmail_reply_preflight', preflight))
      .toMatchObject({ kind: 'read', source: 'host-connector-contract' });
    expect(classifyToolEffect('mcp__google-contacts__gmail_reply_preflight', {
      ...preflight, to: 'eve@example.com',
    }).kind).not.toBe('read');
    expect(classifyToolEffect(
      'mcp__google-contacts__gmail_reply_preflight', preflight, undefined,
      { destructive: true },
    ).kind).toBe('external-mutation');
  });

it('rejects an extra Robb Agents permission question for that Sellsy read handshake', () => {
    const question = {
      id: 'sellsy-subscriptions-read-consent',
      question: 'M’autorises-tu à relancer l’autorisation OAuth Sellsy Atria en lecture seule avec le droit `subscriptions.read` ?',
      options: [
        { id: 'yes', label: 'Oui, autoriser la lecture' },
        { id: 'no', label: 'Non' },
      ],
    };
    expect(check({
      toolName: 'mcp__session__request_user_input',
      input: { questions: [question] },
      permissionMode: 'allow-all',
      objectiveMutationAuthorized: false,
    })).toMatchObject({
      type: 'block',
      reason: expect.stringContaining('already an admitted connector observation'),
    });
    expect(check({
      toolName: 'mcp__session__request_user_input',
      input: { questions: [{ ...question, question: 'Sellsy exige un code MFA. Quel code affiche votre application ?' }] },
      permissionMode: 'allow-all',
      objectiveMutationAuthorized: false,
    }).type).not.toBe('block');
  });

it('opens a Sellsy read-only OAuth handshake under an observational objective', () => {
    const scopes = 'companies.read contacts.read individuals.read invoices.read subscriptions.read items.read payments.read credit-notes.read estimates.read opportunities.read tasks.read activities.read search.read';
    for (const [toolName, input] of [
      ['mcp__atria-sellsy__atria_sellsy_authenticate', {}],
      ['mcp__atria-sellsy__atria_sellsy_oauth_start', { scopes }],
    ] as const) {
      expect(classifyToolEffect(toolName, input))
        .toMatchObject({ kind: 'read', source: 'host-connector-contract' });
      expect(check({
        toolName,
        input,
        permissionMode: 'allow-all',
        objectiveMutationAuthorized: false,
        activeSourceSlugs: ['atria-sellsy'],
        allSourceSlugs: ['atria-sellsy'],
      }).type).toBe('allow');
    }
    for (const input of [
      { scopes: 'subscriptions.write' },
      { scopes: 'subscriptions.read invoices.write' },
      { scopes, redirectUri: 'https://example.com' },
      { scopes: 'subscriptions.read subscriptions.read' },
    ]) {
      expect(classifyToolEffect('mcp__atria-sellsy__atria_sellsy_oauth_start', input).kind)
        .not.toBe('read');
    }
  });

it('treats a bounded Drive download as a read while rejecting altered shapes', () => {
    const fileId = '1a0e88c1fc492d90';
    expect(classifyToolEffect('mcp__google-contacts__drive_download_file', { fileId }))
      .toMatchObject({ kind: 'read', source: 'host-connector-contract' });
    expect(check({
      toolName: 'mcp__google-contacts__drive_download_file',
      input: { fileId },
      permissionMode: 'allow-all',
      objectiveMutationAuthorized: false,
      activeSourceSlugs: ['google-contacts'],
      allSourceSlugs: ['google-contacts'],
    }).type).toBe('allow');
    for (const input of [
      { fileId: '../outside' },
      { fileId, deleteAfterDownload: true },
      { fileId: '' },
    ]) {
      expect(classifyToolEffect('mcp__google-contacts__drive_download_file', input).kind)
        .not.toBe('read');
    }
  });
});
