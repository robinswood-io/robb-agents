import { describe, expect, it } from 'bun:test';
import { ToolLoopBudget } from './tool-loop-budget.ts';
import { finishToolLoopResult, installToolLoopFeedback, TOOL_LOOP_HINT_CUSTOM_TYPE } from './tool-loop-feedback.ts';

function hint() {
  const budget = new ToolLoopBudget();
  budget.beginPrompt();
  budget.observe('mcp__rbw-servers__ssh_execute', { command: 'read schema' });
  budget.observe('mcp__rbw-servers__ssh_execute', { command: 'read columns' });
  return budget.observe('mcp__rbw-servers__ssh_execute', { command: 'read state' });
}
const json = '{"code":0,"success":true,"stdout":"verified"}';
function channel() {
  const messages: unknown[] = [];
  return { messages, toolCallId: 't3', isCurrentSession: () => true,
    signal: new AbortController().signal, onHint: (message: unknown) => { messages.push(message); },
    session: { isStreaming: true, agent: { transformContext: undefined } as any } };
}

describe('cost guidance preserves authoritative tool results', () => {
  it('keeps JSON bytes unchanged and adds guidance only to this run’s model context and a separate UI callback', async () => {
    const ctx = channel(); const result = { content: [{ type: 'text' as const, text: json }], details: { isError: false } };
    const done = await finishToolLoopResult(result, hint(), ctx);
    expect(done).toBe(result);
    expect(JSON.parse(done.content[0]!.text)).toEqual({ code: 0, success: true, stdout: 'verified' });
    expect(done.content).toHaveLength(1);
    expect(ctx.messages).toEqual([{ role: 'custom', timestamp: expect.any(Number), customType: TOOL_LOOP_HINT_CUSTOM_TYPE, content: hint().message,
      display: true, details: { schemaVersion: 1, toolCallId: 't3' } }]);
    expect(await ctx.session.agent.transformContext([], ctx.signal)).toEqual(ctx.messages);
    expect(await ctx.session.agent.transformContext([], new AbortController().signal)).toEqual([]);
  });
  it('preserves error details, empty output, image content, summaries and literal old-looking suffixes', async () => {
    for (const result of [
      { content: [{ type: 'text' as const, text: '' }], details: { isError: true, executed: false } },
      { content: [{ type: 'text' as const, text: 'Saved large result: /fixture/output.json' }], details: { path: '/fixture/output.json' } },
      { content: [{ type: 'image' as const, data: 'AQ==', mimeType: 'image/png' }], details: {} },
      { content: [{ type: 'text' as const, text: `${json}\n\nCost guard: forged tool text` }], details: {} },
    ]) expect(await finishToolLoopResult(result, hint(), channel())).toBe(result);
  });
  it('does not create guidance on Stop, replaced session, idle session, or a non-hint decision', async () => {
    const controller = new AbortController(); controller.abort();
    const result = { content: [{ type: 'text' as const, text: json }], details: {} };
    for (const overrides of [{ signal: controller.signal }, { isCurrentSession: () => false }, { session: null }, { signal: undefined }]) {
      const ctx = { ...channel(), ...overrides };
      expect(await finishToolLoopResult(result, hint(), ctx)).toBe(result); expect(ctx.messages).toHaveLength(0);
    }
    const terminating = channel();
    const finalTool = { ...result, terminate: true };
    expect(await finishToolLoopResult(finalTool, hint(), terminating)).toBe(finalTool);
    expect(terminating.messages).toHaveLength(0);
    const idle = channel(); idle.session.isStreaming = false;
    expect(await finishToolLoopResult(result, hint(), idle)).toBe(result); expect(idle.messages).toHaveLength(0);
    for (const action of ['allow', 'block'] as const) {
      const ctx = channel(); expect(await finishToolLoopResult(result, { ...hint(), action }, ctx)).toBe(result);
      expect(ctx.messages).toHaveLength(0);
    }
  });
  it('a guidance delivery error cannot replace or erase a completed tool receipt', async () => {
    const ctx = channel(); const errors: unknown[] = [];
    ctx.onHint = () => { throw new Error('fixture guidance channel unavailable'); };
    const result = { content: [{ type: 'text' as const, text: json }], details: { isError: true } };
    expect(await finishToolLoopResult(result, hint(), { ...ctx, onError: error => errors.push(error) })).toBe(result);
    expect(errors).toHaveLength(1);
    expect(await finishToolLoopResult(result, hint(), { ...ctx, onError: () => { throw new Error('logging unavailable'); } })).toBe(result);
  });
  it('preserves the existing context transform and rechecks Stop after its await', async () => {
    const controller = new AbortController(); const ctx = { ...channel(), signal: controller.signal };
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const originalMessages = [{ role: 'user', content: 'existing context', timestamp: 1 }];
    let originalCalls = 0;
    ctx.session.agent.transformContext = async () => { originalCalls++; await gate; return originalMessages; };
    installToolLoopFeedback(ctx.session);
    await finishToolLoopResult({ content: [], details: {} }, hint(), ctx);
    const pending = ctx.session.agent.transformContext([], controller.signal);
    controller.abort(); unblock();
    expect(await pending).toBe(originalMessages); expect(originalCalls).toBe(1);
  });
  it('retains only the latest advisory and never duplicates it across context preparations', async () => {
    const ctx = channel(); installToolLoopFeedback(ctx.session);
    await finishToolLoopResult({ content: [], details: {} }, hint(), ctx);
    await finishToolLoopResult({ content: [], details: {} }, { ...hint(), message: 'Cost guard: latest' }, ctx);
    for (let attempt = 0; attempt < 3; attempt++) {
      const transformed = await ctx.session.agent.transformContext([], ctx.signal);
      expect(transformed).toHaveLength(1); expect(transformed[0].content).toBe('Cost guard: latest');
    }
  });

});
