import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HandlerFn, RequestContext, RpcServer } from '@craft-agent/server-core/transport';
import { RPC_CHANNELS, type PushTarget } from '@craft-agent/shared/protocol';
import { cleanupSessionFileWatchForClient, registerSessionFileWatchHandlers } from '../sessions-file-watches.ts';

type Notification = { channel: string; target: PushTarget; args: unknown[] };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Native Node file notification was not delivered');
    await pause(10);
  }
}
function context(clientId: string): RequestContext {
  return { clientId, workspaceId: 'qa', webContentsId: null, actorId: 'qa-owner', roles: ['owner'], authorizationGeneration: 0, allowedWorkspaceIds: ['qa'] };
}

describe('native Node session file watchers', () => {
  let root = '';
  let directories = new Map<string, string>();
  let handlers = new Map<string, HandlerFn<unknown[]>>();
  let notifications: Notification[] = [];
  let accessChecks: string[] = [];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'robb-node-session-watch-'));
    directories = new Map(['a', 'b'].map(id => [id, join(root, id)]));
    for (const directory of directories.values()) mkdirSync(directory);
    handlers = new Map(); notifications = []; accessChecks = [];
    const server: RpcServer = {
      handle(channel, handler) { handlers.set(channel, (ctx, ...args): unknown => Reflect.apply(handler, undefined, [ctx, ...args])); },
      push(channel, target, ...args) { notifications.push({ channel, target, args }); },
      async invokeClient() {},
      hasClientCapability() { return false; },
      findClientsWithCapability() { return []; },
    };
    registerSessionFileWatchHandlers(server, {
      assertSessionAccess(ctx, sessionId) { accessChecks.push(`${ctx.clientId}:${sessionId}`); },
      getSessionPath: sessionId => directories.get(sessionId),
      onError: error => { throw error; },
    });
  });
  afterEach(() => {
    cleanupSessionFileWatchForClient('client-a'); cleanupSessionFileWatchForClient('client-b');
    rmSync(root, { recursive: true, force: true });
  });
  async function invoke(channel: string, clientId: string, ...args: unknown[]) {
    const handler = handlers.get(channel);
    assert(handler, `Missing native watcher channel ${channel}`);
    await handler(context(clientId), ...args);
  }
  function changed(clientId: string, sessionId: string): boolean {
    return notifications.some(item => item.channel === RPC_CHANNELS.sessions.FILES_CHANGED
      && item.target.to === 'client' && item.target.clientId === clientId && item.args[0] === sessionId);
  }
  function write(sessionId: string, name: string, content = 'QA change'): void {
    const directory = directories.get(sessionId); assert(directory);
    writeFileSync(join(directory, name), content);
  }
  // macOS may flush directory-creation events after subscription. Establish a
  // quiet baseline before assertions about changes made by the test itself.
  async function settleStartupEvents(): Promise<void> {
    const deadline = Date.now() + 3_000;
    let count = notifications.length;
    let quietUntil = Date.now() + 250;
    while (Date.now() < quietUntil) {
      if (Date.now() >= deadline) throw new Error('Native watcher startup never became idle');
      await pause(10);
      if (count !== notifications.length) { count = notifications.length; quietUntil = Date.now() + 250; }
    }
    notifications = [];
  }
  async function watchBoth(): Promise<void> {
    await invoke(RPC_CHANNELS.sessions.WATCH_FILES, 'client-a', 'a');
    await invoke(RPC_CHANNELS.sessions.WATCH_FILES, 'client-b', 'b');
    await settleStartupEvents();
  }

  it('keeps the first B notification after A disconnects', async () => {
    await watchBoth(); write('a', 'a.txt'); await until(() => changed('client-a', 'a'));
    assert(!changed('client-b', 'b'));
    notifications = []; await invoke(RPC_CHANNELS.sessions.UNWATCH_FILES, 'client-a');
    write('b', 'b.txt'); await until(() => changed('client-b', 'b'));
    assert(!changed('client-a', 'a')); assert.deepEqual(accessChecks, ['client-a:a', 'client-b:b']);
  });
  it('isolates both clients and preserves subsequent B file updates after A unsubscribes', async () => {
    await watchBoth(); write('a', 'a.txt'); write('b', 'b.txt');
    await until(() => changed('client-a', 'a') && changed('client-b', 'b'));
    notifications = []; await invoke(RPC_CHANNELS.sessions.UNWATCH_FILES, 'client-a');
    write('a', 'a.txt', 'closed client'); write('b', 'b.txt', 'still subscribed');
    await until(() => changed('client-b', 'b')); assert(!changed('client-a', 'a'));
  });
  it('replaces an old directory watcher when a client switches sessions', async () => {
    await invoke(RPC_CHANNELS.sessions.WATCH_FILES, 'client-a', 'a');
    await invoke(RPC_CHANNELS.sessions.WATCH_FILES, 'client-a', 'b'); await settleStartupEvents();
    write('a', 'old.txt'); await pause(300); assert.equal(notifications.length, 0);
    write('b', 'current.txt'); await until(() => changed('client-a', 'b'));
    assert(!changed('client-a', 'a'));
  });
  it('ignores internal and hidden files while observing actual deliverables', async () => {
    await invoke(RPC_CHANNELS.sessions.WATCH_FILES, 'client-a', 'a'); await settleStartupEvents();
    write('a', 'session.jsonl'); write('a', '.hidden'); await pause(300);
    assert.equal(notifications.length, 0);
    write('a', 'report.md'); await until(() => changed('client-a', 'a'));
  });
  it('cleans up on disconnect and suppresses later notifications', async () => {
    await invoke(RPC_CHANNELS.sessions.WATCH_FILES, 'client-a', 'a'); await settleStartupEvents();
    cleanupSessionFileWatchForClient('client-a'); write('a', 'closed.txt'); await pause(300);
    assert.equal(notifications.length, 0);
  });
});
