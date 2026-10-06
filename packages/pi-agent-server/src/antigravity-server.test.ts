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
  it('correlates a prompt rejected before any child stdin write', async () => {
    const child = spawn(process.execPath, ['src/antigravity-server.ts'], {
      cwd: join(import.meta.dir, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output: Array<Record<string, any>> = [];
    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    lines.on('line', line => output.push(JSON.parse(line)));
    const exit = new Promise<void>(resolve => child.once('exit', () => resolve()));
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 5_000;
      while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`Antigravity bridge timed out: ${JSON.stringify(output)}`);
        await Bun.sleep(10);
      }
    };
    const send = (message: Record<string, unknown>) => child.stdin!.write(`${JSON.stringify(message)}\n`);

    try {
      send({ type: 'prompt', id: 'pre-write-turn', message: 'never sent' });
      await waitFor(() => output.some(message => message.type === 'error'));

      expect(output).toContainEqual({
        type: 'error',
        code: 'prompt_error',
        id: 'pre-write-turn',
        message: 'Google Antigravity rejected this turn before sending it to the provider. Confirm that `agy` is signed in, then try again.',
      });
      expect(output.some(message => message.type === 'provider_handoff')).toBe(false);
    } finally {
      send({ type: 'shutdown' });
      const timer = setTimeout(() => child.kill('SIGKILL'), 1_000);
      await exit;
      clearTimeout(timer);
      lines.close();
    }
  });

  it('keeps a child exit after stdin accepted the prompt uncorrelated', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fake-antigravity-exit-'));
    tempDirectories.push(directory);
    const executable = join(directory, 'agy');
    writeFileSync(executable, `#!/usr/bin/env bun
import { createInterface } from 'node:readline';
console.log(JSON.stringify({ event: 'init', conversation_id: 'conversation-exit' }));
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.event === 'user') setTimeout(() => process.exit(19), 20);
});
`);
    chmodSync(executable, 0o755);
    const child = spawn(process.execPath, ['src/antigravity-server.ts'], {
      cwd: join(import.meta.dir, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        ROBB_ANTIGRAVITY_COMMAND: executable,
      },
    });
    const output: Array<Record<string, any>> = [];
    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    lines.on('line', line => output.push(JSON.parse(line)));
    const exit = new Promise<void>(resolve => child.once('exit', () => resolve()));
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 5_000;
      while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`Antigravity bridge timed out: ${JSON.stringify(output)}`);
        await Bun.sleep(10);
      }
    };
    const send = (message: Record<string, unknown>) => child.stdin!.write(`${JSON.stringify(message)}\n`);

    try {
      send({ type: 'init', cwd: directory, model: 'pi/google-antigravity' });
      await waitFor(() => output.some(message => message.type === 'ready'));
      send({ type: 'prompt', id: 'written-turn', message: 'written before exit' });
      await waitFor(() => output.some(message => (
        message.type === 'event' && message.event?.type === 'agent_end'
      )));

      expect(output).toContainEqual({ type: 'provider_handoff', id: 'written-turn' });
      expect(output.some(message => message.type === 'error' && message.code === 'prompt_error')).toBe(false);
      expect(output.some(message => message.type === 'error' && message.id === 'written-turn')).toBe(false);
    } finally {
      if (child.exitCode === null) send({ type: 'shutdown' });
      const timer = setTimeout(() => child.kill('SIGKILL'), 1_000);
      await exit;
      clearTimeout(timer);
      lines.close();
    }
  });

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

    expect(output).toContainEqual({ type: 'provider_handoff', id: 'turn-1' });
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

  it('passes --model without --effort for partner models even when thinkingLevel is set', async () => {
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

    try {
      child.stdin!.write(`${JSON.stringify({
        type: 'init',
        cwd: import.meta.dir,
        model: 'pi/claude-sonnet-4-6',
        thinkingLevel: 'high',
      })}\n`);
      await waitFor(() => output.some(message => message.type === 'ready'));
      await waitFor(() => Bun.file(fakeAgy.argvLog).size > 0);

      const launchArguments = await Bun.file(fakeAgy.argvLog).json() as string[];
      expect(launchArguments).toContain('--model');
      expect(launchArguments).toContain('claude-sonnet-4-6');
      expect(launchArguments).not.toContain('--effort');
    } finally {
      child.stdin!.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
      await new Promise<void>(resolve => child.once('exit', () => resolve()));
    }
  });

  it('classifies capacity and high traffic errors with actionable guidance', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fake-antigravity-capacity-'));
    tempDirectories.push(directory);
    const executable = join(directory, 'agy');
    writeFileSync(executable, `#!/usr/bin/env bun
import { createInterface } from 'node:readline';
console.log(JSON.stringify({ event: 'init', conversation_id: 'conversation-cap' }));
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.event === 'user') {
    console.log(JSON.stringify({
      event: 'result',
      result: {
        conversation_id: 'conversation-cap',
        status: 'ERROR',
        error: 'UNAVAILABLE (code 503): No capacity available for model gpt-oss-120b-medium on the server',
      },
    }));
  }
});
`);
    chmodSync(executable, 0o755);

    const child = spawn(process.execPath, ['src/antigravity-server.ts'], {
      cwd: join(import.meta.dir, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        ROBB_ANTIGRAVITY_COMMAND: executable,
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

    try {
      child.stdin!.write(`${JSON.stringify({
        type: 'init',
        cwd: directory,
        model: 'pi/gpt-oss-120b-medium',
      })}\n`);
      await waitFor(() => output.some(message => message.type === 'ready'));

      child.stdin!.write(`${JSON.stringify({
        type: 'prompt',
        id: 'turn-cap',
        message: 'hello',
      })}\n`);
      await waitFor(() => output.some(message => message.type === 'error' && (message as any).code === 'GOOGLE_ANTIGRAVITY_CAPACITY_LIMIT'));

      const errorEvent = output.find(m => m.type === 'error');
      expect(errorEvent).toEqual({
        type: 'error',
        code: 'GOOGLE_ANTIGRAVITY_CAPACITY_LIMIT',
        message: 'Google Antigravity servers are experiencing high traffic for this model. Please try again in a moment or switch models.',
      });
    } finally {
      child.stdin!.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
      await new Promise<void>(resolve => child.once('exit', () => resolve()));
    }
  });
});
