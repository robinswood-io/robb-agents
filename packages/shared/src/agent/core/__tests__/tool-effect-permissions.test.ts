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
const terminalPolicy = (overrides: Partial<NonNullable<PreToolUseInput['objectiveTerminalReconciliationPolicy']>> = {}) => ({
  kind: 'terminal-reconciliation' as const,
  allowInitialCriteriaRegistration: false,
  allowReviewerSpawn: false,
  readReplays: [],
  waitReviewerSessionIds: [],
  invocationCapabilityKey: 'test-terminal-capability-key',
  ...overrides,
});

describe('typed tool effects', () => {
it('treats only an exact rbw-servers rsync dry run as an observation', () => {
    const preview = {
      server: 'interne',
      source: 'local:{{SESSION_PATH}}/data/scotland-install/',
      destination: 'remote:/srv/rbw-agents-oss/',
      dryRun: true, delete: false, checksum: true,
      exclude: ['__pycache__', '*.pyc'],
    };
    expect(classifyToolEffect('mcp__rbw-servers__ssh_sync', preview)).toMatchObject({
      kind: 'read', source: 'host-connector-contract',
    });
    expect(check({
      toolName: 'mcp__rbw-servers__ssh_sync', input: preview,
      permissionMode: 'allow-all', objectiveMutationAuthorized: false,
      objectiveSensitiveActionAuthorized: false,
    }).type).toBe('allow');
    for (const changed of [
      { dryRun: false }, { delete: true },
      { destination: 'remote:/srv/rbw-agents-oss/../other/' },
      { source: 'remote:/srv/rbw-agents-oss/' },
      { destination: 'remote:/srv/rbw-agents-oss/$(touch /tmp/unsafe)' },
      { extraOption: '--rsync-path=/bin/sh' },
    ]) {
      const input = { ...preview, ...changed };
      expect(classifyToolEffect('mcp__rbw-servers__ssh_sync', input).kind).not.toBe('read');
      expect(check({
        toolName: 'mcp__rbw-servers__ssh_sync', input,
        permissionMode: 'allow-all', objectiveMutationAuthorized: false,
        objectiveSensitiveActionAuthorized: false,
      }).type).toBe('block');
    }
    expect(classifyToolEffect('mcp__other-servers__ssh_sync', preview).kind).not.toBe('read');
    expect(classifyToolEffect('mcp__rbw-servers__ssh_sync', preview, undefined,
      { destructive: true }).kind).toBe('external-mutation');
  });

it.skipIf(process.platform !== 'darwin')('blocks installed-bundle writes even in Execute mode with trusted read hints', () => {
    for (const toolName of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      expect(check({
        toolName, permissionMode: 'allow-all',
        input: { file_path: '/Applications/Robb Agents.app/Contents/Resources/app.asar' },
      })).toMatchObject({ type: 'block', reason: (expect.stringContaining('installed Robb Agents') as unknown) });
    }
  });

it('routes immutable criterion registration to its validator without an unrelated source-gate retry', () => {
    for (const permissionMode of ['safe', 'ask', 'allow-all'] as const) {
      expect(check({
        toolName: 'mcp__session__set_completion_criteria', permissionMode,
        input: { criteria: [{ id: 'target-ready', description: 'Read the actual target state',
          toolName: 'Bash', input: { command: 'cat /tmp/state.json' }, checks: [{ path: '$.ready', equals: true }] }] },
      }, 'Corrige ce contrat juridique.').type).toBe('allow');
    }
    // Registration is a host-only protocol operation. This does not permit
    // executing the registered tool's command or bypassing real source evidence.
    expect(check({ toolName: 'Write', permissionMode: 'allow-all',
      input: { file_path: '/tmp/legal-document', content: 'changed' },
    }, 'Corrige ce contrat juridique.')).toMatchObject({ type: 'block', reason: (expect.stringContaining('High-stakes evidence gate') as unknown) });
  });

it('keeps explicit keyboard text a mutation across modes, aliases, batches and trusted-read hints', () => {
    for (const toolName of ['browser_tool', 'mcp__session__browser_tool', 'session__browser_tool']) {
      for (const command of ['type-keys é €', ['type-keys', 'é €'], 'snapshot; type-keys "a;b"', '"TYPE-KEYS" "a;b"']) {
        expect(classifyToolEffect(toolName, { command }, { workspaceRootPath, activeSourceSlugs: [] }, { readOnly: true, trusted: true })).toMatchObject({ kind: 'external-mutation' })
        expect(check({ toolName, input: { command }, permissionMode: 'safe' }).type).toBe('block')
        expect(check({ toolName, input: { command }, permissionMode: 'ask' })).toMatchObject({ type: 'prompt', requiresExplicitConfirmation: true })
        expect(check({ toolName, input: { command }, permissionMode: 'allow-all' })).toMatchObject({ type: 'prompt', requiresExplicitConfirmation: true })
        expect(check({ toolName, input: { command }, permissionMode: 'allow-all', externalActionPolicy: 'allow-in-execute' }).type).toBe('allow')
      }
    }
    for (const command of [['type', 'type-keys'], ['evaluate', '"type-keys"'], 'type "type-keys"']) {
      expect(classifyToolEffect('browser_tool', { command })).not.toMatchObject({ kind: 'external-mutation' })
    }
  })

it('blocks browser mutations and unknown commands outside observational objective authority', () => {
    const canonicalMutations: unknown[] = [
      'click @e1',
      'click-at 20 40',
      'drag 10 20 30 40',
      'fill @e1 changed',
      'type changed',
      'type-keys changed',
      'key Enter',
      'select @e1 changed',
      'upload @e1 /tmp/file',
      ['paste', 'changed'],
      ['evaluate', 'document.querySelector("form")?.submit()'],
      'snapshot; click @e1',
      'set-clipboard changed',
      'teleport somewhere',
      'navigate javascript://alert(1)',
    ];
    for (const command of canonicalMutations) {
      const result = check({
        toolName: 'mcp__session__browser_tool',
        input: { command },
        permissionMode: 'allow-all',
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: false,
      });
      expect(result).toMatchObject({
        type: 'block',
        reason: (expect.stringContaining('Objective authority') as unknown),
      });
    }

    for (const toolName of [
      'browser_click',
      'mcp__session__browser_fill',
      'session__browser_type',
      'browser_key',
      'browser_select',
      'browser_upload',
      'browser_paste',
      'browser_evaluate',
    ]) {
      expect(check({
        toolName,
        input: {},
        permissionMode: 'allow-all',
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: false,
      })).toMatchObject({ type: 'block', reason: (expect.stringContaining('Objective authority') as unknown) });
    }
  });

it('keeps browser mutations blocked in Explore even when the objective authorizes mutation', () => {
    const canonicalCommands = ['click @e1', 'fill @e1 changed', 'type changed', 'key Enter',
      'select @e1 changed', 'upload @e1 /tmp/file', 'paste changed', 'evaluate 1+1'];
    for (const command of canonicalCommands) {
      expect(check({
        toolName: 'browser_tool',
        input: { command },
        permissionMode: 'safe',
        objectiveMutationAuthorized: true,
        externalActionPolicy: 'allow-in-execute',
      })).toMatchObject({ type: 'block', reason: (expect.stringContaining('Explore') as unknown) });
    }

    for (const [toolName, input] of [
      ['browser_click', {}],
      ['mcp__session__browser_fill', {}],
      ['browser_type', {}],
      ['mcp__session__browser_key', {}],
      ['browser_select', {}],
      ['mcp__session__browser_upload', {}],
      ['browser_paste', {}],
      ['mcp__session__browser_evaluate', {}],
    ] as const) {
      expect(check({
        toolName,
        input,
        permissionMode: 'safe',
        objectiveMutationAuthorized: true,
        externalActionPolicy: 'allow-in-execute',
      })).toMatchObject({ type: 'block', reason: (expect.stringContaining('Explore') as unknown) });
    }

    for (const command of canonicalCommands) {
      expect(check({
        toolName: 'browser_tool',
        input: { command },
        permissionMode: 'allow-all',
        objectiveMutationAuthorized: true,
        externalActionPolicy: 'allow-in-execute',
      }).type).toBe('allow');
    }
  });

it('retains a closed set of browser observations for observational objectives', () => {
    for (const command of [
      'open',
      'navigate https://example.com/status',
      'snapshot',
      'find deployment status',
      'screenshot --annotated',
      ['screenshot-region', '--ref', '@e1'],
      'console 20 error',
      'network 20 failed',
      'wait network-idle 300000',
      'downloads list 10',
      'scroll down 500',
      'back',
      'forward',
      'windows',
    ] as const) {
      expect(check({
        toolName: 'mcp__session__browser_tool',
        input: { command },
        permissionMode: 'allow-all',
        objectiveMutationAuthorized: false,
      }).type).toBe('allow');
    }

    for (const [toolName, input] of [
      ['browser_open', {}],
      ['mcp__session__browser_navigate', { url: 'https://example.com/status' }],
      ['session__browser_snapshot', {}],
      ['browser_screenshot', {}],
      ['browser_wait', {}],
    ] as const) {
      expect(check({
        toolName,
        input,
        permissionMode: 'allow-all',
        objectiveMutationAuthorized: false,
      }).type).toBe('allow');
    }
  });

it('blocks alternate browser, preflight, planning and model paths during terminal reconciliation', () => {
    const cases = [
      ['mcp__session__browser_tool', { command: 'snapshot' }, []],
      ['mcp__session__browser_navigate', { url: 'https://mail.google.com/' }, []],
      ['mcp__google-contacts__gmail_send_preflight', { to: 'alice@example.com' }, ['google-contacts']],
      ['mcp__session__call_llm', { prompt: 'Recheck the result.' }, []],
      ['mcp__session__update_plan', { plan: [] }, []],
      ['mcp__session__request_user_input', { questions: [] }, []],
      ['mcp__session__spawn_session', { prompt: 'Inspect.', role: 'worker' }, []],
      ['mcp__session__spawn_session', { prompt: 'Review.', role: 'reviewer', permissionMode: 'safe' }, []],
      ['mcp__session__source_credential_prompt', { sourceSlug: 'google-contacts' }, []],
      ['mcp__session__project_learning', { operation: 'list' }, []],
      ['mcp__session__unbind_messaging_channel', { channel: 'gmail' }, []],
      ['mcp__session__transform_data', { input: 'receipt' }, []],
      ['Agent', { prompt: 'Inspect.' }, []],
      ['Task', { prompt: 'Inspect.' }, []],
      ['Workflow', { steps: [] }, []],
      ['Read', { file_path: '/etc/passwd' }, []],
    ] as const;
    for (const [toolName, input, sources] of cases) {
      expect(check({
        toolName,
        input,
        permissionMode: 'allow-all',
        objectiveMutationAuthorized: false,
        objectiveTerminalReconciliationPolicy: terminalPolicy(),
        activeSourceSlugs: [...sources],
        allSourceSlugs: [...sources],
      })).toMatchObject({
        type: 'block',
        reason: (expect.stringContaining('Terminal reconciliation is host-locked') as unknown),
      });
    }

    expect(check({
      toolName: 'mcp__google-contacts__gmail_verify_sent_message',
      input: { messageId: 'sent-1' },
      permissionMode: 'allow-all',
      objectiveMutationAuthorized: false,
      objectiveTerminalReconciliationPolicy: terminalPolicy({
        readReplays: [{
          toolName: 'mcp__google-contacts__gmail_verify_sent_message',
          toolInputJson: '{"messageId":"sent-1"}',
        }],
      }),
      activeSourceSlugs: ['google-contacts'],
      allSourceSlugs: ['google-contacts'],
      declaredToolCapabilities: { readOnly: true, idempotent: true, trusted: true },
    }).type).toBe('allow');

    expect(check({
      toolName: 'mcp__google-contacts__gmail_verify_sent_message',
      input: { messageId: 'sent-1' },
      permissionMode: 'allow-all',
      objectiveMutationAuthorized: false,
      objectiveTerminalReconciliationPolicy: terminalPolicy({
        readReplays: [{
          toolName: 'mcp__google-contacts__gmail_verify_sent_message',
          toolInputJson: '{"messageId":"sent-1"}',
        }],
      }),
      activeSourceSlugs: [],
      allSourceSlugs: ['google-contacts'],
      hasSourceActivation: true,
      declaredToolCapabilities: { readOnly: true, idempotent: true, trusted: true },
    })).toMatchObject({
      type: 'block',
      reason: (expect.stringContaining('cannot activate inactive source') as unknown),
    });
    for (const mode of ['first', 'all'] as const) {
      expect(check({
        toolName: 'mcp__session__wait_sessions',
        input: { sessionIds: ['existing-review'], mode },
        permissionMode: 'allow-all',
        objectiveMutationAuthorized: false,
        objectiveTerminalReconciliationPolicy: terminalPolicy({ waitReviewerSessionIds: ['existing-review'] }),
      })).toMatchObject({
        type: 'modify',
        input: {
          sessionIds: ['existing-review'],
          mode,
          _hostTerminalReconciliationCapability: (expect.any(String) as unknown),
        },
      });
    }
    expect(check({
      toolName: 'mcp__session__spawn_session',
      input: { prompt: 'Review the exact bound target.', role: 'reviewer', permissionMode: 'safe' },
      permissionMode: 'allow-all',
      objectiveMutationAuthorized: false,
      objectiveTerminalReconciliationPolicy: terminalPolicy({ allowReviewerSpawn: true }),
    })).toMatchObject({
      type: 'spawn_session_intercept',
      input: {
        prompt: 'Review the exact bound target.',
        role: 'reviewer',
        permissionMode: 'safe',
        _hostTerminalReconciliationCapability: (expect.any(String) as unknown),
      },
    });

    for (const input of [
      { messageId: 'SENT-1' },
      { messageId: 'sent-1 ' },
      { messageId: 'sent-1', maxResults: 1 },
    ]) {
      expect(check({
        toolName: 'mcp__google-contacts__gmail_verify_sent_message',
        input,
        permissionMode: 'allow-all',
        objectiveMutationAuthorized: false,
        objectiveTerminalReconciliationPolicy: terminalPolicy({
          readReplays: [{
            toolName: 'mcp__google-contacts__gmail_verify_sent_message',
            toolInputJson: '{"messageId":"sent-1"}',
          }],
        }),
        activeSourceSlugs: ['google-contacts'],
        allSourceSlugs: ['google-contacts'],
        declaredToolCapabilities: { readOnly: true, idempotent: true, trusted: true },
      }).type).toBe('block');
    }

    expect(check({
      toolName: 'mcp__google-contacts__gmail_verify_sent_message',
      input: { messageId: 'sent-1', _intent: 'fresh UI prose', _displayName: 'Verify' },
      permissionMode: 'allow-all',
      objectiveMutationAuthorized: false,
      objectiveTerminalReconciliationPolicy: terminalPolicy({
        readReplays: [{
          toolName: 'mcp__google-contacts__gmail_verify_sent_message',
          toolInputJson: '{"messageId":"sent-1"}',
        }],
      }),
      activeSourceSlugs: ['google-contacts'],
      allSourceSlugs: ['google-contacts'],
      declaredToolCapabilities: { readOnly: true, idempotent: true, trusted: true },
    })).toEqual({ type: 'modify', input: { messageId: 'sent-1' } });
  });
});
