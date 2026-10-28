import type { AgentBackend } from '@craft-agent/shared/agent';
import { ScriptedSessionAgent } from "./scripted-session-agent.ts";
import { jest } from "bun:test";


export const originalCraftConfigDir = process.env["CRAFT_CONFIG_DIR"]


  export type AgentStub = ScriptedSessionAgent & {
    isProcessing: () => boolean
    updateRuntimeConfig: jest.Mock<NonNullable<AgentBackend['updateRuntimeConfig']>>
    setModel: jest.Mock<ScriptedSessionAgent['setModel']>
    dispose: jest.Mock<ScriptedSessionAgent['dispose']>
    disposeForRestart?: () => Promise<void>
  }


export function createAgentStub(opts: {
  isProcessing?: boolean
  refreshSucceeds?: boolean
  refreshDelayMs?: number
} = {}): AgentStub {
  const delay = opts.refreshDelayMs ?? 0
  const result = opts.refreshSucceeds ?? true
  return Object.assign(new ScriptedSessionAgent({ id: 'refresh-fixture', slug: 'refresh-fixture', name: 'Fixture', rootPath: '/tmp/refresh-fixture', createdAt: 1 }), {
    isProcessing: () => opts.isProcessing ?? false,
    updateRuntimeConfig: jest.fn<NonNullable<AgentBackend['updateRuntimeConfig']>>().mockImplementation(async () => {
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
      return result
      }),
    setModel: jest.fn<ScriptedSessionAgent['setModel']>(),
    dispose: jest.fn<ScriptedSessionAgent['dispose']>(),
  })
}
