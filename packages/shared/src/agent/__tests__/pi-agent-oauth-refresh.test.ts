import { afterEach, describe, expect, it } from 'bun:test';

import { PiAgent, shouldRefreshPiOAuthBeforeSpawn } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

function createAgent(slug: string, expectedBindingId?: string): PiAgent {
  const config: BackendConfig = {
    provider: 'pi',
    authType: 'oauth',
    connectionSlug: slug,
    expectedLlmCredentialBindingId: expectedBindingId,
    workspace: {
      id: 'ws-oauth-refresh-test',
      name: 'OAuth Refresh Test',
      rootPath: '/tmp/craft-agent-oauth-refresh-test',
    } as any,
    session: {
      id: 'session-oauth-refresh-test',
      workspaceRootPath: '/tmp/craft-agent-oauth-refresh-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
  };
  return new PiAgent(config);
}

const mutex = (PiAgent as any).globalRefreshMutex as Map<string, Promise<unknown>>;

afterEach(() => {
  mutex.clear();
});

describe('PiAgent OAuth refresh mutex', () => {
  it('preemptively refreshes expired ChatGPT tokens and joins an in-flight refresh', () => {
    const nowMs = 1_000_000;

    expect(shouldRefreshPiOAuthBeforeSpawn({
      authType: 'oauth',
      piAuthProvider: 'openai-codex',
      refreshToken: 'refresh-token',
      expiresAt: nowMs - 1,
      refreshInFlight: false,
      nowMs,
    })).toBe(true);

    expect(shouldRefreshPiOAuthBeforeSpawn({
      authType: 'oauth',
      piAuthProvider: 'openai-codex',
      expiresAt: nowMs + 60 * 60_000,
      refreshInFlight: true,
      nowMs,
    })).toBe(true);

    expect(shouldRefreshPiOAuthBeforeSpawn({
      authType: 'oauth',
      piAuthProvider: 'openai-codex',
      refreshToken: 'refresh-token',
      expiresAt: nowMs + 60 * 60_000,
      refreshInFlight: false,
      nowMs,
    })).toBe(false);
  });

  it('starts refresh for typed auth errors emitted as provider events', async () => {
    const agent = createAgent('typed-auth-refresh-test');
    let refreshAttempts = 0;
    (agent as any).refreshAndPushTokens = async () => {
      refreshAttempts += 1;
    };

    (agent as any).handleSubprocessEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: 'Provided authentication token is expired. Please try signing in again.',
      },
    });
    (agent as any).handleSubprocessEvent({ type: 'agent_end', willRetry: false });
    await Promise.resolve();

    expect(refreshAttempts).toBe(1);
    agent.destroy();
  });

  it('does not push a stored stale credential when the concurrent owner failed', async () => {
    const slug = 'oauth-refresh-failure-test';
    const bindingId = 'oauth-binding-failure';
    const agent = createAgent(slug, bindingId);
    const sent: Array<Record<string, unknown>> = [];
    let credentialReads = 0;
    let joinedConcurrentOwner = false;

    (agent as any).subprocess = {};
    (agent as any).send = (message: Record<string, unknown>) => sent.push(message);
    (agent as any).getPiAuth = async () => {
      credentialReads += 1;
      return {
        provider: 'openai-codex',
        credential: { type: 'api_key', key: 'stale-token' },
      };
    };
    mutex.set(`${slug}\u0000${bindingId}`, Promise.resolve().then(() => {
      joinedConcurrentOwner = true;
      return { refreshed: false, bindingId };
    }));

    await (agent as any).refreshAndPushTokens();

    expect(joinedConcurrentOwner).toBe(true);
    expect(credentialReads).toBe(0);
    expect(sent).toEqual([]);
    (agent as any).subprocess = null;
    agent.destroy();
  });

  it('pushes the exact fresh credential returned by a successful concurrent owner', async () => {
    const slug = 'oauth-refresh-success-test';
    const bindingId = 'oauth-binding-success';
    const agent = createAgent(slug, bindingId);
    const sent: Array<Record<string, unknown>> = [];
    const freshAuth = {
      provider: 'openai-codex',
      credential: { type: 'api_key', key: 'fresh-token' },
    };

    (agent as any).subprocess = {};
    (agent as any).send = (message: Record<string, unknown>) => sent.push(message);
    (agent as any).getPiAuth = async () => {
      throw new Error('waiters must use the successful owner outcome');
    };
    mutex.set(`${slug}\u0000${bindingId}`, Promise.resolve({
      refreshed: true,
      piAuth: freshAuth,
      bindingId,
    }));

    await (agent as any).refreshAndPushTokens();

    expect(sent).toEqual([{ type: 'token_update', piAuth: freshAuth }]);
    (agent as any).subprocess = null;
    agent.destroy();
  });

  it('does not push a concurrent outcome from another credential generation', async () => {
    const slug = 'oauth-refresh-generation-mismatch-test';
    const bindingId = 'oauth-binding-current';
    const agent = createAgent(slug, bindingId);
    const sent: Array<Record<string, unknown>> = [];
    let joinedConcurrentOwner = false;

    (agent as any).subprocess = {};
    (agent as any).send = (message: Record<string, unknown>) => sent.push(message);
    mutex.set(`${slug}\u0000${bindingId}`, Promise.resolve().then(() => {
      joinedConcurrentOwner = true;
      return {
        refreshed: true,
        piAuth: {
          provider: 'openai-codex',
          credential: { type: 'api_key', key: 'different-principal-token' },
        },
        bindingId: 'oauth-binding-replaced',
      };
    }));

    await (agent as any).refreshAndPushTokens();

    expect(joinedConcurrentOwner).toBe(true);
    expect(sent).toEqual([]);
    (agent as any).subprocess = null;
    agent.destroy();
  });
});
