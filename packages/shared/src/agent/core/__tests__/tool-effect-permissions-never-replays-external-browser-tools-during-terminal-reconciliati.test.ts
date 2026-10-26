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
});
