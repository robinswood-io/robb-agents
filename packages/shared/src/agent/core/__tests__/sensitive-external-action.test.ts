import { afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  cleanupModeState,
  initializeModeState,
  type PermissionMode,
} from '../../mode-manager.ts';
import {
  runPreToolUseChecks,
  type PermissionManagerLike,
} from '../pre-tool-use.ts';
import {
  classifySensitiveExternalAction,
  isSensitiveExternalActionExplicitlyAuthorized,
} from '../sensitive-external-action.ts';

const usedSessionIds: string[] = [];

const whitelistedPermissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => true,
  isDangerousCommand: () => false,
  getBaseCommand: (command) => command.split(/\s+/)[0] ?? command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => true,
};

afterEach(() => {
  for (const sessionId of usedSessionIds.splice(0)) cleanupModeState(sessionId);
});

function checkBash(
  mode: PermissionMode,
  command: string,
  currentUserRequest?: string,
) {
  const sessionId = `sensitive-action-${randomUUID()}`;
  usedSessionIds.push(sessionId);
  initializeModeState(sessionId, mode);
  return runPreToolUseChecks({
    toolName: 'Bash',
    input: { command },
    sessionId,
    permissionMode: mode,
    workspaceRootPath: '/tmp/robb-sensitive-action-test',
    workspaceId: 'sensitive-action-test',
    activeSourceSlugs: [],
    allSourceSlugs: [],
    hasSourceActivation: false,
    permissionManager: whitelistedPermissionManager,
    currentUserRequest,
  });
}

describe('sensitive external action classifier', () => {
  it('classifies the audited SSH mutations', () => {
    const push = classifySensitiveExternalAction('Bash', {
      command: "ssh deploy@prod.example 'cd /srv/app && git push origin main'",
    });
    expect(push?.category).toBe('git_push');
    expect(push?.targetCandidates).toContain('deploy@prod.example');

    const compose = classifySensitiveExternalAction('Bash', {
      command: "ssh deploy@prod.example 'docker compose --profile prod up -d --no-deps work-prod-backend'",
    });
    expect(compose?.category).toBe('deployment');
    expect(compose?.targetCandidates).toContain('work-prod-backend');

    const secretWrite = classifySensitiveExternalAction('Bash', {
      command: `ssh deploy@prod.example "python3 - <<'PY'
from pathlib import Path
source = Path('backend/.env').read_text()
key = [line for line in source.splitlines() if line.startswith('NIGHT_AGENT_API_KEY=')][0]
prod = Path('.env.prod')
prod.write_text(key + '\\n')
PY"`,
    });
    expect(secretWrite?.category).toBe('secret_transfer');
    expect(secretWrite?.commandPreview).not.toContain('NIGHT_AGENT_API_KEY');
  });

  it('does not classify reads, dry-runs, or quoted command text', () => {
    const safeCommands = [
      'git status',
      'git push --dry-run origin main',
      "echo 'git push origin main'",
      "ssh deploy@prod.example 'grep NIGHT_AGENT_API_KEY backend/.env'",
      `ssh deploy@prod.example "python3 - <<'PY'
from pathlib import Path
print(Path('backend/.env').read_text())
PY"`,
    ];
    for (const command of safeCommands) {
      expect(classifySensitiveExternalAction('Bash', { command })).toBeNull();
    }
    expect(classifySensitiveExternalAction('mcp__gmail__search_messages', { query: 'invoice' })).toBeNull();
    expect(classifySensitiveExternalAction('api_github', { method: 'GET', path: '/repos/acme/widgets/issues' })).toBeNull();
  });

  it('classifies high-confidence MCP and API sends, publications, secrets, and payments', () => {
    expect(classifySensitiveExternalAction(
      'mcp__gmail__send_email',
      { to: 'alice@example.com', subject: 'Hello' },
    )?.category).toBe('external_send');
    expect(classifySensitiveExternalAction(
      'mcp__github__create_issue',
      { repository: 'acme/widgets', title: 'Bug' },
    )?.category).toBe('external_publication');
    expect(classifySensitiveExternalAction(
      'mcp__broker__create_order',
      { account_id: 'acct-7', symbol: 'ACME' },
    )?.category).toBe('payment');
    expect(classifySensitiveExternalAction(
      'mcp__cloud__set_secret',
      { project: 'prod-api', value: 'do-not-display' },
    )?.category).toBe('secret_transfer');
    expect(classifySensitiveExternalAction(
      'api_github',
      { method: 'POST', path: '/repos/acme/widgets/issues' },
    )?.category).toBe('external_publication');
  });

  it('never throws on malformed curl destinations and keeps secret previews redacted', () => {
    expect(() => classifySensitiveExternalAction('Bash', {
      command: "curl --data 'token=${API_TOKEN}' http://",
    })).not.toThrow();
    const action = classifySensitiveExternalAction('Bash', {
      command: "curl --data 'token=${API_TOKEN}' http://",
    });
    expect(action?.category).toBe('secret_transfer');
    expect(action?.commandPreview).toBe('[Sensitive credential operation — values redacted]');
  });

  it('requires both an explicit action and the concrete target', () => {
    const action = classifySensitiveExternalAction('Bash', {
      command: 'git push origin main',
    });
    expect(action).not.toBeNull();
    if (!action) return;

    expect(isSensitiveExternalActionExplicitlyAuthorized(action, 'Poursuis')).toBeFalse();
    expect(isSensitiveExternalActionExplicitlyAuthorized(action, 'Push origin main')).toBeTrue();
    expect(isSensitiveExternalActionExplicitlyAuthorized(action, 'Pousse origin main')).toBeTrue();
    expect(isSensitiveExternalActionExplicitlyAuthorized(action, 'Push upstream main')).toBeFalse();
  });

  it('rejects negations, questions, and analysis requests in English and French', () => {
    const push = classifySensitiveExternalAction('Bash', {
      command: 'git push origin main',
    });
    expect(push).not.toBeNull();
    if (!push) return;

    for (const request of [
      'Do not push origin main',
      "Don't push origin main",
      'How do I push origin main?',
      'Explain how to push origin main',
      'Ne pousse pas origin main',
      'Comment pousser origin main ?',
      'Explique comment pousser origin main',
    ]) {
      expect(isSensitiveExternalActionExplicitlyAuthorized(push, request)).toBeFalse();
    }

    const deployment = classifySensitiveExternalAction('Bash', {
      command: 'npm run deploy -- --environment prod',
    });
    expect(deployment).not.toBeNull();
    if (!deployment) return;
    expect(isSensitiveExternalActionExplicitlyAuthorized(
      deployment,
      'Analyse le déploiement prod',
    )).toBeFalse();
    expect(isSensitiveExternalActionExplicitlyAuthorized(
      deployment,
      'Analyse puis déploie prod',
    )).toBeFalse();
  });
});

describe('sensitive external action gate across permission modes', () => {
  it('keeps Explore fail-closed', () => {
    expect(checkBash('safe', 'git push origin main', 'Push origin main').type).toBe('block');
  });

  it('prompts before Ask-mode whitelists for a generic continuation', () => {
    const result = checkBash('ask', 'git push origin main', 'Poursuis');
    expect(result.type).toBe('prompt');
    if (result.type === 'prompt') expect(result.requiresExplicitConfirmation).toBeTrue();
  });

  it('prompts in Execute for generic or wrong-target requests', () => {
    const generic = checkBash('allow-all', 'git push origin main', 'Continue please');
    expect(generic.type).toBe('prompt');
    if (generic.type === 'prompt') expect(generic.requiresExplicitConfirmation).toBeTrue();

    expect(checkBash('allow-all', 'git push origin main', 'Push upstream main').type).toBe('prompt');
    expect(checkBash('allow-all', 'git push origin main', 'Do not push origin main').type).toBe('prompt');
    expect(checkBash('allow-all', 'git push origin main', 'Comment pousser origin main ?').type).toBe('prompt');
  });

  it('accepts an explicit action+target without adding a second confirmation', () => {
    expect(checkBash('allow-all', 'git push origin main', 'Push origin main').type).toBe('allow');
    expect(checkBash('allow-all', 'git push origin main', 'Pousse origin main').type).toBe('allow');
    // The mock whitelist proves the dedicated guard also steps aside in Ask
    // once the current request itself authorizes the exact action and target.
    expect(checkBash('ask', 'git push origin main', 'Push origin main').type).toBe('allow');
  });

  it('leaves ordinary local operations alone in Execute', () => {
    expect(checkBash('allow-all', 'bun test', 'Poursuis').type).toBe('allow');
  });
});
