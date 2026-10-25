import { expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentEvent } from '@craft-agent/core/types';
import { PiEventAdapter } from '../../shared/src/agent/backend/pi/event-adapter.ts';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

it('closes after the real SDK settles all deferred work, retains exact anchors, then serves a fresh request', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'robb-native-settlement-'));
  const root = resolve(import.meta.dir, '../../..');
  const profile = join(directory, 'profile');
  const workspace = join(directory, 'workspace');
  const sessionPath = join(workspace, 'sessions', 'settlement-fixture');
  mkdirSync(sessionPath, { recursive: true });
  const child = Bun.spawn([
    process.execPath, '--preload', join(import.meta.dir, '__tests__/fixtures/native-settlement.preload.ts'),
    join(import.meta.dir, 'index.ts'),
  ], { cwd: root, env: { ...process.env, CRAFT_CONFIG_DIR: profile, CRAFT_APP_ROOT: root,
    CRAFT_BUNDLED_ASSETS_ROOT: join(root, 'apps/electron'), CRAFT_DEBUG: 'false' },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', ipc: () => undefined });
  const frames: Record<string, unknown>[] = [];
  const events: AgentEvent[] = [];
  const adapter = new PiEventAdapter();
  adapter.startTurn();
  const observers = new Set<() => void>();
  let stderr = '';
  let readError: unknown;
  const errorReader = (async () => {
    for await (const bytes of child.stderr) stderr += new TextDecoder().decode(bytes);
  })();
  const outputReader = (async () => {
    const decoder = new TextDecoder();
    let pending = '';
    for await (const bytes of child.stdout) {
      pending += decoder.decode(bytes, { stream: true });
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!line.trim()) continue;
        const frame: unknown = JSON.parse(line);
        if (!record(frame)) throw new Error('Invalid worker frame');
        frames.push(frame);
        if (frame.type === 'event' && record(frame.event)) {
          // Trusted child-process wire boundary; event-specific behavior is
          // checked by the real adapter and by the assertions below.
          events.push(...adapter.adaptEvent(frame.event as Parameters<PiEventAdapter['adaptEvent']>[0]));
        }
        for (const observe of [...observers]) observe();
      }
    }
  })().catch(error => { readError = error; for (const observe of [...observers]) observe(); });
  async function send(message: Record<string, unknown>) {
    child.stdin.write(JSON.stringify(message) + '\n');
    await child.stdin.flush();
  }
  function waitFor(predicate: () => boolean): Promise<void> {
    return new Promise((resolveWait, reject) => {
      const timer = setTimeout(() => {
        observers.delete(check);
        reject(new Error('SDK worker timeout: ' + stderr.slice(-700)));
      }, 5_000);
      function check() {
        if (readError || predicate()) {
          clearTimeout(timer); observers.delete(check);
          if (readError) reject(readError); else resolveWait();
        }
      }
      observers.add(check); check();
    });
  }
  const completions = () => events.filter(event => event.type === 'complete').length;
  try {
    await send({ type: 'init', apiKey: 'offline-fixture', model: 'gpt-5.5',
      modelRoutePinned: true, providerType: 'pi', authType: 'api_key',
      piAuth: { provider: 'openai', credential: { type: 'api_key', key: 'offline-fixture' } },
      cwd: directory, workingDirectory: directory, workspaceRootPath: workspace,
      sessionId: 'settlement-fixture', sessionPath, plansFolderPath: join(sessionPath, 'plans'),
      agentDir: join(directory, 'agent'), thinkingLevel: 'off' });
    await waitFor(() => frames.some(frame => frame.type === 'ready'));
    await send({ type: 'prompt', id: 'first', message: 'Complete every step', systemPrompt: 'Offline QA' });
    await waitFor(() => frames.some(frame => frame.type === 'fixture_boundary' && frame.stage === 1));
    expect(completions()).toBe(0);
    child.send({ type: 'fixture_release', stage: 1 });
    await waitFor(() => frames.some(frame => frame.type === 'fixture_boundary' && frame.stage === 2));
    expect(completions()).toBe(0);
    child.send({ type: 'fixture_release', stage: 2 });
    await waitFor(() => completions() === 1);
    expect(events.filter(event => event.type === 'text_complete').map(event => event.text))
      .toEqual(['FIRST_PHASE', 'DEFERRED_PHASE_DONE']);
    const entrySnapshot = frames.findLast(frame => frame.type === 'fixture_assistant_entries');
    const persistedAssistantEntries = Array.isArray(entrySnapshot?.ids)
      ? entrySnapshot.ids.filter((id): id is string => typeof id === 'string') : [];
    expect(persistedAssistantEntries).toHaveLength(2);
    expect(events.filter(event => event.type === 'pi_turn_anchor').map(event => event.sdkTurnAnchor))
      .toEqual(persistedAssistantEntries);
    adapter.startTurn();
    await send({ type: 'prompt', id: 'next', message: 'A fresh request' });
    await waitFor(() => completions() === 2);
    expect(events.some(event => event.type === 'text_complete' && event.text === 'NEXT_REQUEST_DONE')).toBe(true);
    expect(frames.some(frame => frame.type === 'error')).toBe(false);
  } finally {
    child.send({ type: 'fixture_release_all' });
    await send({ type: 'shutdown' }).catch(() => {});
    const deadline = setTimeout(() => child.kill('SIGKILL'), 1_000);
    await child.exited;
    clearTimeout(deadline);
    await outputReader;
    await errorReader;
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
