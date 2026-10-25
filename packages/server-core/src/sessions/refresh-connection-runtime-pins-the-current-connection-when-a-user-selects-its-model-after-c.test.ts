import { withSessionOperationsForTest } from "./testing/session-operation-access.ts";
import { sessionRuntimeStateForTest } from "./testing/runtime-state-access.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { specializedProfileCapabilityEnvelopeIdentity } from "@craft-agent/shared/specialized-profiles";
import type { MissionCapabilityLock } from "@craft-agent/shared/sessions";
import { type AgentStub, createAgentStub, originalCraftConfigDir } from "./testing/refresh-connection-runtime-fixture.ts";

let resolveBackendContext: typeof import('@craft-agent/shared/agent/backend')['resolveBackendContext']
let loadWorkspaceConfig: typeof import('@craft-agent/shared/workspaces')['loadWorkspaceConfig']
let SessionManager: typeof import('./SessionManager.ts')['SessionManager']
let createManagedSession: typeof import('./SessionManager.ts')['createManagedSession']
let buildRestartRequiredSignature: typeof import('./runtime-config.ts')['buildRestartRequiredSignature']
let createStoredSession: typeof import('@craft-agent/shared/sessions')['createSession']
let tmpConfigRoot: string
let restoreConfig: (() => void) | undefined
// Regression coverage for the stale-Pi-subprocess bug where toggling
// `supportsImages` on a custom-endpoint model wrote to disk but never reached
// the live agent.
//
// Two failure modes are guarded here:
//   1. `getOrCreateAgent` deferred refresh whenever `managed.isProcessing` was
//      true, but `sendMessage` flips that flag *before* calling
//      `getOrCreateAgent` — which made the refresh branch dead code on the
//      send path. The new gate uses only `agent.isProcessing()`.
//   2. Saving a connection had no notification path to active sessions, so
//      capability changes only propagated lazily after the next send.
//      `refreshConnectionRuntime` now pushes updates from the SAVE handler.

function writeTestConfig(): void {
  mkdirSync(tmpConfigRoot, { recursive: true })
  writeFileSync(join(tmpConfigRoot, 'config.json'), JSON.stringify({
    workspaces: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    defaultLlmConnection: 'slug-A',
    llmConnections: [
      {
        slug: 'slug-A',
        name: 'Test Compat A',
        providerType: 'pi_compat',
        baseUrl: 'http://localhost:11434/v1',
        authType: 'none',
        defaultModel: 'test-text',
        models: [
          { id: 'test-text', supportsImages: false },
          { id: 'test-vision', supportsImages: true },
        ],
        customEndpoint: { api: 'openai-completions' },
        createdAt: 1,
      },
      {
        slug: 'slug-B',
        name: 'Test Compat B',
        providerType: 'pi_compat',
        baseUrl: 'http://localhost:11435/v1',
        authType: 'none',
        defaultModel: 'test-b',
        models: ['test-b'],
        customEndpoint: { api: 'openai-completions' },
        createdAt: 2,
      },
    ],
  }, null, 2))
}
function injectSession(
  sm: InstanceType<typeof SessionManager>,
  id: string,
  workspaceRoot: string,
  llmConnection: string,
  agent: AgentStub | null,
  opts: { backendRuntimeSignature?: string; backendRestartSignature?: string; isProcessing?: boolean } = {},
) {
  const workspace = {
    id: 'ws_test',
    name: 'Test Workspace',
    slug: 'ws-test',
    rootPath: workspaceRoot,
    createdAt: Date.now(),
  }
  const managed = createManagedSession(
    { id, name: id, llmConnection },
    workspace,
    { messagesLoaded: true },
  )
  managed.agent = agent
  // Force a stale runtime signature so the helper's comparison always reaches
  // the refresh branch — the signature it computes from real disk config will
  // never equal this sentinel.
  managed.backendRuntimeSignature = opts.backendRuntimeSignature ?? '__stale_runtime_signature_for_test__'
  // Pre-compute the restart signature against the same resolution the helper
  // will use, so by default tests route through the in-place refresh path.
  // Tests that want the restart-required path pass an explicit sentinel.
  if (opts.backendRestartSignature !== undefined) {
    managed.backendRestartSignature = opts.backendRestartSignature
  } else {
    const workspaceConfig = loadWorkspaceConfig(workspaceRoot)
    const ctx = resolveBackendContext({
      sessionConnectionSlug: llmConnection,
      workspaceDefaultConnectionSlug: workspaceConfig?.defaults?.defaultLlmConnection,
    })
    managed.backendRestartSignature = buildRestartRequiredSignature({
      connection: ctx.connection,
      provider: ctx.provider,
      authType: ctx.authType,
      resolvedModel: ctx.resolvedModel,
    })
  }
  managed.isProcessing = opts.isProcessing ?? false
  managed.llmConnection = llmConnection
  ;sessionRuntimeStateForTest(sm).sessions.set(id, managed)
  return managed
}

beforeAll(async () => {
  tmpConfigRoot = mkdtempSync(join(tmpdir(), 'sm-refresh-config-'))
  process.env.CRAFT_CONFIG_DIR = tmpConfigRoot
  writeTestConfig()

  // An earlier test may have frozen CONFIG_DIR before this fixture existed.
  // Keep real backend resolution while loading only this test's temporary file.
  const storage = await import('@craft-agent/shared/config/storage')
  const configLoader = spyOn(storage, 'loadStoredConfig').mockImplementation(() =>
    JSON.parse(readFileSync(join(tmpConfigRoot, 'config.json'), 'utf8')),
  )
  restoreConfig = () => configLoader.mockRestore()

  ;({ resolveBackendContext } = await import('@craft-agent/shared/agent/backend'))
  ;({ loadWorkspaceConfig } = await import('@craft-agent/shared/workspaces'))
  ;({ SessionManager, createManagedSession } = await import('./SessionManager.ts'))
  ;({ buildRestartRequiredSignature } = await import('./runtime-config.ts'))
  ;({ createSession: createStoredSession } = await import('@craft-agent/shared/sessions'))
})
afterAll(() => {
  restoreConfig?.()
  if (tmpConfigRoot) {
    rmSync(tmpConfigRoot, { recursive: true, force: true })
  }
  if (originalCraftConfigDir === undefined) {
    delete process.env.CRAFT_CONFIG_DIR
  } else {
    process.env.CRAFT_CONFIG_DIR = originalCraftConfigDir
  }
})

describe('refreshConnectionRuntime', () => {
  let tmpRoot: string

  let sm: InstanceType<typeof SessionManager>

  beforeEach(() => {
    writeTestConfig()
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-refresh-'))
    sm = withSessionOperationsForTest(new SessionManager())
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('pins the current connection when a user selects its model after connection lock', async () => {
    const stored = await createStoredSession(tmpRoot, {
      model: 'test-text', llmConnection: 'slug-A', connectionRoutePinned: false,
    })
    const managed = injectSession(sm, stored.id, tmpRoot, 'slug-A', null) as ReturnType<typeof injectSession> & {
      connectionLocked?: boolean
      connectionRoutePinned?: boolean
    }
    managed.connectionLocked = true
    managed.connectionRoutePinned = false

    await sm.updateSessionModel(stored.id, 'ws_test', 'test-vision', 'slug-A')

    expect(managed.connectionRoutePinned).toBe(true)
    expect((await import('@craft-agent/shared/sessions')).loadSession(tmpRoot, stored.id))
      .toMatchObject({ connectionRoutePinned: true, modelRoutePinned: true })
  })

  it('keeps the selected runtime model and reasoning for complex turns beyond the cost budget', async () => {
    writeFileSync(join(tmpRoot, 'config.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'ws_test',
      name: 'Test Workspace',
      slug: 'test-workspace',
      createdAt: 1,
      updatedAt: 1,
      automaticRoutingEnabled: true,
    }))
    const agent = Object.assign(createAgentStub(), { setExternalActionPolicy: jest.fn() })
    const managed = injectSession(sm, 'selected-turn', tmpRoot, 'slug-A', agent) as ReturnType<typeof injectSession> & {
      model?: string
      modelRoutePinned?: boolean
      thinkingLevel?: string
      thinkingLevelPinned?: boolean
      tokenUsage?: { costUsd: number }
      pendingRoutingMeta?: { costControl?: { budgetState?: string; thinkingLevel?: string } }
    }
    managed.model = 'test-vision'
    managed.modelRoutePinned = true
    managed.thinkingLevel = 'high'
    managed.thinkingLevelPinned = true
    managed.tokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 100_000 }
    const internal = sm as unknown as {
      tryRefreshAgentRuntime: (session: unknown, reason: string) => Promise<void>
      getOrCreateAgent: (session: unknown, turn: { message: string }) => Promise<unknown>
    }
    internal.tryRefreshAgentRuntime = jest.fn().mockResolvedValue(undefined)

    const result = await internal.getOrCreateAgent(managed, {
      message: 'Audit the architecture, implement a migration, verify the result, and review every security requirement.',
    })

    expect(result).toBe(agent)
    expect(managed.llmConnection).toBe('slug-A')
    expect(managed.model).toBe('test-vision')
    expect(managed.thinkingLevel).toBe('high')
    expect(agent.setModel).not.toHaveBeenCalled()
    expect(managed.pendingRoutingMeta?.costControl).toMatchObject({ budgetState: 'hard-limit', thinkingLevel: 'high' })
  })

  it('refuses an auth-none specialized route before cost control or provider dispatch', async () => {
    writeFileSync(join(tmpRoot, 'config.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'ws_test',
      name: 'Test Workspace',
      slug: 'test-workspace',
      createdAt: 1,
      updatedAt: 1,
      automaticRoutingEnabled: true,
    }))
    const agent = Object.assign(createAgentStub(), { setExternalActionPolicy: jest.fn() })
    const managed = injectSession(sm, 'specialized-cost', tmpRoot, 'slug-A', agent) as ReturnType<typeof injectSession> & {
      model?: string
      modelRoutePinned?: boolean
      connectionRoutePinned?: boolean
      thinkingLevel?: string
      thinkingLevelPinned?: boolean
      missionRouteLockSha256?: string
      missionCapabilityLock?: MissionCapabilityLock
      tokenUsage?: { costUsd: number }
      pendingRoutingMeta?: { costControl?: unknown }
    }
    managed.model = 'test-vision'
    managed.modelRoutePinned = true
    managed.connectionRoutePinned = true
    managed.thinkingLevel = 'high'
    managed.thinkingLevelPinned = true
    managed.tokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 100_000 }
    managed.missionRouteLockSha256 = 'a'.repeat(64)
    managed.missionCapabilityLock = {
      schemaVersion: 1,
      capabilityEnvelopeSha256: specializedProfileCapabilityEnvelopeIdentity([]),
      capabilities: [],
    }
    const internal = sm as unknown as {
      tryRefreshAgentRuntime: (session: unknown, reason: string) => Promise<void>
      getOrCreateAgent: (session: unknown, turn: { message: string }) => Promise<unknown>
    }
    internal.tryRefreshAgentRuntime = jest.fn().mockResolvedValue(undefined)

    await expect(internal.getOrCreateAgent(managed, { message: 'Retry.' }))
      .rejects.toThrow('host-attestable credential generation')
    expect(agent.setModel).not.toHaveBeenCalled()
  })
});
