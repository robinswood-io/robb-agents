import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

describe('Mistral Vibe ACP bridge host instructions', () => {
  it.each([
    { action: 'allow', expectedOption: 'allow-once' },
    { action: 'modify', expectedOption: 'reject-once' },
    { action: 'block', expectedOption: 'reject-once' },
  ])('delivers host context and maps a $action permission to $expectedOption', async ({ action, expectedOption }) => {
    const directory = mkdtempSync(join(tmpdir(), 'robb-vibe-acp-test-'));
    const executable = join(directory, 'vibe-acp');
    const promptLog = join(directory, 'prompts.jsonl');
    const permissionLog = join(directory, 'permissions.jsonl');
    writeFileSync(executable, `#!/usr/bin/env bun
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = (message) => console.log(JSON.stringify(message));
const pendingPrompts = new Map();
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'vibe-test-session' } });
  } else if (message.method === 'session/prompt') {
    appendFileSync(${JSON.stringify(promptLog)}, JSON.stringify(message.params.prompt) + '\\n');
    const permissionId = 'permission-' + message.id;
    pendingPrompts.set(permissionId, message.id);
    send({ jsonrpc: '2.0', id: permissionId, method: 'session/request_permission', params: {
      sessionId: 'vibe-test-session',
      toolCall: { toolCallId: permissionId, title: 'write_file', kind: 'edit', status: 'pending', rawInput: { path: 'original.txt' } },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
      ]
    } });
  } else if (pendingPrompts.has(message.id)) {
    appendFileSync(${JSON.stringify(permissionLog)}, JSON.stringify(message.result) + '\\n');
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'vibe-test-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } }
    } });
    send({ jsonrpc: '2.0', id: pendingPrompts.get(message.id), result: { stopReason: 'end_turn' } });
    pendingPrompts.delete(message.id);
  }
});
`);
    chmodSync(executable, 0o755);
    const child = spawn(process.execPath, ['src/vibe-acp-server.ts'], {
      cwd: join(import.meta.dir, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { HOME: directory, PATH: process.env.PATH, ROBB_VIBE_ACP_COMMAND: executable },
    });
    const output: Array<Record<string, any>> = [];
    let stderr = '';
    child.stderr!.on('data', chunk => { stderr += chunk; });
    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    lines.on('line', line => {
      const message = JSON.parse(line);
      output.push(message);
      if (message.type === 'pre_tool_use_request') {
        send({ type: 'pre_tool_use_response', requestId: message.requestId, action, input: { path: 'rewritten-safe.txt' } });
      }
    });
    const exit = new Promise<void>(resolve => child.once('exit', () => resolve()));
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 5_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`Vibe bridge timed out: ${JSON.stringify(output)} ${stderr}`);
        await Bun.sleep(10);
      }
    };
    const send = (message: Record<string, unknown>) => child.stdin!.write(`${JSON.stringify(message)}\n`);

    try {
      send({ type: 'init', cwd: directory, model: 'pi/mistral-vibe' });
      await waitFor(() => output.some(message => message.type === 'ready'));
      for (const [index, systemPrompt] of ['Use the agreed workspace.', 'Use the agreed workspace.', 'Inspect only; do not modify files.'].entries()) {
        send({ type: 'prompt', id: `turn-${index}`, message: `User input ${index}`, systemPrompt });
        await waitFor(() => output.filter(message => message.event?.type === 'agent_end').length === index + 1);
      }

      const prompts = readFileSync(promptLog, 'utf8').trim().split('\n')
        .map(line => (JSON.parse(line) as Array<{ text?: string }>).map(block => block.text ?? '').join(''));
      expect(prompts).toHaveLength(3);
      expect(prompts[0]).toContain('<robb_system_instructions>\nUse the agreed workspace.\n</robb_system_instructions>');
      expect(prompts[0]).toContain('User input 0');
      expect(prompts[1]).toBe('User input 1');
      expect(prompts[2]).toContain('Inspect only; do not modify files.');
      expect(prompts[2]).toContain('User input 2');
      const permissions = readFileSync(permissionLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(permissions).toHaveLength(3);
      for (const permission of permissions) {
        expect(permission).toEqual({ outcome: { outcome: 'selected', optionId: expectedOption } });
      }
      expect(output.filter(message => message.type === 'error')).toHaveLength(0);
    } finally {
      send({ type: 'shutdown' });
      const timer = setTimeout(() => child.kill('SIGKILL'), 1_000);
      await exit;
      clearTimeout(timer);
      lines.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
