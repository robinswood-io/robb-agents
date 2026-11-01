import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { cleanupModeState, initializeModeState, type PermissionMode } from "../../mode-manager.ts";
import { clearContextualGmailPreflightAttestation, runPreToolUseChecks } from "../pre-tool-use.ts";
import { classifySensitiveExternalAction, isSensitiveExternalActionExplicitlyAuthorized } from "../sensitive-external-action.ts";
import { whitelistedPermissionManager } from "./testing/sensitive-external-action-fixture.ts";

const usedSessionIds: string[] = [];
const temporaryPaths: string[] = [];
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
    ...(options?.externalActionPolicy !== undefined ? { externalActionPolicy: options?.externalActionPolicy } : {}),
    ...(options?.objectiveMutationAuthorized !== undefined ? { objectiveMutationAuthorized: options?.objectiveMutationAuthorized } : {}),
    ...(options?.objectiveSensitiveActionAuthorized !== undefined ? { objectiveSensitiveActionAuthorized: options?.objectiveSensitiveActionAuthorized } : {}),
    ...(options?.objectiveAuthorizationSegments !== undefined ? { objectiveAuthorizationSegments: options?.objectiveAuthorizationSegments } : {}),
    ...(options?.authenticatedUserAuthorizationSegments !== undefined ? { authenticatedUserAuthorizationSegments: options?.authenticatedUserAuthorizationSegments } : {}),
    ...(options?.dataFolderPath !== undefined ? { dataFolderPath: options?.dataFolderPath } : {}),
    ...(options?.declaredToolCapabilities !== undefined ? { declaredToolCapabilities: options?.declaredToolCapabilities } : {}),
    permissionManager: whitelistedPermissionManager,
    ...(currentUserRequest !== undefined ? { currentUserRequest } : {}),
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
  it('keeps direct package publication and opaque executors behind a target boundary', () => {
    for (const command of [
      'npm publish', 'pnpm publish', 'bun publish', 'yarn npm publish',
      'npm --registry https://registry.npmjs.org publish',
      'npm --workspace pkg publish',
      'npm --prefix ./pkg publish',
      'npm --loglevel verbose publish',
      'pnpm --dir ./pkg publish',
      'yarn --cwd ./pkg npm publish',
      'bun --cwd ./pkg publish',
      'npm pub',
      'npm unpub',
    ]) {
      const action = classifySensitiveExternalAction('Bash', { command });
      expect(action).toMatchObject({
        category: 'external_publication',
        targetCandidates: ['unresolved external target'],
      });
      expect(action && isSensitiveExternalActionExplicitlyAuthorized(
        action, 'Publish unresolved external target.',
      )).toBeFalse();
    }
    for (const command of [
      'npm exec -- curl -X DELETE https://api.other.example/items/7',
      'pnpm dlx remote-tool mutate',
      'npx curl -X DELETE https://api.other.example/items/7',
      'bunx remote-tool mutate',
      'npm deprecate pkg@1 bad',
      'npm owner add bob pkg',
      'npm dist-tag add pkg@1 latest',
      'npm access set status=public pkg',
      'npm login',
      'npm logout',
      'npm token create',
      'npm token revoke token-7',
      'npm profile set fullname Alice',
      'npm team create org:team',
      'npm org set org developer alice',
      'npm hook add pkg https://hooks.example.test/npm',
      'npm star pkg',
      'npm unstar pkg',
    ]) {
      expect(classifySensitiveExternalAction('Bash', { command })).toMatchObject({
        category: 'external_mutation',
        targetCandidates: ['unresolved external target'],
      });
    }
  });

  it('retains plural MCP audiences and rejects dynamic structured targets', () => {
    const audiences = classifySensitiveExternalAction('mcp__mailer__send_email', {
      to: 'alice', chat_ids: ['bob'], bccs: ['carol'], recipient_ids: ['dave'],
    });
    expect(audiences).toMatchObject({
      category: 'external_send',
      targetCandidates: ['alice', 'bob', 'carol', 'dave'],
    });
    expect(audiences && isSensitiveExternalActionExplicitlyAuthorized(
      audiences, 'Send to alice.',
    )).toBeFalse();

    for (const input of [
      { to: 'alice@example.com', metadata: { recipient: 'evil@example.com' } },
      { to: 'alice@example.com', template_data: { to: 'evil@example.com' } },
      { to: 'alice@example.com', variables: { bcc: 'evil@example.com' } },
    ]) {
      const nestedAudience = classifySensitiveExternalAction('mcp__mailer__send_email', input);
      expect(nestedAudience?.targetCandidates).toContain('evil@example.com');
      expect(nestedAudience && isSensitiveExternalActionExplicitlyAuthorized(
        nestedAudience, 'Send to alice@example.com.',
      )).toBeFalse();
    }
    const nestedAttachment = classifySensitiveExternalAction('mcp__mailer__send_email', {
      to: 'alice@example.com', attachments: [{ url: 'https://evil.example/payload' }],
    });
    expect(nestedAttachment?.targetCandidates).toContain('additional unresolved targets');
    expect(nestedAttachment && isSensitiveExternalActionExplicitlyAuthorized(
      nestedAttachment, 'Send to alice@example.com.',
    )).toBeFalse();

    for (const input of [
      { to: 'alice', distribution_list: ['bob'] },
      { to: 'alice', recipient_selector: ['bob'] },
      { to: 'alice', recipients_glob: '*' },
      { to: 'alice', recipient_address: 'bob@example.com' },
      { to: 'alice', recipient_addresses: ['bob@example.com'] },
      { to: 'alice', phone_number: '+33123456789' },
      { to: 'alice', delivery_channel: 'other-channel' },
      { to: 'alice', routing_address: 'opaque-route' },
    ]) {
      const action = classifySensitiveExternalAction('mcp__mailer__send_email', input);
      expect(action && isSensitiveExternalActionExplicitlyAuthorized(action, 'Send to alice.')).toBeFalse();
    }

    const operationDrivenSend = classifySensitiveExternalAction('mcp__mailer__execute', {
      operation: 'send', to: 'alice', routing_address: 'bob@example.com',
    });
    expect(operationDrivenSend?.category).toBe('external_send');
    expect(operationDrivenSend?.targetCandidates).toEqual([
      'alice', 'additional unresolved targets',
    ]);
    expect(operationDrivenSend && isSensitiveExternalActionExplicitlyAuthorized(
      operationDrivenSend, 'Execute send to alice.',
    )).toBeFalse();

    const maskedSendInput = {
      action: 'get', operation: 'send', to: 'alice@example.com',
      routing_address: 'bob@example.com',
    };
    const maskedSend = classifySensitiveExternalAction('mcp__crm__get_record', maskedSendInput);
    expect(maskedSend?.category).toBe('external_send');
    expect(maskedSend?.targetCandidates).toEqual([
      'alice@example.com', 'additional unresolved targets',
    ]);
    expect(checkMcp(
      'allow-all', 'mcp__crm__get_record', maskedSendInput, 'Poursuis.', {
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: true,
        objectiveAuthorizationSegments: ['Inspecte le dossier.'],
      },
    ).type).not.toBe('allow');

    expect(classifySensitiveExternalAction('mcp__broker__get_record', {
      action: 'preview', operation: 'transfer_funds',
      beneficiary_id: 'vendor-9', amount: 100, currency: 'EUR',
    })?.category).toBe('payment');
    expect(classifySensitiveExternalAction('mcp__ops__get_status', {
      action: 'status', operation: 'restart', service: 'billing',
    })?.category).toBe('service_restart');
    expect(classifySensitiveExternalAction('mcp__ops__execute', {
      action: 'send', operation: 'restart', to: 'alice', service: 'billing',
    })?.targetCandidates).toContain('unresolved external target');

    for (const [toolName, input, request] of [
      ['mcp__bank__transfer_funds', { beneficiary_id: '*', amount: 10, currency: 'EUR' }, 'Transfer funds to *, amount 10 EUR.'],
      ['mcp__mailer__send_email', { to: '*' }, 'Send to *.'],
      ['mcp__rbw-servers__ssh_upload', { server: 'dev', remotePath: '/srv/workspace/*/x' }, 'Upload to unresolved remote scope.'],
    ] as const) {
      const action = classifySensitiveExternalAction(toolName, input);
      expect(action?.targetCandidates.some(target => target.startsWith('unresolved '))).toBeTrue();
      expect(action && isSensitiveExternalActionExplicitlyAuthorized(action, request)).toBeFalse();
    }
  });

  it('does not inherit project authority for adjacent or opaque remote systems', () => {
    for (const command of [
      'docker stop other',
      'docker rm other',
    ]) {
      const action = classifySensitiveExternalAction('mcp__rbw-servers__ssh_execute', {
        server: 'dev', cwd: '/srv/workspace/zero', command,
      });
      expect<unknown>(action?.targetCandidates).toEqual(expect.arrayContaining(['zero', 'other']));
      expect(action && isSensitiveExternalActionExplicitlyAuthorized(action, 'Corrige Zero.')).toBeFalse();
    }

    for (const command of [
      'docker exec other touch marker',
      'podman exec other rm -f marker',
      'kubectl delete pod other',
      'kubectl scale deployment other --replicas=0',
      'aws s3 rm s3://other-bucket/x',
      'redis-cli -h other FLUSHALL',
      "psql -h other -c 'DELETE FROM x'",
      'npm publish',
      'npm exec -- curl -X DELETE https://api.other.example/items/7',
      'bun run deploy-other',
    ]) {
      const action = classifySensitiveExternalAction('mcp__rbw-servers__ssh_execute', {
        server: 'dev', cwd: '/srv/workspace/zero', command,
      });
      expect(action?.targetCandidates).toContain('unresolved remote scope');
      expect(action && isSensitiveExternalActionExplicitlyAuthorized(action, 'Corrige Zero.')).toBeFalse();
    }
  });

  it('retains every restart, deploy and nested SSH target', () => {
    expect(classifySensitiveExternalAction('mcp__rbw-servers__ssh_execute', {
      server: 'dev', cwd: '/srv/workspace/zero',
      command: 'systemctl restart api worker billing',
    })).toMatchObject({
      category: 'service_restart',
      targetCandidates: ['dev', 'zero', 'api', 'worker', 'billing'],
    });
    expect(classifySensitiveExternalAction('mcp__rbw-servers__ssh_execute', {
      server: 'dev', cwd: '/srv/workspace/zero',
      command: 'docker compose up -d api worker billing',
    })).toMatchObject({
      category: 'deployment',
      targetCandidates: [
        'dev', 'zero', 'api', 'worker', 'billing', 'unresolved remote scope',
      ],
    });
    expect(classifySensitiveExternalAction('Bash', {
      command: "ssh dev 'cd /srv/workspace/other && git push origin main'",
    })).toMatchObject({
      category: 'git_push',
      targetCandidates: ['dev', 'unresolved remote scope', 'origin main'],
    });
  });

  it('fails closed on target overflow, deep unknown targets and dynamic HTTP destinations', () => {
    const recipients = Array.from({ length: 65 }, (_, index) => `user${index}@example.com`);
    expect(classifySensitiveExternalAction('mcp__gmail__send_email', { recipients }))
      .toMatchObject({ targetCandidates: (expect.arrayContaining(['additional unresolved targets']) as unknown) });
    expect(classifySensitiveExternalAction('mcp__gmail__send_email', {
      recipients: [{ email: 'alice@example.com' }],
    })).toMatchObject({ targetCandidates: ['alice@example.com'] });
    expect(classifySensitiveExternalAction('mcp__gmail__send_email', {
      envelope: { nested: { nested: { nested: { nested: { nested: { nested: { nested: { nested: {
        bcc: 'deep@example.com',
      } } } } } } } } },
    })).toMatchObject({ targetCandidates: (expect.arrayContaining(['additional unresolved targets']) as unknown) });
    expect(classifySensitiveExternalAction('Bash', {
      command: "curl -X POST \"$TARGET_URL\" -d '{\"email\":\"alice@example.com\"}'",
    })).toMatchObject({ targetCandidates: (expect.arrayContaining(['unresolved external target']) as unknown) });

    const unresolvedOnly = classifySensitiveExternalAction('mcp__mailer__send_email', {
      to: [{}],
    });
    expect(unresolvedOnly).toMatchObject({ targetCandidates: ['additional unresolved targets'] });
    expect(unresolvedOnly && isSensitiveExternalActionExplicitlyAuthorized(
      unresolvedOnly, 'Send to additional unresolved targets.',
    )).toBeFalse();

    const dynamicSecret = classifySensitiveExternalAction('Bash', {
      command: 'curl -X POST "$TARGET_URL" -H "Authorization: Bearer $TOKEN"',
    });
    expect(dynamicSecret && isSensitiveExternalActionExplicitlyAuthorized(
      dynamicSecret, 'Transfer the secret to unresolved external target.',
    )).toBeFalse();
  });

  it('never classifies explicit MCP preflight or read-only operations as mutations', () => {
    const readOnlyCalls: Array<[string, Record<string, unknown>]> = [
      ['mcp__google-contacts__gmail_send_preflight', { to: 'alice@example.com' }],
      ['mcp__gmail__get_send_status', { message_id: 'msg-7' }],
      ['mcp__broker__preview_buy_order', { account_id: 'acct-7', symbol: 'ACME' }],
      ['mcp__cloud__check_deployment', { environment: 'prod' }],
      ['mcp__updater__get_if_update_available', { app: 'desktop' }],
    ];

    for (const [toolName, input] of readOnlyCalls) {
      expect(classifySensitiveExternalAction(toolName, input)).toBeNull();
    }
  });

  it('lets mutating MCP input semantics override a read-like tool name', () => {
    for (const input of [
      { operation: 'delete', id: 'record-7' },
      { action: 'update', id: 'record-7' },
      { method: 'DELETE', id: 'record-7' },
    ]) {
      expect(classifySensitiveExternalAction('mcp__crm__get_record', input))
        .toMatchObject({ category: 'external_mutation', targetCandidates: ['record-7'] });
    }
    expect(classifySensitiveExternalAction('mcp__crm__get_record', { id: 'record-7' })).toBeNull();
  });

  it('keeps compound mutations fail-closed despite a leading validation verb', () => {
    expect(classifySensitiveExternalAction(
      'mcp__gmail__verify_and_send_email',
      { to: 'alice@example.com' },
    )?.category).toBe('external_send');

    // Tool arguments are model-controlled and cannot, on their own, downgrade
    // a mutating tool contract to read-only.
    expect(classifySensitiveExternalAction(
      'mcp__gmail__send_email',
      { to: 'alice@example.com', dry_run: true },
    )?.category).toBe('external_send');

    expect(classifySensitiveExternalAction(
      'mcp__gmail__preflight_and_send_email',
      { to: 'alice@example.com' },
    )?.category).toBe('external_send');

    expect(classifySensitiveExternalAction(
      'mcp__contacts__get_or_create_contact',
      { email: 'alice@example.com' },
    )?.category).toBe('external_mutation');
    expect(classifySensitiveExternalAction(
      'mcp__todo__find_or_delete_task',
      { task_id: 'task-7' },
    )?.category).toBe('external_mutation');
    expect(classifySensitiveExternalAction(
      'mcp__crm__lookup_or_update_record',
      { id: 'record-7' },
    )?.category).toBe('external_mutation');
    expect(classifySensitiveExternalAction(
      'mcp__contacts__get_if_missing_create_contact',
      { id: 'contact-7' },
    )?.category).toBe('external_mutation');
    expect(classifySensitiveExternalAction(
      'mcp__todo__find_else_delete_task',
      { id: 'task-7' },
    )?.category).toBe('external_mutation');
    expect(classifySensitiveExternalAction(
      'mcp__crm__lookup_otherwise_update_record',
      { id: 'record-7' },
    )?.category).toBe('external_mutation');
    expect(classifySensitiveExternalAction('api_contacts', {
      method: 'POST',
      path: '/contacts/get-or-create',
      email: 'alice@example.com',
    })?.category).toBe('external_mutation');
  });

  it('honors explicit read-only API semantics even when POST is used as a transport', () => {
    expect(classifySensitiveExternalAction('api_gmail', {
      method: 'POST',
      path: '/emails/send/preflight',
      to: 'alice@example.com',
    })).toBeNull();

    expect(classifySensitiveExternalAction('api_broker', {
      method: 'POST',
      path: '/orders/preview-buy-order',
      account_id: 'acct-7',
    })).toBeNull();
  });

  it('never lets a read-like API path hide an intrinsically mutating method', () => {
    for (const input of [
      { method: 'DELETE', path: '/users/search', id: 'target-7' },
      { method: 'PATCH', path: '/jobs/get-status', id: 'target-7' },
      { method: 'PUT', path: '/records/read', id: 'target-7' },
    ]) {
      expect(classifySensitiveExternalAction('api_service', input))
        .toMatchObject({ category: 'external_mutation', targetCandidates: ['target-7'] });
    }
  });

  it('never lets a read-shaped API transport hide an explicitly mutating operation', () => {
    expect(classifySensitiveExternalAction('api_service', {
      method: 'GET',
      path: '/status',
      operation: 'restart',
      service: 'billing',
    })).toMatchObject({
      category: 'service_restart',
      targetCandidates: ['billing'],
    });
  });

  it('preserves every sensitive API operation category behind a read-shaped transport', () => {
    const cases = [
      ['charge', 'payment'],
      ['transfer_funds', 'payment'],
      ['deploys', 'deployment'],
      ['restarts', 'service_restart'],
      ['deliver', 'external_send'],
      ['publish', 'external_publication'],
    ] as const;

    for (const [operation, category] of cases) {
      expect(classifySensitiveExternalAction('api_service', {
        method: 'GET', path: '/status', operation, service: 'billing',
      })).toMatchObject({ category, targetCandidates: ['billing'] });
    }
  });

  it('unions structured and path targets and lets explicit API operations override read-like paths', () => {
    expect(classifySensitiveExternalAction('api_jobs', {
      method: 'DELETE', path: '/jobs/7', account_id: 'acct-1',
    })).toMatchObject({
      category: 'external_mutation', targetCandidates: ['acct-1', '7'],
    });
    expect(classifySensitiveExternalAction('api_service', {
      method: 'POST', path: '/service/status', operation: 'restart', service: 'zero',
    })).toMatchObject({ category: 'service_restart' });
    expect(classifySensitiveExternalAction('api_broker', {
      method: 'POST', path: '/orders/preview', operation: 'execute_trade', account_id: 'acct-1', amount: 10,
    })).toMatchObject({ category: 'payment', targetCandidates: (expect.arrayContaining(['acct-1', '10']) as unknown) });
    expect(classifySensitiveExternalAction('api_vault', {
      method: 'POST', path: '/service/status', operation: 'set_secret', project: 'zero',
    })).toMatchObject({ category: 'secret_transfer' });
  });
});
