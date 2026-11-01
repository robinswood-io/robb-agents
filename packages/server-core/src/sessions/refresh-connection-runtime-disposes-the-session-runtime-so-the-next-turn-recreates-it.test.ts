import { StoredConfigSchema } from '../../../shared/src/config/validators.ts';
import { withSessionOperationsForTest } from "./testing/session-operation-access.ts";
import { sessionRuntimeStateForTest } from "./testing/runtime-state-access.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { type AgentStub, createAgentStub, originalCraftConfigDir } from "./testing/refresh-connection-runtime-fixture.ts";

let resolveBackendContext: typeof import('@craft-agent/shared/agent/backend')['resolveBackendContext']
let loadWorkspaceConfig: typeof import('@craft-agent/shared/workspaces')['loadWorkspaceConfig']
let SessionManager: typeof import('./SessionManager.ts')['SessionManager']
let createManagedSession: typeof import('./SessionManager.ts')['createManagedSession']
let buildRestartRequiredSignature: typeof import('./runtime-config.ts')['buildRestartRequiredSignature']
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
    schemaVersion: 1,
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
  process.env["CRAFT_CONFIG_DIR"] = tmpConfigRoot
  writeTestConfig()

  // An earlier test may have frozen CONFIG_DIR before this fixture existed.
  // Keep real backend resolution while loading only this test's temporary file.
  const storage = await import('@craft-agent/shared/config/storage')
  const configLoader = spyOn(storage, 'loadStoredConfig').mockImplementation(() =>
    StoredConfigSchema.parse(JSON.parse(readFileSync(join(tmpConfigRoot, 'config.json'), 'utf8'))) as NonNullable<ReturnType<typeof storage.loadStoredConfig>>,
  )
  restoreConfig = () => configLoader.mockRestore()

  ;({ resolveBackendContext } = await import('@craft-agent/shared/agent/backend'))
  ;({ loadWorkspaceConfig } = await import('@craft-agent/shared/workspaces'))
  ;({ SessionManager, createManagedSession } = await import('./SessionManager.ts'))
  ;({ buildRestartRequiredSignature } = await import('./runtime-config.ts'))
  await import('@craft-agent/shared/sessions')
})
afterAll(() => {
  restoreConfig?.()
  if (tmpConfigRoot) {
    rmSync(tmpConfigRoot, { recursive: true, force: true })
  }
  if (originalCraftConfigDir === undefined) {
    delete process.env["CRAFT_CONFIG_DIR"]
  } else {
    process.env["CRAFT_CONFIG_DIR"] = originalCraftConfigDir
  }
})

describe('restartAgentRuntime', () => {
  let tmpRoot: string

  let sm: InstanceType<typeof SessionManager>

  beforeEach(() => {
    writeTestConfig()
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-restart-'))
    sm = withSessionOperationsForTest(new SessionManager())
  })

  afterEach(async () => {
    await sm.flushAllSessions()
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('disposes the session runtime so the next turn recreates it', async () => {
    const agent = createAgentStub()
    const managed = injectSession(sm, 'restart-me', tmpRoot, 'slug-A', agent)

    await sm.restartAgentRuntime('restart-me')

    expect(agent.dispose).toHaveBeenCalledTimes(1)
    expect(managed.agent).toBeNull()
    expect(managed.backendRuntimeSignature).toBeUndefined()
    expect(managed.autonomyEvents?.at(-1)).toMatchObject({
      phase: 'fallback',
      message: 'Execution runtime bridge was reconnected; retry the failed turn to recreate the runtime.',
    })
  })

  it('refuses to dispose a runtime while the session is processing', async () => {
    const agent = createAgentStub({ isProcessing: true })
    const managed = injectSession(sm, 'busy-restart', tmpRoot, 'slug-A', agent, { isProcessing: false })

    await expect(sm.restartAgentRuntime('busy-restart')).rejects.toThrow('Cannot reconnect runtime while session is processing')

    expect(agent.dispose).not.toHaveBeenCalled()
    expect(managed.agent).toBe(agent)
  })
});
