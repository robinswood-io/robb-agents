import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { cleanupModeState, initializeModeState, type PermissionMode } from "../../mode-manager.ts";
import { clearContextualGmailPreflightAttestation, runPreToolUseChecks } from "../pre-tool-use.ts";
import { classifySensitiveExternalAction, isSensitiveExternalActionAuthorizedByObjective, isSensitiveExternalActionExplicitlyAuthorized } from "../sensitive-external-action.ts";
import { whitelistedPermissionManager } from "./testing/sensitive-external-action-fixture.ts";

const usedSessionIds: string[] = [];
const temporaryPaths: string[] = [];
function checkBash(
  mode: PermissionMode,
  command: string,
  currentUserRequest?: string,
  externalActionPolicy?: 'confirm' | 'allow-in-execute',
  objectiveMutationAuthorized?: boolean,
  objectiveAuthorizationSegments?: readonly string[],
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
    externalActionPolicy,
    objectiveMutationAuthorized,
    objectiveAuthorizationSegments,
    permissionManager: whitelistedPermissionManager,
    currentUserRequest,
  });
}
function checkMcp(
  mode: PermissionMode,
  toolName: string,
  input: Record<string, unknown>,
  currentUserRequest?: string,
  options?: {
    externalActionPolicy?: 'confirm' | 'allow-in-execute';
    objectiveMutationAuthorized?: boolean;
    objectiveSensitiveActionAuthorized?: boolean;
    objectiveAuthorizationSegments?: readonly string[];
    authenticatedUserAuthorizationSegments?: readonly string[];
    dataFolderPath?: string;
    declaredToolCapabilities?: {
      readOnly?: boolean;
      idempotent?: boolean;
      destructive?: boolean;
      openWorld?: boolean;
      trusted?: boolean;
    };
    sessionId?: string;
  },
) {
  const markerSessionId = toolName === 'mcp__rbw-agents-oss__oss_write_file'
    ? /^\[robb-resume:([a-z0-9]+(?:-[a-z0-9]+)*):/mu.exec(
      options?.objectiveAuthorizationSegments?.find(segment => /^\[robb-resume:/mu.test(segment))
        ?? currentUserRequest ?? '',
    )?.[1]
    : undefined;
  const sessionId = options?.sessionId ?? markerSessionId ?? `sensitive-action-${randomUUID()}`;
  usedSessionIds.push(sessionId);
  initializeModeState(sessionId, mode);
  const sourceSlug = toolName.split('__')[1] ?? '';
  return runPreToolUseChecks({
    toolName,
    input,
    sessionId,
    toolUseId: `call-${randomUUID()}`,
    permissionMode: mode,
    workspaceRootPath: '/tmp/robb-sensitive-action-test',
    workspaceId: 'sensitive-action-test',
    activeSourceSlugs: [sourceSlug],
    allSourceSlugs: [sourceSlug],
    hasSourceActivation: false,
    externalActionPolicy: options?.externalActionPolicy,
    objectiveMutationAuthorized: options?.objectiveMutationAuthorized,
    objectiveSensitiveActionAuthorized: options?.objectiveSensitiveActionAuthorized,
    objectiveAuthorizationSegments: options?.objectiveAuthorizationSegments,
    authenticatedUserAuthorizationSegments: options?.authenticatedUserAuthorizationSegments,
    dataFolderPath: options?.dataFolderPath,
    declaredToolCapabilities: options?.declaredToolCapabilities,
    permissionManager: whitelistedPermissionManager,
    currentUserRequest,
  });
}

afterEach(() => {
  setSystemTime();
  for (const sessionId of usedSessionIds.splice(0)) {
    clearContextualGmailPreflightAttestation(sessionId);
    cleanupModeState(sessionId);
  }
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('sensitive external action classifier', () => {
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

  it('classifies uncategorized MCP and API writes as target-bound external mutations', () => {
    expect(classifySensitiveExternalAction(
      'mcp__todo__delete_task',
      { task_id: 'task-7' },
    )).toMatchObject({ category: 'external_mutation', targetCandidates: ['task-7'] });
    expect(classifySensitiveExternalAction(
      'api_jobs',
      { method: 'DELETE', path: '/jobs/7', id: '7' },
    )).toMatchObject({ category: 'external_mutation', targetCandidates: ['7'] });
    expect(classifySensitiveExternalAction(
      'api_jobs',
      { method: 'DELETE', path: '/jobs/7' },
    )).toMatchObject({ category: 'external_mutation', targetCandidates: ['7'] });
    expect(classifySensitiveExternalAction(
      'mcp__todo__delete_task',
      { task_id: 7 },
    )).toMatchObject({ category: 'external_mutation', targetCandidates: ['7'] });
    expect(classifySensitiveExternalAction(
      'mcp__todo__delete_task',
      { task_id: [7, 'task-8', false, { value: 9 }] },
    )).toMatchObject({
      category: 'external_mutation',
      targetCandidates: ['7', 'task-8', 'additional unresolved targets'],
    });
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

  it('requires exact canonical matches for structured targets', () => {
    const email = classifySensitiveExternalAction('mcp__gmail__send_email', {
      to: 'alice@example.com', subject: 'Hello',
    });
    expect(email && isSensitiveExternalActionExplicitlyAuthorized(
      email, 'Envoie à alice@example.net.',
    )).toBeFalse();
    expect(email && isSensitiveExternalActionExplicitlyAuthorized(
      email, 'Envoie à alice@example.com.',
    )).toBeTrue();
    expect(email && isSensitiveExternalActionExplicitlyAuthorized(
      email, 'Envoie à alice@example.com.evil.',
    )).toBeFalse();

    const host = classifySensitiveExternalAction('Bash', {
      command: "curl -X POST https://api.example.com/jobs -d '{\"run\":true}'",
    });
    expect(host && isSensitiveExternalActionExplicitlyAuthorized(
      host, 'Post api.example.net.',
    )).toBeFalse();
    expect(host && isSensitiveExternalActionExplicitlyAuthorized(
      host, 'Post api.example.com.evil.',
    )).toBeFalse();

    const repo = classifySensitiveExternalAction('mcp__github__create_issue', {
      repository: 'acme/widgets', title: 'Bug',
    });
    expect(repo && isSensitiveExternalActionExplicitlyAuthorized(
      repo, 'Crée une issue sur acme/other-widgets.',
    )).toBeFalse();
    expect(repo && isSensitiveExternalActionExplicitlyAuthorized(
      repo, 'Crée une issue sur acme/widgets-fork.',
    )).toBeFalse();

    const push = classifySensitiveExternalAction('Bash', { command: 'git push origin main' });
    expect(push && isSensitiveExternalActionExplicitlyAuthorized(push, 'Push origin main.')).toBeTrue();
    expect(push && isSensitiveExternalActionExplicitlyAuthorized(push, 'Push origin main, maintenant.')).toBeTrue();
    expect(push && isSensitiveExternalActionExplicitlyAuthorized(push, 'Push origin main:')).toBeTrue();
    expect(push && isSensitiveExternalActionExplicitlyAuthorized(push, 'Push origin main-backup.')).toBeFalse();
  });

  it('never treats a prohibited target or object ID as positive authority', () => {
    const recipients = classifySensitiveExternalAction('mcp__gmail__send_email', {
      to: 'alice@example.com', bcc: 'bob@example.com', subject: 'Status',
    });
    expect(recipients && isSensitiveExternalActionExplicitlyAuthorized(
      recipients,
      'Envoie le statut à alice@example.com. bob@example.com est interdit.',
    )).toBeFalse();
    expect(recipients && isSensitiveExternalActionExplicitlyAuthorized(
      recipients,
      'Envoie le statut à alice@example.com, mais pas à bob@example.com.',
    )).toBeFalse();
    for (const request of [
      'Envoie le statut à alice@example.com, mais pas bob@example.com.',
      'Envoie le statut à alice@example.com et non à bob@example.com.',
      'Send the status to alice@example.com, not bob@example.com.',
    ]) {
      expect(recipients && isSensitiveExternalActionExplicitlyAuthorized(recipients, request)).toBeFalse();
    }

    const wrongContract = classifySensitiveExternalAction('mcp__rbw-servers__ssh_execute', {
      server: 'pns', cwd: '/srv/pnsgen',
      command: "curl -fsS -X POST http://127.0.0.1:8888/api/contracts/9999/send -d '{\"email\":\"sender@example.test\"}'",
    });
    expect(wrongContract && isSensitiveExternalActionExplicitlyAuthorized(
      wrongContract,
      'Envoie le contrat 3598 depuis PNS Gen à sender@example.test. Le contrat 9999 est interdit.',
    )).toBeFalse();
    for (const request of [
      'Envoie le contrat 3598 depuis PNS Gen à sender@example.test, mais pas le contrat 9999.',
      'Envoie le contrat 3598 depuis PNS Gen à sender@example.test, sauf le contrat 9999.',
    ]) {
      expect(wrongContract && isSensitiveExternalActionExplicitlyAuthorized(wrongContract, request)).toBeFalse();
    }

    expect(checkMcp(
      'allow-all', 'mcp__gmail__send_email',
      { to: 'bob@example.com', subject: 'Status' }, 'Pas à bob@example.com.', {
        externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
        objectiveAuthorizationSegments: [
          'Envoie le statut à bob@example.com.',
          'Pas à bob@example.com.',
        ],
      },
    )).toMatchObject({ type: 'block', reason: expect.stringContaining('exact target') });
    for (const amendment of [
      'bob@example.com n’est pas autorisé.',
      'bob@example.com is not allowed.',
    ]) {
      expect(checkMcp(
        'allow-all', 'mcp__gmail__send_email',
        { to: 'bob@example.com', subject: 'Status' }, amendment, {
          externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
          objectiveAuthorizationSegments: ['Envoie le statut à bob@example.com.', amendment],
        },
      )).toMatchObject({ type: 'block' });
    }

    const bob = classifySensitiveExternalAction('mcp__mailer__send_email', { to: 'Bob' });
    for (const request of [
      'Send to Bob. Do not send to Bob.',
      'Envoie à Bob. N’envoie pas à Bob.',
      'Envoie à Bob. Pas à Bob.',
      'Send to Bob; Bob is forbidden.',
    ]) {
      expect(bob && isSensitiveExternalActionExplicitlyAuthorized(bob, request)).toBeFalse();
    }

    const aliceAndBob = classifySensitiveExternalAction('mcp__mailer__send_email', {
      to: 'Alice', cc: 'Bob', subject: 'Status',
    });
    for (const request of [
      'Send to Alice but exclude Bob.',
      'Send to Alice, except for Bob.',
      'Send to Alice but do not include Bob.',
      'Envoie à Alice mais exclue Bob.',
      'Envoie à Alice hors Bob.',
      'Envoie à Alice à l’exception de Bob.',
      'Send to Alice rather than Bob.',
      'Send to Alice instead of Bob.',
      'Envoie à Alice plutôt que Bob.',
      'Send to Alice, excluding only Bob.',
    ]) {
      expect(aliceAndBob && isSensitiveExternalActionExplicitlyAuthorized(
        aliceAndBob, request,
      )).toBeFalse();
    }
    for (const amendment of [
      'Alice instead of Bob.',
      'Alice rather than Bob.',
      'Alice plutôt que Bob.',
      'Leave Bob out.',
    ]) {
      expect(aliceAndBob && isSensitiveExternalActionAuthorizedByObjective(
        aliceAndBob,
        ['Send to Alice and Bob.', amendment],
      )).toBeFalse();
    }

    const payment = classifySensitiveExternalAction('mcp__bank__transfer_funds', {
      beneficiary_id: 'vendor-9', amount: 100, currency: 'EUR',
    });
    expect(payment && isSensitiveExternalActionExplicitlyAuthorized(
      payment,
      'Transfer funds to vendor-9, amount 100 EUR. Do not transfer to vendor-9.',
    )).toBeFalse();
    for (const amendment of [
      'Pas à vendor-9.',
      'Not vendor-9.',
      'Never vendor-9.',
      'Without vendor-9.',
    ]) {
      expect(payment && isSensitiveExternalActionAuthorizedByObjective(payment, [
        'Transfer funds to vendor-9, amount 100 EUR.',
        amendment,
      ])).toBeFalse();
    }
  });

  it('fails closed when a sensitive shell command uses unsupported valid syntax', () => {
    const command = "curl -fsS -X POST https://api.example.com/send -d $'to=bob@example.com'";
    expect(classifySensitiveExternalAction('Bash', { command })).toMatchObject({
      category: 'external_mutation',
      targetCandidates: ['unresolved external target'],
    });
    expect(checkBash(
      'allow-all', command, 'Envoie à alice@example.com via api.example.com.',
      'allow-in-execute', true,
    )).toMatchObject({ type: 'block', reason: expect.stringContaining('exact target') });
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
