import type { BackendConfig } from '../../backend/types.ts';

export function createPiAgentTestConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test', name: 'Test Workspace', slug: 'test-workspace',
      rootPath: '/tmp/craft-agent-test', createdAt: 1,
    },
    session: {
      id: 'session-test', workspaceRootPath: '/tmp/craft-agent-test',
      createdAt: Date.now(), lastUsedAt: Date.now(),
    },
    isHeadless: true,
    ...overrides,
  };
}
