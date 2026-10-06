import { describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';
import type { ContextualGmailHostExecutionTicket } from '../core/pre-tool-use.ts';

function createConfig(sessionId: string): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'gmail-host-lifecycle-workspace',
      name: 'Gmail host lifecycle workspace',
      rootPath: '/tmp/gmail-host-lifecycle-workspace',
    } as never,
    session: {
      id: sessionId,
      workspaceRootPath: '/tmp/gmail-host-lifecycle-workspace',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as never,
    isHeadless: true,
  };
}

function ticket(sessionId: string): ContextualGmailHostExecutionTicket {
  return {
    generation: 1,
    hostExecutionToken: 'host-execution-token',
    runtimeId: 'pi-runtime-1',
    sessionId,
    toolUseId: 'gmail-tool-1',
  };
}

function admitExecution(
  internals: any,
  runtime: { runtimeId: string; sessionId: string },
  toolName: string,
  toolUseId: string,
  args: Record<string, unknown>,
): void {
  expect(internals.admitToolExecution({
    toolUseId,
    toolName,
    toolInput: args,
    sessionId: runtime.sessionId,
    runtimeId: runtime.runtimeId,
    authorizationEpoch: internals.promptPreparationRevision,
  })).toBe(true);
}

describe('Pi Gmail host execution lifecycle', () => {
  it('preserves ordinary headless Ask behavior while keeping sensitive prompts fail-closed', async () => {
    const sessionId = `pi-headless-ask-${Date.now()}`;
    const agent = new PiAgent(createConfig(sessionId));
    const internals = agent as any;
    const runtime = { runtimeId: 'pi-runtime-ask', sessionId };
    const sent: Array<Record<string, unknown>> = [];
    internals.subprocessRuntimeContext = runtime;
    internals.send = (message: Record<string, unknown>) => sent.push(message);
    internals.resolveContextualGmailPromptDecision = () => ({ applies: false, allowed: false });

    await internals.handlePreToolUsePrompt(
      'ordinary-request',
      'Read',
      { file_path: '/tmp/original' },
      sessionId,
      { type: 'prompt', description: 'ordinary prompt', modifiedInput: { file_path: '/tmp/normalized' } },
      'ordinary-tool',
      runtime,
    );
    await internals.handlePreToolUsePrompt(
      'sensitive-request',
      'Bash',
      { command: 'deploy' },
      sessionId,
      { type: 'prompt', description: 'sensitive prompt', requiresExplicitConfirmation: true },
      'sensitive-tool',
      runtime,
    );

    expect(sent).toEqual([
      {
        type: 'pre_tool_use_response',
        requestId: 'ordinary-request',
        action: 'modify',
        input: { file_path: '/tmp/normalized' },
      },
      {
        type: 'pre_tool_use_response',
        requestId: 'sensitive-request',
        action: 'block',
        reason: 'Explicit confirmation is required for this sensitive external action, but no permission handler is available.',
      },
    ]);
    internals.subprocessRuntimeContext = null;
    agent.destroy();
  });

  it('never calls the MCP pool when the final host guard refuses execution', async () => {
    const agent = new PiAgent(createConfig(`pi-gmail-denied-${Date.now()}`));
    let poolCalls = 0;
    const internals = agent as any;
    internals.config.mcpPool = {
      isProxyTool: () => true,
      callTool: async () => {
        poolCalls += 1;
        return { content: 'unexpected', isError: false };
      },
    };
    const result = await internals.routeToolCall(
      'mcp__google-contacts__gmail_reply_bound',
      { messageId: '1a0a917ea946a540' },
      'gmail-tool-1',
      { runtimeId: 'pi-runtime-1', sessionId: internals.config.session.id },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('no exact admitted reservation');
    expect(poolCalls).toBe(0);
    agent.destroy();
  });

  it('keeps the host ticket live until a deferred MCP call settles', async () => {
    const sessionId = `pi-gmail-deferred-${Date.now()}`;
    const agent = new PiAgent(createConfig(sessionId));
    const internals = agent as any;
    const executionTicket = ticket(sessionId);
    let releasePool!: () => void;
    const poolGate = new Promise<void>(resolve => { releasePool = resolve; });
    let poolCalls = 0;
    const settled: ContextualGmailHostExecutionTicket[] = [];
    internals.config.mcpPool = {
      isProxyTool: () => true,
      callTool: async () => {
        poolCalls += 1;
        await poolGate;
        return { content: '{"ok":true}', isError: false };
      },
    };
    internals.beginContextualGmailHostExecution = () => ({
      applies: true,
      allowed: true,
      ticket: executionTicket,
    });
    internals.settleContextualGmailHostExecution = (
      received: ContextualGmailHostExecutionTicket,
    ) => {
      settled.push(received);
      return true;
    };

    const resultPromise = internals.routeToolCall(
      'mcp__google-contacts__gmail_reply_bound',
      { messageId: '1a0a917ea946a540' },
      'gmail-tool-1',
      { runtimeId: 'pi-runtime-1', sessionId },
    );
    await Promise.resolve();

    expect(poolCalls).toBe(1);
    expect(settled).toEqual([]);

    releasePool();
    await expect(resultPromise).resolves.toEqual({ content: '{"ok":true}', isError: false });
    expect(settled).toEqual([executionTicket]);
    agent.destroy();
  });

  it('settles the exact host ticket even when the MCP pool throws', async () => {
    const sessionId = `pi-gmail-throw-${Date.now()}`;
    const agent = new PiAgent(createConfig(sessionId));
    const internals = agent as any;
    const executionTicket = ticket(sessionId);
    let settleCalls = 0;
    internals.config.mcpPool = {
      isProxyTool: () => true,
      callTool: async () => {
        throw new Error('transport lost after dispatch');
      },
    };
    internals.beginContextualGmailHostExecution = () => ({
      applies: true,
      allowed: true,
      ticket: executionTicket,
    });
    internals.settleContextualGmailHostExecution = () => {
      settleCalls += 1;
      return true;
    };

    await expect(internals.routeToolCall(
      'mcp__google-contacts__gmail_reply_bound',
      { messageId: '1a0a917ea946a540' },
      'gmail-tool-1',
      { runtimeId: 'pi-runtime-1', sessionId },
    )).rejects.toThrow('transport lost after dispatch');
    expect(settleCalls).toBe(1);
    agent.destroy();
  });

  it.each([
    ['a source prerequisite blocks', false, true],
    ['the admitted proxy disappeared', true, false],
  ])('settles the host reservation when %s before dispatch', async (_label, prerequisiteAllowed, proxyAvailable) => {
    const sessionId = `pi-gmail-local-block-${Date.now()}-${String(prerequisiteAllowed)}`;
    const agent = new PiAgent(createConfig(sessionId));
    const internals = agent as any;
    const runtime = { runtimeId: 'pi-runtime-1', sessionId };
    const executionTicket = ticket(sessionId);
    const sent: Array<Record<string, unknown>> = [];
    let poolCalls = 0;
    const settled: ContextualGmailHostExecutionTicket[] = [];
    internals.subprocessRuntimeContext = runtime;
    internals.send = (message: Record<string, unknown>) => sent.push(message);
    internals.prerequisiteManager = {
      checkPrerequisites: () => prerequisiteAllowed
        ? { allowed: true }
        : { allowed: false, blockReason: 'Read the source guide first.' },
    };
    internals.config.mcpPool = {
      isProxyTool: () => proxyAvailable,
      callTool: async () => {
        poolCalls += 1;
        return { content: 'unexpected', isError: false };
      },
    };
    internals.beginContextualGmailHostExecution = () => ({
      applies: true,
      allowed: true,
      ticket: executionTicket,
    });
    internals.settleContextualGmailHostExecution = (received: ContextualGmailHostExecutionTicket) => {
      settled.push(received);
      return true;
    };

    admitExecution(
      internals,
      runtime,
      'mcp__google-contacts__gmail_reply_bound',
      'gmail-tool-1',
      { messageId: '1a0a917ea946a540' },
    );

    await internals.handleToolExecuteRequest({
      requestId: 'gmail-request',
      toolName: 'mcp__google-contacts__gmail_reply_bound',
      toolCallId: 'gmail-tool-1',
      args: { messageId: '1a0a917ea946a540' },
    }, runtime);

    expect(poolCalls).toBe(0);
    expect(settled).toEqual([executionTicket]);
    expect(sent).toHaveLength(1);
    expect((sent[0] as any).result.isError).toBe(true);
    internals.subprocessRuntimeContext = null;
    agent.destroy();
  });

  it('does not deliver a delayed old-runtime tool response to its replacement', async () => {
    const sessionId = `pi-gmail-stale-response-${Date.now()}`;
    const agent = new PiAgent(createConfig(sessionId));
    const internals = agent as any;
    const oldRuntime = { runtimeId: 'pi-runtime-old', sessionId };
    const newRuntime = { runtimeId: 'pi-runtime-new', sessionId };
    let releasePool!: () => void;
    const poolGate = new Promise<void>(resolve => { releasePool = resolve; });
    const sent: Array<Record<string, unknown>> = [];
    internals.subprocessRuntimeContext = oldRuntime;
    internals.send = (message: Record<string, unknown>) => sent.push(message);
    internals.prerequisiteManager = { checkPrerequisites: () => ({ allowed: true }) };
    internals.config.mcpPool = {
      isProxyTool: () => true,
      callTool: async () => {
        await poolGate;
        return { content: 'old result', isError: false };
      },
    };
    internals.beginContextualGmailHostExecution = () => ({ applies: false, allowed: true });

    admitExecution(
      internals,
      oldRuntime,
      'mcp__example__read',
      'old-tool-call',
      {},
    );

    const pending = internals.handleToolExecuteRequest({
      requestId: 'old-request',
      toolName: 'mcp__example__read',
      toolCallId: 'old-tool-call',
      args: {},
    }, oldRuntime);
    await Promise.resolve();
    internals.subprocessRuntimeContext = newRuntime;
    releasePool();
    await pending;

    expect(sent).toEqual([]);
    internals.subprocessRuntimeContext = null;
    agent.destroy();
  });
});
