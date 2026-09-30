import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { permissionsConfigCache } from '../../permissions-config.ts';
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
      })).toMatchObject({ type: 'block', reason: expect.stringContaining('installed Robb Agents') });
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
    }, 'Corrige ce contrat juridique.')).toMatchObject({ type: 'block', reason: expect.stringContaining('High-stakes evidence gate') });
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
        reason: expect.stringContaining('Objective authority'),
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
      })).toMatchObject({ type: 'block', reason: expect.stringContaining('Objective authority') });
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
      })).toMatchObject({ type: 'block', reason: expect.stringContaining('Explore') });
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
      })).toMatchObject({ type: 'block', reason: expect.stringContaining('Explore') });
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
        reason: expect.stringContaining('Terminal reconciliation is host-locked'),
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
      reason: expect.stringContaining('cannot activate inactive source'),
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
          _hostTerminalReconciliationCapability: expect.any(String),
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
        _hostTerminalReconciliationCapability: expect.any(String),
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

  it('never replays external browser tools during terminal reconciliation', () => {
    const normalRead = {
      toolName: 'mcp__crm__search',
      input: { query: 'customer-1' },
      permissionMode: 'allow-all' as const,
      objectiveMutationAuthorized: false,
      activeSourceSlugs: ['crm'],
      allSourceSlugs: ['crm'],
      declaredToolCapabilities: { readOnly: true, idempotent: true, trusted: true },
    };
    expect(check({
      ...normalRead,
      objectiveTerminalReconciliationPolicy: terminalPolicy({
        readReplays: [{
          toolName: normalRead.toolName,
          toolInputJson: '{"query":"customer-1"}',
        }],
      }),
    }).type).toBe('allow');

    for (const [toolName, input, sourceSlug] of [
      ['mcp__playwright__browser_snapshot', {}, 'playwright'],
      ['mcp__playwright__playwright_navigate', { url: 'https://example.com' }, 'playwright'],
      ['mcp__puppeteer__puppeteer_screenshot', {}, 'puppeteer'],
    ] as const) {
      expect(check({
        toolName,
        input,
        permissionMode: 'allow-all',
        objectiveMutationAuthorized: false,
        objectiveTerminalReconciliationPolicy: terminalPolicy({
          readReplays: [{ toolName, toolInputJson: JSON.stringify(input) }],
        }),
        activeSourceSlugs: [sourceSlug],
        allSourceSlugs: [sourceSlug],
        declaredToolCapabilities: { readOnly: true, idempotent: true, trusted: true },
      })).toMatchObject({
        type: 'block',
        reason: expect.stringContaining('Terminal reconciliation is host-locked'),
      });
    }
  });

  it('applies authenticated non-browser constraints to external browser aliases', () => {
    const objectiveAuthorizationSegments = [
      'Inspecte le dossier exclusivement via API ; ne passe jamais par le navigateur.',
    ];
    for (const [toolName, input, sourceSlug, declaredToolCapabilities] of [
      [
        'mcp__playwright__browser_snapshot', {}, 'playwright',
        { readOnly: true, idempotent: true, trusted: true },
      ],
      ['mcp__playwright__browser_click', { ref: '@e1' }, 'playwright', undefined],
      ['mcp__puppeteer__puppeteer_click', { selector: '#submit' }, 'puppeteer', undefined],
    ] as const) {
      expect(check({
        toolName,
        input,
        permissionMode: 'allow-all',
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments,
        activeSourceSlugs: [sourceSlug],
        allSourceSlugs: [sourceSlug],
        declaredToolCapabilities,
      })).toMatchObject({
        type: 'block',
        reason: expect.stringContaining('User channel constraint'),
      });
    }
  });

  it('does not let an observational objective delegate mutation through an existing session', () => {
    for (const toolName of [
      'send_agent_message',
      'session__send_agent_message',
      'mcp__session__send_agent_message',
    ]) {
      expect(check({
        toolName,
        input: { sessionId: 'worker-1', message: 'Publie maintenant le résultat.' },
        permissionMode: 'allow-all',
        objectiveMutationAuthorized: false,
      })).toMatchObject({ type: 'block', reason: expect.stringContaining('Objective authority') });
    }

    expect(check({
      toolName: 'mcp__session__wait_sessions',
      input: { sessionIds: ['worker-1'] },
      permissionMode: 'allow-all',
      objectiveMutationAuthorized: false,
    }).type).toBe('allow');
  });

  it('classifies a read-only remote shell command from its input semantics', () => {
    expect(classifyToolEffect(
      'mcp__rbw-servers__ssh_execute',
      { command: 'pwd && ls -la /srv/workspace' },
      { workspaceRootPath, activeSourceSlugs: ['rbw-servers'] },
    )).toMatchObject({
      kind: 'read',
      reversibility: 'not-applicable',
      source: 'input-semantics',
    });
  });

  it('does not prompt for a verified read-only SSH command in Ask mode', () => {
    expect(check({ input: { command: 'pwd && ls -la /srv/workspace' } }).type).toBe('allow');
  });

  it('uses the same hardened Git observation grammar for local and remote permissions', () => {
    const safeGit = 'git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c log.showSignature=false -c format.pretty=medium --no-pager';
    const legacyGitWithoutSignatureGuards = 'git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null --no-pager';
    const safeCommands = [
      `${safeGit} rev-parse HEAD`,
      `${safeGit} ls-files --cached`,
      `${safeGit} grep -n bridge_unavailable -- packages`,
      `${safeGit} log --oneline --no-patch -n 3`,
      `${safeGit} rev-parse HEAD && ${safeGit} branch --show-current`,
    ];
    for (const command of safeCommands) {
      expect(classifyToolEffect(
        'Bash', { command }, { workspaceRootPath, activeSourceSlugs: [] },
      )).toMatchObject({ kind: 'read', source: 'input-semantics' });
      expect(classifyToolEffect(
        'mcp__rbw-servers__ssh_execute', { command },
        { workspaceRootPath, activeSourceSlugs: ['rbw-servers'] },
      )).toMatchObject({ kind: 'read', source: 'input-semantics' });
      expect(check({ toolName: 'Bash', input: { command }, permissionMode: 'safe' }).type)
        .toBe('allow');
      expect(check({
        input: { server: 'dev', cwd: '/srv/workspace/orion', command },
        permissionMode: 'allow-all',
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: false,
      }).type).toBe('allow');
    }

    const localRetry = check({
      toolName: 'Bash',
      input: { command: 'git rev-parse HEAD' },
      permissionMode: 'safe',
    });
    expect(localRetry).toMatchObject({
      type: 'block',
      reason: expect.stringContaining(
        'git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c log.showSignature=false -c format.pretty=medium --no-pager',
      ),
    });
    const localObjectiveRetry = check({
      toolName: 'Bash',
      input: { command: 'git status --short' },
      permissionMode: 'allow-all',
      objectiveMutationAuthorized: false,
    });
    const localObjectiveRetryText = localObjectiveRetry.type === 'block'
      ? String(localObjectiveRetry.reason)
      : '';
    expect(localObjectiveRetry).toMatchObject({
      type: 'block',
      reason: expect.stringContaining('Git status, diff, show and patch/stat log output remain blocked'),
    });
    expect(localObjectiveRetryText).toContain('target-bound Read/rg/cmp');
    expect(localObjectiveRetryText).not.toContain(
      'git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c log.showSignature=false -c format.pretty=medium --no-pager status',
    );
    const remoteRetry = check({
      input: { server: 'dev', cwd: '/srv/workspace/orion', command: 'git rev-parse HEAD' },
      permissionMode: 'allow-all',
      externalActionPolicy: 'allow-in-execute',
      objectiveMutationAuthorized: false,
    });
    expect(remoteRetry).toMatchObject({
      type: 'block',
      reason: expect.stringContaining(
        'git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c log.showSignature=false -c format.pretty=medium --no-pager',
      ),
    });

    for (const command of [
      'git --no-pager status --short',
      'git --no-optional-locks -ccore.fsmonitor=false -c core.hooksPath=/dev/null --no-pager status --short',
      `${safeGit} -c core.fsmonitor=/tmp/evil status --short`,
      `${safeGit} -c core.pager=/tmp/evil status --short`,
      `${safeGit} -c log.showSignature=true log --no-patch -n 1`,
      `${safeGit} -c format.pretty=%G? log --no-patch -n 1`,
      `${safeGit} log --format=%G? -1`,
      `${safeGit} log --show-signature --no-patch -n 1`,
      `${legacyGitWithoutSignatureGuards} log --no-patch -n 1`,
      `${safeGit} --paginate status --short`,
      `${safeGit} status --short && git log -1`,
      `${safeGit} status --short`,
      `${safeGit} diff --check`,
      `${safeGit} show HEAD`,
      `${safeGit} log -p -n 1`,
      `${safeGit} grep -f /tmp/patterns`,
      `${safeGit} grep --file=/tmp/patterns bridge_unavailable`,
      `${safeGit} ls-files --exclude-from=/tmp/excludes`,
      '/tmp/git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c log.showSignature=false -c format.pretty=medium --no-pager rev-parse HEAD',
      './git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c log.showSignature=false -c format.pretty=medium --no-pager rev-parse HEAD',
      'Git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null --no-pager rev-parse HEAD',
    ]) {
      expect(classifyToolEffect(
        'Bash', { command }, { workspaceRootPath, activeSourceSlugs: [] },
      )).toMatchObject({ kind: 'unknown' });
      expect(classifyToolEffect(
        'mcp__rbw-servers__ssh_execute', { command },
        { workspaceRootPath, activeSourceSlugs: ['rbw-servers'] },
      )).toMatchObject({ kind: 'external-mutation' });
      expect(check({ toolName: 'Bash', input: { command }, permissionMode: 'safe' }))
        .toMatchObject({ type: 'block', reason: expect.stringContaining('Explore') });
      expect(check({
        input: { server: 'dev', cwd: '/srv/workspace/orion', command },
        permissionMode: 'allow-all',
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: false,
      })).toMatchObject({ type: 'block', reason: expect.stringContaining('Objective authority') });
    }
  });

  it('blocks a Bash SSH retry of a rejected composite remote observation', () => {
    const command = `ssh -i ~/.ssh/id_ecdsa_vps -o BatchMode=yes -o ConnectTimeout=15 ubuntu@164.132.161.150 'cd /srv/workspace/zero && printf "REV=" && git rev-parse HEAD && printf "\\nSTATUS\\n" && git status --short && printf "\\nFILES\\n" && for f in "app/(auth)/login/page.tsx" "tests/dev-login-isolation.test.ts"; do if test -f "$f"; then sha256sum "$f"; else printf "MISSING  %s\\n" "$f"; fi; done; printf "\\nCONTAINER\\n"; docker ps --filter name="^/zero$" --format "{{.Names}}|{{.Image}}|{{.Status}}"'`;
    const result = check({
      toolName: 'Bash',
      input: { command },
      permissionMode: 'allow-all',
      externalActionPolicy: 'allow-in-execute',
      objectiveMutationAuthorized: true,
    });
    const reason = result.type === 'block' ? String(result.reason) : '';
    expect(result).toMatchObject({
      type: 'block',
      reason: expect.stringContaining('composite remote command'),
    });
    expect(reason).toContain('separate `ssh_execute` calls');
    expect(reason).toContain('Do not bypass a structured SSH refusal');
  });

  it.each([
    ['Bash', 'ssh host "pwd"'],
    ['functions.bash', "/usr/bin/ssh host 'pwd'"],
    ['functions.exec_command', '/bin/ssh host "rm -rf /srv/target"'],
    ['mcp__ops__exec_command', 'command ssh host pwd'],
    ['shell', 'command -- /usr/bin/ssh host pwd'],
    ['Bash', 'env ssh host pwd'],
    ['functions.bash', 'sudo -n -u deploy /bin/ssh host pwd'],
  ])('blocks local SSH transport in Execute regardless of payload: %s', (toolName, command) => {
    const result = check({
      toolName,
      input: { command },
      permissionMode: 'allow-all',
      externalActionPolicy: 'allow-in-execute',
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
    });
    const reason = result.type === 'block' ? String(result.reason) : '';
    expect(result).toMatchObject({ type: 'block' });
    expect(reason).toContain('Local SSH transport through Bash/shell is disabled');
    expect(reason).toContain('ssh_execute');
  });

  it.each(['safe', 'ask', 'allow-all'] as const)(
    'blocks local SSH transport before the %s permission-mode policy',
    permissionMode => {
      const result = check({
        toolName: 'Bash',
        input: { command: 'ssh host pwd' },
        permissionMode,
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
      });
      expect(result).toMatchObject({
        type: 'block',
        reason: expect.stringContaining('Local SSH transport through Bash/shell is disabled'),
      });
    },
  );

  it('does not block inert quoted SSH examples as transport', () => {
    for (const command of [
      "echo 'ssh host pwd'",
      "printf '%s\\n' 'ssh host pwd'",
      "grep 'ssh host' commands.txt",
      'command -v ssh',
      'env echo ssh host pwd',
      'sudo echo ssh host pwd',
    ]) {
      const result = check({
        toolName: 'Bash', input: { command }, permissionMode: 'allow-all',
        externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
      });
      expect(result.type === 'block' ? String(result.reason) : '')
        .not.toContain('Local SSH transport');
    }
  });

  it('keeps bounded operational SSH reads out of sensitive mutation authority', () => {
    for (const command of [
      'curl -fsS http://127.0.0.1:8888/api/v1/health',
      'curl -fsSI https://service.example.test',
      'systemctl show plc-silae-sync.service -p ActiveState -p SubState -p ExecMainStatus',
      "docker inspect pnsgen-app --format '{{.State.Health.Status}}'",
    ]) {
      expect(classifyToolEffect(
        'mcp__rbw-servers__ssh_execute',
        { command },
        { workspaceRootPath, activeSourceSlugs: ['rbw-servers'] },
      )).toMatchObject({ kind: 'read', source: 'input-semantics' });
      expect(check({
        input: { server: 'pns', cwd: '/srv/pnsgen', command },
        permissionMode: 'allow-all',
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: false,
      }).type).toBe('allow');
    }
  });

  it('admits a single bounded source read on an explicitly authorized SSH target', () => {
    const objective = 'Diagnostique et corrige la synchronisation e-doc du contrat PNS 3602 uniquement via rbw-servers/SSH structuré.';
    const input = {
      server: 'pns',
      command: "sed -n '1,340p' /srv/pnsgen/server/services/signatureQueueService.ts",
      _displayName: 'Lire service de file',
      _intent: 'Comprendre la persistance du job e-doc.',
    };
    expect(classifyToolEffect(
      'mcp__rbw-servers__ssh_execute', input,
      { workspaceRootPath, activeSourceSlugs: ['rbw-servers'] },
    )).toMatchObject({ kind: 'external-mutation', source: 'input-semantics' });
    const decision = check({
      input,
      permissionMode: 'allow-all',
      externalActionPolicy: 'allow-in-execute',
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: [objective],
    }, objective);
    // UI-only metadata is stripped through the normal `modify` result; both
    // outcomes execute the unchanged command instead of blocking it.
    expect(decision.type === 'allow' || decision.type === 'modify').toBeTrue();
  });

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
        type: 'block', reason: expect.stringContaining('Structured SSH read validation failed'),
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
      type: 'block', reason: expect.stringContaining('composite remote command'),
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
      type: 'block', reason: expect.stringContaining('Objective authority'),
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
        type: 'block', reason: expect.stringContaining('Structured SSH read validation failed'),
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

    for (const command of invocations.slice(1).map(([, input]) => String(input.command))) {
      expect(check({
        toolName: 'mcp__rbw-servers__ssh_execute',
        input: { server: 'dev', command }, dataFolderPath, ...authorization,
      })).toMatchObject({
        type: 'block', reason: expect.stringContaining('Structured SSH read validation failed'),
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
        type: 'block', reason: expect.stringContaining('Structured SSH read validation failed'),
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
      type: 'block', reason: expect.stringContaining('Structured SSH read validation failed'),
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
      type: 'block', reason: expect.stringContaining('Structured SSH read validation failed'),
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
      type: 'block', reason: expect.stringContaining('installed Robb Agents'),
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
    })).toMatchObject({ type: 'block', reason: expect.stringContaining('Explore') });
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
      })).toMatchObject({ type: 'block', reason: expect.stringContaining('Objective authority') });
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
      })).toMatchObject({ type: 'block', reason: expect.stringContaining('Objective authority') });
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
