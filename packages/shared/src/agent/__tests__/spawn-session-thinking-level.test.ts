/** Verifies that model-authored delegation cannot select routing fields. */
import { describe, it, expect, beforeEach } from 'bun:test';
import type { SpawnSessionRequest, SpawnSessionResult } from '../base-agent.ts';
import { TestAgent, createMockBackendConfig } from './test-utils.ts';

class SpawnTestAgent extends TestAgent {
  public invokeSpawn(input: Record<string, unknown>) {
    return this.preExecuteSpawnSession(input);
  }
}

function setup() {
  const agent = new SpawnTestAgent(createMockBackendConfig());
  const captured: SpawnSessionRequest[] = [];
  agent.onSpawnSession = async (request) => {
    captured.push(request);
    const result: SpawnSessionResult = {
      sessionId: 'spawned-id',
      name: 'spawned',
      status: 'started',
    };
    return result;
  };
  return { agent, captured };
}

describe('spawn_session route authority', () => {
  let agent: SpawnTestAgent;
  let captured: SpawnSessionRequest[];

  beforeEach(() => {
    ({ agent, captured } = setup());
  });

  it('leaves every route field host-owned when omitted', async () => {
    await agent.invokeSpawn({ prompt: 'hi' });
    expect(captured).toHaveLength(1);
    expect(captured[0]).not.toHaveProperty('thinkingLevel');
    expect(captured[0]).not.toHaveProperty('model');
    expect(captured[0]).not.toHaveProperty('llmConnection');
  });

  it('preserves non-routing delegation fields', async () => {
    await agent.invokeSpawn({
      prompt: 'hi',
      permissionMode: 'ask',
      labels: ['test'],
    });
    expect(captured[0]?.permissionMode).toBe('ask');
    expect(captured[0]?.labels).toEqual(['test']);
  });

  it.each([
    { model: 'pi/gpt-5.6-luna' },
    { llmConnection: 'another-provider' },
    { thinkingLevel: 'off' },
  ])('rejects model-authored route field %j before the host callback', async (route) => {
    await expect(agent.invokeSpawn({ prompt: 'hi', ...route }))
      .rejects.toThrow('Invalid spawn_session arguments');
    expect(captured).toHaveLength(0);
  });

  it('never reaches the host callback for an invalid permission or malformed attachment', async () => {
    for (const input of [
      { permissionMode: 'read-only' }, { permissionMode: 'execute' }, { permissionMode: 'Explore' },
      { permission_mode: 'safe' }, { attachments: ['/tmp/evidence'] },
    ]) {
      await expect(agent.invokeSpawn({ prompt: 'Independent review', ...input })).rejects.toThrow('Invalid spawn_session arguments');
    }
    expect(captured).toHaveLength(0);
  });

  it('preserves the project and reviewer role without manufacturing permissions', async () => {
    await agent.invokeSpawn({ prompt: 'Inspect the exact target', projectId: 'project-1', role: 'reviewer' });
    expect(captured[0]).toMatchObject({ projectId: 'project-1', role: 'reviewer' });
    expect(captured[0]?.permissionMode).toBeUndefined();
  });
});
