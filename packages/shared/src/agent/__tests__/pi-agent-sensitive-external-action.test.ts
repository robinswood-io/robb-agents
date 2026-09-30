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
    (agent as any).subprocessRuntimeContext = {
      runtimeId: 'pi-sensitive-explicit-runtime',
      sessionId: (agent as any).config.session.id,
    };
    agent.setPermissionMode('allow-all');

    await (agent as unknown as {
      handlePreToolUseRequest: (request: Record<string, unknown>) => Promise<void>;
    }).handlePreToolUseRequest({
      requestId: 'request-explicit',
      toolName: 'Bash',
      toolCallId: 'tool-explicit',
      input: { command: 'git push origin main' },
    });

    // RTK may rewrite the command in developer environments; both responses
    // execute the explicitly authorized action rather than blocking it.
    const responseAction = sent.at(-1)?.action;
    expect(responseAction === 'allow' || responseAction === 'modify').toBeTrue();
    agent.destroy();
  });

  it('also fails closed when the prompt appears after source activation', async () => {
    const config = createConfig();
    config.externalActionPolicy = 'allow-in-execute';
    config.getObjectiveMutationAuthority = () => false;
    const agent = new PiAgent(config);
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
    expect(String(sent.at(-1)?.reason)).toContain('current accepted user objective is observational');
    agent.destroy();
  });

  it('uses authenticated root segments instead of an explicit spawned prompt', async () => {
    const config = createConfig();
    config.externalActionPolicy = 'allow-in-execute';
    config.getObjectiveMutationAuthority = () => ({
      authorized: true,
      sensitiveActionAuthorized: true,
      authorizationSegments: ['Corrige le fichier local /tmp/report.md.'],
    });
    const agent = new PiAgent(config);
    const sent: Array<Record<string, unknown>> = [];
    (agent as unknown as { send: (message: Record<string, unknown>) => void }).send = message => sent.push(message);
    (agent as unknown as { emitAutomationEvent: () => Promise<void> }).emitAutomationEvent = async () => {};
    (agent as unknown as { setCurrentTurnUserMessage: (message: string) => void })
      .setCurrentTurnUserMessage('Push origin main');
    agent.setPermissionMode('allow-all');

    await (agent as unknown as {
      handlePreToolUseRequest: (request: Record<string, unknown>) => Promise<void>;
    }).handlePreToolUseRequest({
      requestId: 'request-spawned-escalation',
      toolName: 'Bash',
      input: { command: 'git push origin main' },
    });

    expect(sent.at(-1)?.action).toBe('block');
    expect(String(sent.at(-1)?.reason)).toContain('current accepted human objective');
    agent.destroy();
  });

  it('does not infer a private recipient capability from a bare historical alias', async () => {
    const config = createConfig();
    config.externalActionPolicy = 'allow-in-execute';
    config.getObjectiveMutationAuthority = () => ({
      authorized: true,
      sensitiveActionAuthorized: true,
      authorizationSegments: ["Envoi l'e-mail à benoît"],
    });
    const agent = new PiAgent(config);
    const sent: Array<Record<string, unknown>> = [];
    let permissionRequest: Record<string, unknown> | undefined;
    (agent as unknown as { send: (message: Record<string, unknown>) => void }).send = message => sent.push(message);
    (agent as unknown as { emitAutomationEvent: () => Promise<void> }).emitAutomationEvent = async () => {};
    (agent as unknown as { setCurrentTurnUserMessage: (message: string) => void })
      .setCurrentTurnUserMessage("Envoi l'e-mail à benoît");
    agent.setPermissionMode('allow-all');
    agent.setAllSources([{ config: { slug: 'google-contacts' } }] as never);
    agent.getSourceManager().updateActiveState(
      ['google-contacts'],
      [],
      ['google-contacts'],
    );
    agent.onPermissionRequest = request => {
      permissionRequest = request;
      queueMicrotask(() => agent.respondToPermission(request.requestId, false));
    };

    await (agent as unknown as {
      handlePreToolUseRequest: (request: Record<string, unknown>) => Promise<void>;
    }).handlePreToolUseRequest({
      requestId: 'request-live-silae',
      toolName: 'mcp__google-contacts__gmail_send',
      toolCallId: 'gmail-call-exact',
      input: {
        to: 'benoit@example.test',
        sendAsEmail: 'sender@example.test',
        subject: 'Silaé — accès API de production',
        body: 'Message prévalidé',
        _displayName: 'Envoyer email Benoît',
        _intent: 'Informer Benoît de l’accès Silaé actuel.',
      },
    });

    expect(permissionRequest).toBeUndefined();
    expect(sent.at(-1)).toMatchObject({
      requestId: 'request-live-silae',
      action: 'block',
      reason: expect.stringContaining('Objective authority:'),
    });
    agent.destroy();
  });
});
