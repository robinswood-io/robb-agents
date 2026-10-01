import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

describe('Mistral Pi transport through the request interceptor', () => {
  it('sends native reasoning, cache keys and preserved thinking on the actual SDK wire format', () => {
    const testDirectory = mkdtempSync(resolve(tmpdir(), 'robb-mistral-contract-'));
    try {
      const bunConfig = resolve(testDirectory, 'bunfig.toml');
      writeFileSync(bunConfig, '');
      // A separate process ensures the SDK captures the intercepted mock fetch.
      // Homedir is mocked before loading the interceptor, isolating its logs and
      // config reads without changing HOME or accessing a real user profile.
      const script = `
        import { mock } from 'bun:test';
        import * as os from 'node:os';
        mock.module('node:os', () => ({ ...os, homedir: () => process.env.ROBB_PROVIDER_TEST_DIR }));
        const requests = [];
        globalThis.fetch = async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);
          const body = JSON.parse(await request.text());
          requests.push({ url: request.url, body });
          const chunk = {
            id: 'test-completion', object: 'chat.completion.chunk', created: 1, model: body.model,
            choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101, prompt_tokens_details: { cached_tokens: 80 } },
          };
          return new Response('data: ' + JSON.stringify(chunk) + '\\n\\ndata: [DONE]\\n\\n', {
            headers: { 'content-type': 'text/event-stream' },
          });
        };
        await import('./packages/shared/src/unified-network-interceptor.ts');
        const { getModel, streamSimple } = await import('@earendil-works/pi-ai/compat');
        const results = [];
        for (const id of ['mistral-medium-3-5', 'mistral-medium-2604', 'mistral-small-latest']) {
          const model = { ...getModel('mistral', id === 'mistral-medium-3-5' ? 'mistral-medium-2604' : id), id };
          const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
          const context = { messages: [
            { role: 'user', content: 'Inspect the file', timestamp: 1 },
            { role: 'assistant', content: [
              { type: 'thinking', thinking: 'Earlier reasoning' },
              { type: 'toolCall', id: 'abcdefghi', name: 'read', arguments: { path: 'example.txt' } },
            ], api: model.api, provider: 'mistral', model: id, usage, stopReason: 'toolUse', timestamp: 2 },
            { role: 'toolResult', toolCallId: 'abcdefghi', toolName: 'read', content: [{ type: 'text', text: 'file content' }], isError: false, timestamp: 3 },
          ] };
          for (const reasoning of ['off', 'low', 'medium', 'high', 'xhigh']) {
            const result = await streamSimple(model, context, {
              apiKey: 'offline-test-key', reasoning, sessionId: 'offline-session', maxTokens: 128,
            }).result();
            results.push({ stopReason: result.stopReason, errorMessage: result.errorMessage, usage: result.usage });
          }
        }
        console.log(JSON.stringify({ requests, results }));
      `;
      // Ignore the repository preload so the mock is installed before the
      // interceptor captures fetch and imports homedir.
      const child = Bun.spawnSync([process.execPath, `--config=${bunConfig}`, '--no-env-file', '--eval', script], {
        cwd: resolve(import.meta.dir, '../../..'),
        env: {
          ...process.env,
          ROBB_PROVIDER_TEST_DIR: testDirectory,
          CRAFT_CONFIG_DIR: testDirectory,
          CRAFT_SESSION_DIR: testDirectory,
          CRAFT_PI_MODEL_API: 'mistral-conversations',
          CRAFT_INTERCEPTOR_DISABLE_AUTO_INSTALL: '0',
          CRAFT_DEBUG: '0',
          CRAFT_DEBUG_SSE_RAW: '0',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect({ code: child.exitCode, stderr: child.stderr.toString() }).toEqual({ code: 0, stderr: '' });
      const { requests, results } = JSON.parse(child.stdout.toString());
      expect(requests).toHaveLength(15);
      for (const [index, request] of requests.entries()) {
        expect(request.url).toBe('https://api.mistral.ai/v1/chat/completions');
        if (index % 5 === 0) expect(request.body).not.toHaveProperty('reasoning_effort');
        else expect(request.body).toMatchObject({ reasoning_effort: 'high' });
        expect(request.body).not.toHaveProperty('prompt_mode');
        expect(request.body.prompt_cache_key).toBe('offline-session');
        const assistant = request.body.messages.find((message: { role: string }) => message.role === 'assistant');
        expect(assistant.content).toContainEqual({
          type: 'thinking', thinking: [{ type: 'text', text: 'Earlier reasoning' }],
        });
        expect(assistant.tool_calls[0].id).toBe('abcdefghi');
      }
      for (const result of results) {
        expect(result.stopReason).toBe('stop');
        expect(result.errorMessage).toBeUndefined();
        expect(result.usage).toMatchObject({ input: 20, cacheRead: 80, output: 1, totalTokens: 101 });
      }
    } finally {
      rmSync(testDirectory, { recursive: true, force: true });
    }
  });
});
