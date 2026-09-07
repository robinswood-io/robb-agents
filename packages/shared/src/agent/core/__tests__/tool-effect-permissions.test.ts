import { afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cleanupModeState, setPermissionMode } from '../../mode-manager.ts';
import {
  beginObjectiveEvidenceGate,
  clearObjectiveEvidenceGate,
} from '../objective-evidence-gate.ts';
import {
  classifyToolEffect,
  runPreToolUseChecks,
  type PermissionManagerLike,
  type PreToolUseInput,
} from '../pre-tool-use.ts';

const liveSessions: string[] = [];

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
    beginObjectiveEvidenceGate(sessionId, `${sessionId}-objective`, highStakesObjective);
  }
  return runPreToolUseChecks({
    toolName: 'mcp__rbw-servers__ssh_execute',
    input: { command: 'pwd' },
    sessionId,
    permissionMode,
    workspaceRootPath: '/tmp/tool-effect-workspace',
    workspaceId: 'tool-effect-workspace',
    activeSourceSlugs: ['rbw-servers'],
    allSourceSlugs: ['rbw-servers'],
    hasSourceActivation: false,
    permissionManager,
    ...overrides,
  });
}

describe('typed tool effects', () => {
  it('classifies a read-only remote shell command from its input semantics', () => {
    expect(classifyToolEffect(
      'mcp__rbw-servers__ssh_execute',
      { command: 'pwd && ls -la /srv/workspace' },
      { workspaceRootPath: '/tmp/tool-effect-workspace', activeSourceSlugs: ['rbw-servers'] },
    )).toMatchObject({
      kind: 'read',
      reversibility: 'not-applicable',
      source: 'input-semantics',
    });
  });

  it('does not prompt for a verified read-only SSH command in Ask mode', () => {
    expect(check({ input: { command: 'pwd && ls -la /srv/workspace' } }).type).toBe('allow');
  });

  it('still prompts for a mutating SSH command in Ask mode', () => {
    expect(check({ input: { command: 'touch /tmp/robb-agents-test' } }).type).toBe('prompt');
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
      { workspaceRootPath: '/tmp/tool-effect-workspace', activeSourceSlugs: ['rbw-servers'] },
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
      workspaceRootPath: '/tmp/tool-effect-workspace',
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
      { readOnly: true, trusted: true },
    ).kind).toBe('read');
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
      { workspaceRootPath: '/tmp/tool-effect-workspace', activeSourceSlugs: ['crm'] },
      { readOnly: true, trusted: false },
    ).kind).toBe('external-mutation');
  });

  it('keeps an unknown _and_ compound out of broad read-pattern authorization', () => {
    const permissionsContext = {
      workspaceRootPath: '/tmp/tool-effect-workspace',
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
