import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleLargeResponse } from '../../../shared/src/utils/large-response.ts';
import { createWebFetchTool } from './web-fetch.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('web_fetch large payload handoff', () => {
  it('passes JSON above 50k intact to the central spill pipeline', async () => {
    const url = 'https://1.1.1.1/status';
    const payload = 'x'.repeat(60_000);
    globalThis.fetch = (async () => new Response(JSON.stringify({ status: 'ready', payload }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

    const result = await createWebFetchTool(() => null).execute('web-fetch-large', { url });
    const resultText = result.content.find(item => item.type === 'text')?.text;
    expect(resultText).toBeDefined();
    expect(resultText).not.toContain('[Content truncated]');
    expect(resultText).toContain(payload);

    const sessionPath = mkdtempSync(join(tmpdir(), 'web-fetch-large-'));
    try {
      const spilled = await handleLargeResponse({
        text: resultText!,
        sessionPath,
        context: { toolName: 'web_fetch', input: { url } },
        contextWindow: 200_000,
      });
      expect(spilled).not.toBeNull();
      expect(readFileSync(spilled!.filePath, 'utf8')).toBe(resultText!);
      expect(readFileSync(spilled!.filePath, 'utf8')).toContain(payload);
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });
});
