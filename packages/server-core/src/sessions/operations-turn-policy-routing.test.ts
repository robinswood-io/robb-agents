import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearRobbOperationsExtension,
  registerRobbOperationsExtension,
  type OperationsTurnInput,
} from '@craft-agent/shared/operations';
import * as sharedConfig from '@craft-agent/shared/config';
import type { LlmConnection } from '@craft-agent/shared/config';
import {
  applyOperationsTurnPolicy,
  type OperationsTurnPolicyOwner,
  type OperationsTurnPolicySession,
} from './SessionManager/operations/apply-operations-turn-policy.ts';

const tempDirs: string[] = [];
const activeSpies: Array<{ mockRestore(): void }> = [];

afterEach(async () => {
  for (const spy of activeSpies.splice(0)) {
    spy.mockRestore();
  }
  await clearRobbOperationsExtension();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('applyOperationsTurnPolicy model ordering and pinned/manual routing guards', () => {
  it('orders candidate models descending by capability tier and respects automaticRoutingEnabled=false or modelRoutePinned', async () => {
    const wsRoot = mkdtempSync(join(tmpdir(), 'robb-ops-routing-'));
    tempDirs.push(wsRoot);
    writeFileSync(join(wsRoot, 'config.json'), JSON.stringify({
      id: 'ws-routing',
      name: 'Routing Test',
      costControl: { automaticRoutingEnabled: false },
    }));

    const testSlug = `claude-max-test-${Date.now()}`;
    const conn: LlmConnection = {
      slug: testSlug,
      name: 'Claude Max Test',
      providerType: 'anthropic',
      authType: 'oauth',
      defaultModel: 'claude-opus-5',
      models: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5'],
      createdAt: Date.now(),
    };
    activeSpies.push(spyOn(sharedConfig, 'getLlmConnections').mockReturnValue([conn]));
    activeSpies.push(spyOn(sharedConfig, 'getDefaultLlmConnection').mockReturnValue(testSlug));

    let seenModels: readonly string[] | undefined;
    registerRobbOperationsExtension({
      apiVersion: 1,
      id: 'ops-routing-test',
      edition: 'commercial',
      connectionPolicy: 'pinned-account',
      beforeTurn: (input: OperationsTurnInput) => {
        seenModels = input.connections[0]?.models;
        return {
          decision: 'allow',
          connectionSlug: testSlug,
          model: seenModels?.[0] ?? 'claude-haiku-5-5',
        };
      },
      beforeTool: () => ({ decision: 'allow' }),
      onRuntimeEvent: () => undefined,
    });

    const updatedModels: Array<string | null> = [];
    const owner: OperationsTurnPolicyOwner = {
      setSessionConnection: async () => undefined,
      updateSessionModel: async (_sid, _wid, model) => {
        updatedModels.push(model);
      },
      setSessionThinkingLevel: () => undefined,
    };

    const managed: OperationsTurnPolicySession = {
      id: 'sess-routing-1',
      workspace: { id: 'ws-routing', slug: 'ws-routing', name: 'Routing Test', rootPath: wsRoot, createdAt: 1 },
      llmConnection: testSlug,
      model: 'claude-opus-5',
      thinkingLevel: undefined,
      missionId: undefined,
      missionWorkItemId: undefined,
      missionRole: undefined,
      tokenUsage: undefined,
      missionRouteLockSha256: undefined,
      connectionRoutePinned: false,
      modelRoutePinned: false,
      thinkingLevelPinned: false,
      isProcessing: false,
      messages: [],
      enabledSourceSlugs: ['orion-mcp', 'rbw-servers'],
    };

    await applyOperationsTurnPolicy({ owner }, managed, 'Refactor the architecture');
    expect(seenModels?.[0]).toBe('claude-opus-5');
    expect(seenModels).toEqual(['claude-opus-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
    expect(updatedModels).toEqual([]);

    writeFileSync(join(wsRoot, 'config.json'), JSON.stringify({
      id: 'ws-routing',
      name: 'Routing Test',
      costControl: { automaticRoutingEnabled: true },
    }));
    managed.modelRoutePinned = true;
    managed.model = 'claude-sonnet-5-5';
    await applyOperationsTurnPolicy({ owner }, managed, 'Refactor the architecture');
    expect(updatedModels).toEqual([]);

    managed.modelRoutePinned = false;
    await applyOperationsTurnPolicy({ owner }, managed, 'Refactor the architecture');
    expect(updatedModels).toEqual(['claude-opus-5']);
  });
});
