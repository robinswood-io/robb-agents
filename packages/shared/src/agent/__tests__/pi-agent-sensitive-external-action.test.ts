import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

function createConfig(): BackendConfig {
  const sessionId = `pi-sensitive-action-${randomUUID()}`;
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-sensitive-action',
      name: 'Sensitive action test',
      rootPath: '/tmp/robb-sensitive-action-test',
    } as never,
    session: {
      id: sessionId,
      workspaceRootPath: '/tmp/robb-sensitive-action-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/robb-sensitive-action-test',
    } as never,
    isHeadless: true,
  };
}

describe('PiAgent sensitive external action gate', () => {
  it('fails closed without a permission handler for a generic continuation', async () => {
    const agent = new PiAgent(createConfig());
    const sent: Array<Record<string, unknown>> = [];
    (agent as unknown as { send: (message: Record<string, unknown>) => void }).send = message => sent.push(message);
    (agent as unknown as { emitAutomationEvent: () => Promise<void> }).emitAutomationEvent = async () => {};
    (agent as unknown as { setCurrentTurnUserMessage: (message: string) => void }).setCurrentTurnUserMessage('Poursuis');
    agent.setPermissionMode('allow-all');

    await (agent as unknown as {
      handlePreToolUseRequest: (request: Record<string, unknown>) => Promise<void>;
    }).handlePreToolUseRequest({
      requestId: 'request-generic',
      toolName: 'Bash',
      input: { command: 'git push origin main' },
    });

    expect(sent.at(-1)?.action).toBe('block');
    expect(String(sent.at(-1)?.reason)).toContain('no permission handler');
    agent.destroy();
  });

  it('allows the exact action+target already authorized by the current request', async () => {
    const agent = new PiAgent(createConfig());
    const sent: Array<Record<string, unknown>> = [];
    (agent as unknown as { send: (message: Record<string, unknown>) => void }).send = message => sent.push(message);
    (agent as unknown as { emitAutomationEvent: () => Promise<void> }).emitAutomationEvent = async () => {};
    (agent as unknown as { setCurrentTurnUserMessage: (message: string) => void }).setCurrentTurnUserMessage('Push origin main');
    agent.setPermissionMode('allow-all');

    await (agent as unknown as {
      handlePreToolUseRequest: (request: Record<string, unknown>) => Promise<void>;
    }).handlePreToolUseRequest({
      requestId: 'request-explicit',
      toolName: 'Bash',
      input: { command: 'git push origin main' },
    });

    // RTK may rewrite the command in developer environments; both responses
    // execute the explicitly authorized action rather than blocking it.
    const responseAction = sent.at(-1)?.action;
    expect(responseAction === 'allow' || responseAction === 'modify').toBeTrue();
    agent.destroy();
  });

  it('also fails closed when the prompt appears after source activation', async () => {
    const agent = new PiAgent(createConfig());
    const sent: Array<Record<string, unknown>> = [];
    (agent as unknown as { send: (message: Record<string, unknown>) => void }).send = message => sent.push(message);
    (agent as unknown as { emitAutomationEvent: () => Promise<void> }).emitAutomationEvent = async () => {};
    (agent as unknown as { setCurrentTurnUserMessage: (message: string) => void }).setCurrentTurnUserMessage('Continue');
    agent.setPermissionMode('allow-all');
    agent.setAllSources([{ config: { slug: 'gmail' } }] as never);
    agent.onSourceActivationRequest = async sourceSlug => {
      agent.getSourceManager().updateActiveState([sourceSlug], [], [sourceSlug]);
      return true;
    };

    await (agent as unknown as {
      handlePreToolUseRequest: (request: Record<string, unknown>) => Promise<void>;
    }).handlePreToolUseRequest({
      requestId: 'request-after-source-activation',
      toolName: 'mcp__gmail__send_email',
      input: { to: 'alice@example.com', subject: 'Hello' },
    });

    expect(sent.at(-1)?.action).toBe('block');
    expect(String(sent.at(-1)?.reason)).toContain('no permission handler');
    agent.destroy();
  });
});
