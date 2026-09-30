import { describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import { ToolAdmissionRecoveryError, type BackendConfig } from '../backend/types.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function config(sessionId: string): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'pi-tool-admission-workspace',
      name: 'Pi tool admission workspace',
      rootPath: '/tmp/pi-tool-admission-workspace',
    } as never,
    session: {
      id: sessionId,
      workspaceRootPath: '/tmp/pi-tool-admission-workspace',
      createdAt: 1,
      lastUsedAt: 1,
    } as never,
    isHeadless: true,
  };
}

function harness(name: string) {
  const sessionId = `${name}-${Date.now()}`;
  const agent = new PiAgent(config(sessionId));
  const internals = agent as any;
  const runtime = { runtimeId: `${name}-runtime`, sessionId };
  const sent: Array<Record<string, unknown>> = [];
  let poolCalls = 0;
  internals.subprocessRuntimeContext = runtime;
  internals.send = (message: Record<string, unknown>) => sent.push(message);
  internals.prerequisiteManager = { checkPrerequisites: () => ({ allowed: true }) };
  internals.config.mcpPool = {
    isProxyTool: () => true,
    callTool: async () => {
      poolCalls += 1;
      return { content: '{"ok":true}', isError: false };
    },
  };
  internals.beginContextualGmailHostExecution = () => ({ applies: false, allowed: true });
  const admit = (toolUseId: string, args: Record<string, unknown>) => internals.admitToolExecution({
    toolUseId,
    toolName: 'mcp__fixture__read_exact',
    toolInput: args,
    sessionId,
    runtimeId: runtime.runtimeId,
    authorizationEpoch: internals.promptPreparationRevision,
  });
  const execute = (toolUseId: string, args: Record<string, unknown>) => internals.handleToolExecuteRequest({
    requestId: `request-${toolUseId}`,
    toolName: 'mcp__fixture__read_exact',
    toolCallId: toolUseId,
    args,
  }, runtime);
  return { agent, internals, runtime, sent, admit, execute, poolCalls: () => poolCalls };
}

describe('Pi exact PreToolUse execution admission', () => {
  it('awaits the host durability barrier before allowing the exact execution', async () => {
    const h = harness('pi-durable-admission');
    const entered = deferred();
    const release = deferred();
    const observed: Array<Record<string, unknown>> = [];
    h.internals.config.beforeToolExecution = async (request: Record<string, unknown>) => {
      observed.push(request);
      entered.resolve();
      await release.promise;
    };

    h.internals.sendPreToolUseDecision({
      requestId: 'pretool-durable',
      toolName: 'mcp__fixture__read_exact',
      toolCallId: 'tool-durable',
      originalInput: { query: 'durable' },
      runtimeContext: h.runtime,
      authorizationEpoch: h.internals.promptPreparationRevision,
    }, {
      type: 'pre_tool_use_response', requestId: 'pretool-durable', action: 'allow',
    });

    await entered.promise;
    expect(h.sent).toEqual([]);
    expect(observed).toEqual([{
      toolUseId: 'tool-durable',
      toolName: 'mcp__fixture__read_exact',
      toolInput: { query: 'durable' },
    }]);
    release.resolve();
    await Promise.resolve(); await Promise.resolve();
    expect(h.sent.at(-1)).toMatchObject({
      type: 'pre_tool_use_response', requestId: 'pretool-durable', action: 'allow',
    });
    await h.execute('tool-durable', { query: 'durable' });
    expect(h.poolCalls()).toBe(1);
    h.agent.destroy();
  });

  it('blocks execution when the host durability barrier rejects', async () => {
    const h = harness('pi-failed-durable-admission');
    h.internals.config.beforeToolExecution = async () => {
      throw new Error('Synthetic disk failure');
    };
    h.internals.sendPreToolUseDecision({
      requestId: 'pretool-failed-durable',
      toolName: 'mcp__fixture__read_exact',
      toolCallId: 'tool-failed-durable',
      originalInput: { query: 'blocked' },
      runtimeContext: h.runtime,
      authorizationEpoch: h.internals.promptPreparationRevision,
    }, {
      type: 'pre_tool_use_response', requestId: 'pretool-failed-durable', action: 'allow',
    });
    await Promise.resolve(); await Promise.resolve();
    expect(h.sent.at(-1)).toMatchObject({
      type: 'pre_tool_use_response', requestId: 'pretool-failed-durable', action: 'block',
    });
    expect(String(h.sent.at(-1)?.reason)).toContain('durably record');
    expect(String(h.sent.at(-1)?.reason)).not.toContain('Synthetic disk failure');
    await h.execute('tool-failed-durable', { query: 'blocked' });
    expect(h.poolCalls()).toBe(0);
    h.agent.destroy();
  });

  it('shows only an allowlisted host recovery explanation', async () => {
    const h = harness('pi-safe-recovery-admission');
    h.internals.config.beforeToolExecution = async () => {
      throw new ToolAdmissionRecoveryError(
        'Automatic recovery exactly-once fence: reuse the persisted receipt; do not retry or request permission.',
      );
    };
    h.internals.sendPreToolUseDecision({
      requestId: 'pretool-safe-recovery',
      toolName: 'mcp__fixture__read_exact',
      toolCallId: 'tool-safe-recovery',
      originalInput: { query: 'blocked' },
      runtimeContext: h.runtime,
      authorizationEpoch: h.internals.promptPreparationRevision,
    }, {
      type: 'pre_tool_use_response', requestId: 'pretool-safe-recovery', action: 'allow',
    });
    await Promise.resolve(); await Promise.resolve();
    expect(h.sent.at(-1)).toMatchObject({
      type: 'pre_tool_use_response', requestId: 'pretool-safe-recovery', action: 'block',
      reason: 'Automatic recovery exactly-once fence: reuse the persisted receipt; do not retry or request permission.',
    });
    await h.execute('tool-safe-recovery', { query: 'blocked' });
    expect(h.poolCalls()).toBe(0);
    h.agent.destroy();
  });

  it('consumes one exact admission and rejects duplicate or input-altered executions', async () => {
    const h = harness('pi-exact-admission');
    expect(h.admit('tool-exact', { query: 'A' })).toBe(true);
    await h.execute('tool-exact', { query: 'A' });
    expect(h.poolCalls()).toBe(1);

    await h.execute('tool-exact', { query: 'A' });
    expect(h.poolCalls()).toBe(1);
    expect((h.sent.at(-1)?.result as { content: string }).content).toContain('exact current PreToolUse admission');

    expect(h.admit('tool-altered', { query: 'A' })).toBe(true);
    await h.execute('tool-altered', { query: 'B' });
    expect(h.poolCalls()).toBe(1);
    h.agent.destroy();
  });

  it('hard-stops and revokes an admitted A before a queued B can race its proxy execution', async () => {
    const h = harness('pi-steer-admission');
    let killed = 0;
    h.internals._isProcessing = true;
    h.internals.subprocess = {};
    h.internals.killSubprocess = () => {
      killed += 1;
      h.internals.subprocess = null;
    };
    expect(h.admit('tool-a', { query: 'A' })).toBe(true);

    expect(h.agent.redirect('Use target B instead.')).toBe(false);
    expect(killed).toBe(1);
    await h.execute('tool-a', { query: 'A' });
    expect(h.poolCalls()).toBe(0);
    expect((h.sent.at(-1)?.result as { content: string }).content).toContain('exact current PreToolUse admission');
    h.agent.destroy();
  });
});
