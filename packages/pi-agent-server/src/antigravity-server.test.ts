import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createFakeAntigravity(): { executable: string; argvLog: string } {
  const directory = mkdtempSync(join(tmpdir(), 'fake-antigravity-'));
  tempDirectories.push(directory);
  const path = join(directory, 'agy');
  const argvLog = join(directory, 'argv.json');
  writeFileSync(path, `#!/usr/bin/env bun
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ event: 'init', conversation_id: 'conversation-test', init: { permission_mode: 'request-review' } }));
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let turns = 0;
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.event !== 'user') return;
  turns += 1;
  const response = turns === 1 ? 'bridge-ok\\n' : 'context-ok\\n';
  console.log(JSON.stringify({ event: 'step_update', step_update: {
    conversation_id: 'conversation-test', step_index: turns, state: 'DONE',
    step_type: 'agent_response', text_delta: response,
  } }));
  console.log(JSON.stringify({ event: 'result', result: {
    conversation_id: 'conversation-test', status: 'SUCCESS', response,
    num_turns: turns, usage: {
      input_tokens: turns * 100, output_tokens: turns * 10,
      thinking_tokens: 0, cache_read_tokens: turns === 1 ? 0 : 50,
      total_tokens: turns * 110,
    },
  } }));
});
`);
  chmodSync(path, 0o755);
  return { executable: path, argvLog };
}

describe('Google Antigravity NDJSON bridge', () => {
  it('maps session, streaming text, terminal message, and usage events', async () => {
    const fakeAgy = createFakeAntigravity();
    const child = spawn(process.execPath, ['src/antigravity-server.ts'], {
      cwd: join(import.meta.dir, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        ROBB_ANTIGRAVITY_COMMAND: fakeAgy.executable,
      },
    });
    const output: Array<Record<string, unknown>> = [];
    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    lines.on('line', line => output.push(JSON.parse(line)));

    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 10_000;
      while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for Antigravity bridge output');
        await Bun.sleep(10);
      }
    };

    child.stdin!.write(`${JSON.stringify({
      type: 'init',
      cwd: import.meta.dir,
      model: 'pi/gemini-3.7-flash-low',
      thinkingLevel: 'low',
    })}\n`);
    await waitFor(() => output.some(message => message.type === 'ready'));
    await waitFor(() => Bun.file(fakeAgy.argvLog).size > 0);

    const launchArguments = await Bun.file(fakeAgy.argvLog).json() as string[];
    expect(launchArguments).toContain('--new-project');
    expect(launchArguments).not.toContain('--conversation');

    child.stdin!.write(`${JSON.stringify({
      type: 'prompt',
      id: 'turn-1',
      message: 'test',
      systemPrompt: 'Follow Robb instructions.',
    })}\n`);
    await waitFor(() => output.some(message => (
      message.type === 'event'
      && (message.event as Record<string, unknown>)?.type === 'agent_end'
    )));

    expect(output).toContainEqual({ type: 'session_id_update', sessionId: 'conversation-test' });
    expect(output).toContainEqual({
      type: 'event',
      event: {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'bridge-ok\n' },
      },
    });
    const messageEnd = output.find(message => (
      message.type === 'event'
      && (message.event as Record<string, unknown>)?.type === 'message_end'
    ));
    expect(messageEnd).toBeDefined();
    expect((messageEnd!.event as any).message.content[0].text).toBe('bridge-ok\n');
    expect((messageEnd!.event as any).message.usage).toEqual({
      input: 100,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 110,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    });

    child.stdin!.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
    await new Promise<void>(resolve => child.once('exit', () => resolve()));
  });
});
