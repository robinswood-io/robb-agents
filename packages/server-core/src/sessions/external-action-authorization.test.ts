import { describe, expect, it } from 'bun:test';
import {
  hasMatchingExternalActionAuthorization,
  providerAlwaysAllowForExternalAction,
  pruneExternalActionAuthorizations,
  rememberExternalActionAuthorization,
} from './external-action-authorization.ts';
import { SessionManager, createManagedSession } from './SessionManager.ts';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe('external action authorization grants', () => {
  it('persists and matches only the same category, concrete target, tool, and operation', () => {
    const grants = rememberExternalActionAuthorization([], {
      category: 'external_send',
      targetCandidates: ['Louise@example.com'],
      toolName: 'gmail_send',
      operationHash: HASH_A,
    }, 100, 1_000);

    expect(hasMatchingExternalActionAuthorization(grants, {
      category: 'external_send',
      targetCandidates: ['louise@example.com'],
      toolName: 'gmail_send',
      operationHash: HASH_A,
    }, 500)).toBe(true);
    expect(hasMatchingExternalActionAuthorization(grants, {
      category: 'external_send',
      targetCandidates: ['other@example.com'],
      toolName: 'gmail_send',
      operationHash: HASH_A,
    }, 500)).toBe(false);
    expect(hasMatchingExternalActionAuthorization(grants, {
      category: 'payment',
      targetCandidates: ['louise@example.com'],
      toolName: 'gmail_send',
      operationHash: HASH_A,
    }, 500)).toBe(false);
    expect(hasMatchingExternalActionAuthorization(grants, {
      category: 'external_send',
      targetCandidates: ['louise@example.com'],
      toolName: 'gmail_reply',
      operationHash: HASH_A,
    }, 500)).toBe(false);
    expect(hasMatchingExternalActionAuthorization(grants, {
      category: 'external_send',
      targetCandidates: ['louise@example.com'],
      toolName: 'gmail_send',
      operationHash: HASH_B,
    }, 500)).toBe(false);
  });

  it('never creates a broad grant without a concrete target', () => {
    expect(rememberExternalActionAuthorization([], {
      category: 'deployment',
      targetCandidates: [],
      toolName: 'deploy',
      operationHash: HASH_A,
    }, 100)).toEqual([]);
  });

  it('binds generic external-mutation grants to the exact connector operation', () => {
    const grants = rememberExternalActionAuthorization([], {
      category: 'external_mutation',
      targetCandidates: ['task-7'],
      toolName: 'mcp__todo__delete_task',
      operationHash: HASH_A,
    }, 100, 1_000);

    expect(hasMatchingExternalActionAuthorization(grants, {
      category: 'external_mutation',
      targetCandidates: ['task-7'],
      toolName: 'mcp__todo__delete_task',
      operationHash: HASH_A,
    }, 500)).toBe(true);
    expect(hasMatchingExternalActionAuthorization(grants, {
      category: 'external_mutation',
      targetCandidates: ['task-7'],
      toolName: 'mcp__todo__update_task',
      operationHash: HASH_A,
    }, 500)).toBe(false);
  });

  it('requires the complete canonical target set instead of any overlapping target', () => {
    const grants = rememberExternalActionAuthorization([], {
      category: 'git_push',
      targetCandidates: ['deploy@prod.example', 'origin main'],
      toolName: 'Bash',
      operationHash: HASH_A,
    }, 100, 1_000);

    expect(hasMatchingExternalActionAuthorization(grants, {
      category: 'git_push',
      targetCandidates: ['ORIGIN MAIN', 'déploy@prod.example'],
      toolName: 'Bash',
      operationHash: HASH_A,
    }, 500)).toBe(true);
    expect(hasMatchingExternalActionAuthorization(grants, {
      category: 'git_push',
      targetCandidates: ['deploy@prod.example', 'origin release'],
      toolName: 'Bash',
      operationHash: HASH_A,
    }, 500)).toBe(false);
    expect(hasMatchingExternalActionAuthorization(grants, {
      category: 'git_push',
      targetCandidates: ['deploy@staging.example', 'origin main'],
      toolName: 'Bash',
      operationHash: HASH_A,
    }, 500)).toBe(false);
    expect(hasMatchingExternalActionAuthorization(grants, {
      category: 'git_push',
      targetCandidates: ['origin main'],
      toolName: 'Bash',
      operationHash: HASH_A,
    }, 500)).toBe(false);
  });

  it('keeps distinct overlapping scopes instead of replacing either grant', () => {
    const first = rememberExternalActionAuthorization([], {
      category: 'git_push',
      targetCandidates: ['deploy@prod.example', 'origin main'],
      toolName: 'Bash',
      operationHash: HASH_A,
    }, 100, 1_000);
    const second = rememberExternalActionAuthorization(first, {
      category: 'git_push',
      targetCandidates: ['deploy@prod.example', 'origin release'],
      toolName: 'Bash',
      operationHash: HASH_A,
    }, 200, 1_000);

    expect(second).toHaveLength(2);
  });

  it('expires grants and replaces an older grant for the same scope', () => {
    const first = rememberExternalActionAuthorization([], {
      category: 'git_push',
      targetCandidates: ['origin/main'],
      toolName: 'Bash',
      operationHash: HASH_A,
    }, 100, 100);
    expect(pruneExternalActionAuthorizations(first, 201)).toEqual([]);

    const renewed = rememberExternalActionAuthorization(first, {
      category: 'git_push',
      targetCandidates: ['origin/main'],
      toolName: 'Bash',
      operationHash: HASH_A,
    }, 150, 500);
    expect(renewed).toHaveLength(1);
    expect(renewed[0]?.grantedAt).toBe(150);
  });

  it('drops legacy or malformed grants that are not bound to an exact operation', () => {
    expect(pruneExternalActionAuthorizations([{
      category: 'external_send',
      targetCandidates: ['louise@example.com'],
      toolName: 'gmail_send',
      grantedAt: 100,
      expiresAt: 1_000,
    } as never], 500)).toEqual([]);
    expect(rememberExternalActionAuthorization([], {
      category: 'external_send',
      targetCandidates: ['louise@example.com'],
      toolName: 'gmail_send',
      operationHash: 'not-a-sha256',
    }, 100)).toEqual([]);
  });

  it('never forwards a broad provider whitelist for an exact sensitive grant', () => {
    expect(providerAlwaysAllowForExternalAction(true, 'git_push')).toBe(false);
    expect(providerAlwaysAllowForExternalAction(true, 'external_send')).toBe(false);
    expect(providerAlwaysAllowForExternalAction(true)).toBe(true);
    expect(providerAlwaysAllowForExternalAction(false, 'git_push')).toBe(false);
  });
});

describe('SessionManager sensitive permission persistence', () => {
  it('persists an exact replay grant only when the human selects Always Allow', () => {
    const manager = new SessionManager();
    const managed = createManagedSession({ id: 'sensitive-permission-session' }, {
      id: 'sensitive-permission-workspace',
      name: 'Sensitive permission workspace',
      rootPath: '/tmp/sensitive-permission-workspace',
      createdAt: 1,
    } as never, { messagesLoaded: true });
    const providerResponses: Array<{ requestId: string; allowed: boolean; alwaysAllow: boolean }> = [];
    managed.agent = {
      respondToPermission: (requestId: string, allowed: boolean, alwaysAllow = false) => {
        providerResponses.push({ requestId, allowed, alwaysAllow });
      },
    } as never;
    managed.isProcessing = true;
    managed.processingGeneration = 1;
    managed.activeObjective = {
      objectiveId: 'user-a',
      userMessageId: 'user-a',
      terminalState: 'active',
    } as never;

    const internals = manager as unknown as {
      sessions: Map<string, typeof managed>;
      pendingPermissionRequests: Map<string, unknown>;
      persistSession: (session: typeof managed) => void;
      flushSession: (sessionId: string) => Promise<void>;
      emitExecutionTelemetry: () => void;
    };
    internals.sessions.set(managed.id, managed);
    const persistedAuthorizations: Array<typeof managed.externalActionAuthorizations> = [];
    internals.persistSession = session => {
      persistedAuthorizations.push(structuredClone(session.externalActionAuthorizations));
    };
    internals.flushSession = async () => {};
    internals.emitExecutionTelemetry = () => {};

    const addRequest = (requestId: string) => {
      const timeout = setTimeout(() => undefined, 60_000);
      timeout.unref?.();
      internals.pendingPermissionRequests.set(requestId, {
        sessionId: managed.id,
        type: 'mcp_mutation',
        toolName: 'mcp__gmail__send_email',
        processingGeneration: 1,
        objectiveId: 'user-a',
        runtimeAgent: managed.agent,
        requestedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        request: {
          requestId,
          sessionId: managed.id,
          toolName: 'mcp__gmail__send_email',
          description: 'Send the approved message',
          type: 'mcp_mutation',
        },
        timeout,
        sensitiveActionCategory: 'external_send',
        sensitiveActionTargets: ['recipient@example.com'],
        sensitiveActionOperationHash: HASH_A,
      });
    };

    addRequest('one-shot-request');
    expect(manager.respondToPermission(
      managed.id,
      'one-shot-request',
      true,
      false,
    )).toBe(true);
    expect(managed.externalActionAuthorizations).toBeUndefined();
    expect(persistedAuthorizations).toEqual([]);

    addRequest('remembered-request');
    expect(manager.respondToPermission(
      managed.id,
      'remembered-request',
      true,
      true,
    )).toBe(true);
    expect(managed.externalActionAuthorizations).toHaveLength(1);
    expect(managed.externalActionAuthorizations?.[0]).toMatchObject({
      category: 'external_send',
      targetCandidates: ['recipient@example.com'],
      toolName: 'mcp__gmail__send_email',
      operationHash: HASH_A,
    });
    expect(persistedAuthorizations.at(-1)?.[0]).toMatchObject({
      category: 'external_send',
      targetCandidates: ['recipient@example.com'],
      toolName: 'mcp__gmail__send_email',
      operationHash: HASH_A,
    });
    expect(providerResponses).toEqual([
      { requestId: 'one-shot-request', allowed: true, alwaysAllow: false },
      // Sensitive replay grants stay host-scoped and never become a broad
      // provider-side whitelist.
      { requestId: 'remembered-request', allowed: true, alwaysAllow: false },
    ]);
  });
});
