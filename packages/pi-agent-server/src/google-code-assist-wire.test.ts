import { describe, expect, it } from 'bun:test';
import { Type, type Api, type Model, type Context, type Tool } from '@earendil-works/pi-ai';
import { buildRequest } from './google-code-assist-request.ts';
import { parseSse } from './google-code-assist-wire.ts';

const model: Model<Api> = {
  id: 'gemini-fixture', name: 'Fixture', api: 'google-code-assist', provider: 'google-gemini-code-assist',
  baseUrl: 'https://fixture.invalid', reasoning: false, input: ['text'], contextWindow: 1024, maxTokens: 128,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const tool = (name: string): Tool => ({ name, description: name, parameters: Type.Object({}) });

describe('Code Assist transcript and stream boundary', () => {
  it('replays updated instructions and tools from the current native SDK transcript', () => {
    const context: Context = { messages: [
      { role: 'system', content: 'BASE INSTRUCTIONS', sections: { target: 'OLD TARGET' },
        toolsAdded: [tool('obsolete')], timestamp: 0 },
      { role: 'user', content: 'Inspect fixture', timestamp: 1 },
      { role: 'system', content: 'FOLLOW UP', sections: { target: 'CURRENT TARGET' },
        toolsAdded: [tool('current')], toolsRemoved: [{ name: 'obsolete' }], timestamp: 2 },
    ] };
    const request = buildRequest(model, context, 'fixture-project');
    const prompt = request.request.systemInstruction?.parts[0]?.text;
    expect(prompt).toContain('BASE INSTRUCTIONS');
    expect(prompt).toContain('FOLLOW UP');
    expect(prompt).toContain('CURRENT TARGET');
    expect(prompt).not.toContain('OLD TARGET');
    expect(request.request.tools?.[0]?.functionDeclarations.map(tool => tool.name)).toEqual(['current']);
    expect(request.request.contents).toEqual([{ role: 'user', parts: [{ text: 'Inspect fixture' }] }]);
  });

  it('preserves shorthand instructions and tools accepted by the public API', () => {
    const request = buildRequest(model, { systemPrompt: 'ROBB INSTRUCTIONS', tools: [tool('read')], messages: [] }, undefined);
    expect(request.request.systemInstruction?.parts[0]?.text).toBe('ROBB INSTRUCTIONS');
    expect(request.request.tools?.[0]?.functionDeclarations[0]?.name).toBe('read');
  });

  it('reads CRLF and a final unterminated frame, including UTF-8 split between chunks', async () => {
    const chunks = [
      { response: { candidates: [{ content: { parts: [{ text: 'Vérifié 🎯' }] } }] } },
      { response: { candidates: [{ finishReason: 'STOP' }] } },
    ];
    const bytes = new TextEncoder().encode(chunks.map(chunk => `data: ${JSON.stringify(chunk)}`).join('\r\n\r\n'));
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }));
    expect(await Array.fromAsync(parseSse(response))).toEqual(chunks);
  });

  it('ignores SSE comments and the standard terminal marker', async () => {
    expect(await Array.fromAsync(parseSse(new Response(': keepalive\n\ndata: [DONE]\n\n')))).toEqual([]);
  });

  it('rejects malformed provider fields at the JSON boundary', async () => {
    const malformed = { response: { candidates: [{ content: { parts: [{ functionCall: { name: 'read', args: 'invalid' } }] } }] } };
    await expect(Array.fromAsync(parseSse(new Response(`data: ${JSON.stringify(malformed)}\n\n`)))).rejects.toThrow();
    await expect(Array.fromAsync(parseSse(new Response(null)))).rejects.toThrow('empty stream');
  });
});
