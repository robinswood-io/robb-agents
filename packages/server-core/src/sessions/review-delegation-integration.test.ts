import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import type { SpawnSessionRequest, SpawnSessionResult } from '@craft-agent/shared/agent';
import { SessionManager, createManagedSession } from './SessionManager.ts';
import fixtures from './__fixtures__/review-recursion-20260909.json';
import { transitionObjectiveContract } from './objective-contract.ts';

type Managed = ReturnType<typeof createManagedSession>;
function harness(review = false) {
  const manager = new SessionManager();
  const workspace = { id: 'review-integration-workspace', name: 'Isolated fixture', slug: 'review-integration-workspace', rootPath: '/tmp/review-delegation-integration', createdAt: 1 };
  const parent = createManagedSession({ id: 'parent', llmConnection: 'connection-a', model: 'pi/gpt-5.6-sol',
    permissionMode: 'safe', enabledSourceSlugs: ['rbw-servers'],
    ...(review ? { parentSessionId: 'root' } : {}),
  }, workspace, { messagesLoaded: true });
  parent.isProcessing = true;
  parent.activeObjective = transitionObjectiveContract({ messageId: review ? 'objective-0' : 'parent-objective',
    text: review ? fixtures[0]!.prompt : 'Inspect the requested target.', nowMs: 1 });
  const host = manager as unknown as {
    sessions: Map<string, Managed>;
    spawnDelegatedSession: (parent: Managed, request: SpawnSessionRequest) => Promise<SpawnSessionResult>;
    createSession: (workspaceId: string, options: Partial<Managed>) => Promise<Managed>;
    sendMessage: (id: string, prompt: string, ...args: unknown[]) => Promise<void>;
  };
  host.sessions.set(parent.id, parent);
  if (review) {
    const root = createManagedSession({ id: 'root' }, workspace, { messagesLoaded: true });
    root.isProcessing = true;
    root.activeObjective = transitionObjectiveContract({ messageId: 'root-objective', text: 'Audit requested work.', nowMs: 1 });
    host.sessions.set(root.id, root);
  }
  const created: Managed[] = []; const sent: string[] = [];
  host.createSession = async (_workspaceId, options) => {
    const child = createManagedSession({ ...options, id: `child-${created.length + 1}` }, workspace, { messagesLoaded: true });
    host.sessions.set(child.id, child); created.push(child); return child;
  };
  host.sendMessage = async (id, _prompt, ...args) => {
    sent.push(id); const child = host.sessions.get(id)!; child.isProcessing = true; child.processingGeneration = 1;
    ;(args[5] as ((messageId: string) => void) | undefined)?.(`${id}-durable-dispatch`);
  };
  return { host, parent, created, sent, spawn: (request: SpawnSessionRequest) => host.spawnDelegatedSession(parent, request) };
}

describe('SessionManager review delegation integration without a live backend', () => {
  it('creates one child and sends once for concurrent duplicate calls', async () => {
    const fixture = harness();
    const request = { prompt: 'Inspect the exact target.' };
    const [first, second] = await Promise.all([fixture.spawn(request), fixture.spawn({ ...request, name: 'Cosmetic name' })]);
    expect(fixture.created).toHaveLength(1); expect(fixture.sent).toHaveLength(1);
    expect(first.sessionId).toBe(second.sessionId); expect(first.reused).toBeUndefined(); expect(second.reused).toBe(true);
  });
  it('creates a new child after completion rather than reusing its final verdict', async () => {
    const fixture = harness(); const request = { prompt: 'Inspect the exact target.' };
    const first = await fixture.spawn(request);
    fixture.created[0]!.isProcessing = false;
    fixture.created[0]!.lastWaitCompletion = { generation: 1, event: { sessionId: first.sessionId, reason: 'complete' } } as never;
    const second = await fixture.spawn(request);
    expect(second.sessionId).not.toBe(first.sessionId); expect(second.reused).toBeUndefined();
    expect(fixture.created).toHaveLength(2); expect(fixture.sent).toHaveLength(2);
  });
  it('keeps different source scopes, permissions and objectives separate', async () => {
    const fixture = harness(); const prompt = 'Inspect the exact target.';
    const results = [];
    for (const request of [{ prompt },
      { prompt, enabledSourceSlugs: ['another-source'] }, { prompt, permissionMode: 'allow-all' as const }]) {
      results.push(await fixture.spawn(request));
      // Distinct requests remain distinct after the prior child frees its slot.
      fixture.created.at(-1)!.isProcessing = false;
    }
    fixture.parent.activeObjective = transitionObjectiveContract({ messageId: 'new-objective', text: 'Inspect another requested scope.', nowMs: 2 });
    results.push(await fixture.spawn({ prompt }));
    expect(new Set(results.map(result => result.sessionId)).size).toBe(4);
    expect(fixture.created).toHaveLength(4);
  });
  it('rejects model-authored provider, model, and reasoning fields at the host boundary', async () => {
    const fixture = harness();
    const hostileRoute = {
      prompt: 'Inspect the exact target.',
      llmConnection: 'connection-b',
      model: 'other-provider/model',
      thinkingLevel: 'off',
    } as unknown as SpawnSessionRequest;
    await expect(fixture.spawn(hostileRoute)).rejects.toThrow('Invalid spawn_session arguments');
    expect(fixture.created).toHaveLength(0);
    expect(fixture.sent).toHaveLength(0);
  });
  it('inherits an authoritative manual parent route for a valid child request', async () => {
    const fixture = harness();
    fixture.parent.connectionRoutePinned = true;
    fixture.parent.modelRoutePinned = true;
    fixture.parent.thinkingLevel = 'xhigh';
    fixture.parent.thinkingLevelPinned = true;
    await fixture.spawn({ prompt: 'Inspect the exact target.' });
    expect(fixture.created).toHaveLength(1);
    expect(fixture.created[0]).toMatchObject({
      llmConnection: 'connection-a',
      model: 'pi/gpt-5.6-sol',
      thinkingLevel: 'xhigh',
      connectionRoutePinned: true,
      modelRoutePinned: true,
      thinkingLevelPinned: true,
    });
  });
  it('binds original attachment bytes even for an adapter that transmits only file metadata', async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'review-delegation-bytes-')));
    try {
      const path = join(directory, 'fixture.zip');
      writeFileSync(path, Buffer.from([0, 1, 2, 3]));
      const fixture = harness();
      const request = { prompt: 'Inspect the exact attachment.', workingDirectory: directory, attachments: [{ path }] };
      const first = await fixture.spawn(request);
      expect((await fixture.spawn(request)).sessionId).toBe(first.sessionId);
      writeFileSync(path, Buffer.from([0, 1, 2, 4]));
      expect((await fixture.spawn(request)).sessionId).not.toBe(first.sessionId);
      expect(fixture.created).toHaveLength(2);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('rejects a recursive reviewer before creating a session or dispatching any work', async () => {
    const fixture = harness(true);
    await expect(fixture.spawn({ prompt: fixtures[1]!.prompt })).rejects.toThrow('already delivers an independent read-only review');
    expect(fixture.created).toEqual([]); expect(fixture.sent).toEqual([]);
    expect((await fixture.spawn({ prompt: 'Inspect only the imports and return their names.' })).status).toBe('started');
    expect(fixture.created).toHaveLength(1);
  });
});
