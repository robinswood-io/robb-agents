import { afterAll, beforeAll, expect, it, spyOn } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SummarizeCallback } from '@craft-agent/shared/sources'
import type { CollectionCacheScope } from '@craft-agent/shared/mcp'

let SessionManager: typeof import('./SessionManager.ts')['SessionManager']
let createManagedSession: typeof import('./SessionManager.ts')['createManagedSession']
let createApiTool: typeof import('@craft-agent/shared/sources/api-tools')['createApiTool']
let root: string
let restoreConfig: (() => void) | undefined
const originalConfigDir = process.env.CRAFT_CONFIG_DIR

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'collection-runtime-'))
  process.env.CRAFT_CONFIG_DIR = root
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    workspaces: [], activeWorkspaceId: null, activeSessionId: null, defaultLlmConnection: 'test-route',
    llmConnections: [{ slug: 'test-route', name: 'Isolated test', providerType: 'pi_compat', authType: 'none', baseUrl: 'http://localhost:11434/v1', defaultModel: 'test-model', models: ['test-model'], customEndpoint: { api: 'openai-completions' }, createdAt: 1 }],
  }))
  // CONFIG_DIR is fixed at import time and may belong to an earlier test file.
  // Replace only disk loading, retaining real connection and capability resolution.
  const storage = await import('@craft-agent/shared/config/storage')
  const configLoader = spyOn(storage, 'loadStoredConfig').mockImplementation(() =>
    JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')),
  )
  restoreConfig = () => configLoader.mockRestore()
  ;({ SessionManager, createManagedSession } = await import('./SessionManager.ts'))
  ;({ createApiTool } = await import('@craft-agent/shared/sources/api-tools'))
})

afterAll(() => {
  restoreConfig?.()
  if (originalConfigDir === undefined) delete process.env.CRAFT_CONFIG_DIR
  else process.env.CRAFT_CONFIG_DIR = originalConfigDir
  rmSync(root, { recursive: true, force: true })
})

type Managed = ReturnType<typeof createManagedSession>
type CacheHost = {
  sessions: Map<string, Managed>
  getCollectionCacheScope: (managed: Managed) => CollectionCacheScope | undefined
  getCollectionSummarizer: (managed: Managed) => SummarizeCallback
}

function sessions() {
  const workspace = { id: 'ws-test', slug: 'ws-test', name: 'Test', rootPath: join(root, 'workspace'), createdAt: 1 }
  mkdirSync(workspace.rootPath, { recursive: true })
  const manager = new SessionManager() as unknown as CacheHost
  const parent = createManagedSession({ id: 'parent', name: 'Parent', llmConnection: 'test-route', permissionMode: 'safe' }, workspace, { messagesLoaded: true })
  parent.activeObjective = {
    schemaVersion: 1, objectiveId: 'objective-1', userMessageId: 'message-1', startedAt: 1,
    budgetBaselineUsd: 0, tokenBaseline: 0, continuationCount: 0, orchestrationMode: 'direct', risk: 'standard',
    completionCriteria: ['requested-outcome-delivered'], terminalState: 'active', originalText: 'Extract the records',
  }
  const child = createManagedSession({ id: 'child', name: 'Child', parentSessionId: 'parent', llmConnection: 'test-route', permissionMode: 'safe' }, workspace, { messagesLoaded: true })
  child.activeObjective = { ...parent.activeObjective, objectiveId: 'child-objective' }
  manager.sessions.set(parent.id, parent)
  manager.sessions.set(child.id, child)
  return { manager, parent, child, workspace }
}

it('host scope isolates task family/objective, policy, project and reviewers', () => {
  const { manager, parent, child, workspace } = sessions()
  const initial = manager.getCollectionCacheScope(parent)
  expect(initial).toBeDefined()
  expect(manager.getCollectionCacheScope(child)).toEqual(initial)
  child.projectId = 'other-project'
  expect(manager.getCollectionCacheScope(child)?.audience).not.toBe(initial!.audience)
  child.projectId = undefined
  child.permissionMode = 'allow-all'
  expect(manager.getCollectionCacheScope(child)?.permissionRevision).not.toBe(initial!.permissionRevision)
  child.permissionMode = 'safe'
  writeFileSync(join(workspace.rootPath, 'permissions.json'), '{"version":1,"allowedMcpPatterns":["new-read"]}')
  expect(manager.getCollectionCacheScope(child)?.permissionRevision).not.toBe(initial!.permissionRevision)
  child.missionRole = 'reviewer'
  expect(manager.getCollectionCacheScope(child)?.freshEvidence).toBe(true)
  child.missionRole = 'worker'
  child.activeObjective!.originalText = 'Revue indépendante en lecture seule. Ne rien modifier.'
  expect(manager.getCollectionCacheScope(child)?.freshEvidence).toBe(true)
  child.activeObjective!.originalText = `Tu es reviewer indépendant. Vérifie indépendamment en lecture seule. Cible /srv/review. Retourne uniquement ${JSON.stringify({ verdict: 'PASS|FAIL', criteria: [{ id: 'requested-outcome-delivered', passed: false }], findings: [], objectiveId: 'parent-objective', acceptanceSha256: 'a'.repeat(64) })}`
  expect(manager.getCollectionCacheScope(child)?.freshEvidence).toBe(true)
  parent.activeObjective!.objectiveId = 'new-objective'
  expect(manager.getCollectionCacheScope(parent)?.audience).not.toBe(initial!.audience)
  child.parentSessionId = 'missing-parent'
  expect(manager.getCollectionCacheScope(child)).toBeUndefined()
})

it('actual API handler and deferred host callback share current collections, refresh auth, invalidate writes and preserve independent review', async () => {
  const { manager, parent, child } = sessions()
  const previousFetch = globalThis.fetch
  let token = 'test-token-A'
  let fetchCalls = 0
  let synthesisCalls = 0
  let status = 200
  let content = 'Current observed collection data with complete records. '.repeat(700)
  const callback = manager.getCollectionSummarizer(parent) // Backend deliberately absent at construction.
  const makeTool = (session: Managed, summarize: SummarizeCallback) => createApiTool(
    { name: 'collection', baseUrl: 'https://example.test', auth: { type: 'bearer' } },
    async () => token, join(root, session.id), summarize,
  ) as unknown as { handler: (args: { path: string; method: string }) => Promise<{ isError?: boolean }> }
  const parentTool = makeTool(parent, callback)
  const childTool = makeTool(child, manager.getCollectionSummarizer(child))
  const stub = { getSummarizeCallback: () => async () => { synthesisCalls++; return 'Verified source summary'; } }
  globalThis.fetch = Object.assign(async () => { fetchCalls++; return new Response(content, { status }); }, { preconnect: previousFetch.preconnect }) as typeof fetch
  try {
    await parentTool.handler({ path: '/records', method: 'GET' })
    expect(synthesisCalls).toBe(0)
    parent.agent = stub as never
    child.agent = stub as never
    await parentTool.handler({ path: '/records', method: 'GET' })
    await childTool.handler({ path: '/records', method: 'GET' })
    expect(fetchCalls).toBe(3)
    expect(synthesisCalls).toBe(1)
    token = 'test-token-B'
    await childTool.handler({ path: '/records', method: 'GET' })
    expect(synthesisCalls).toBe(2)
    content += ' Material source change.'
    await childTool.handler({ path: '/records', method: 'GET' })
    expect(synthesisCalls).toBe(3)
    await parentTool.handler({ path: '/records', method: 'POST' })
    await childTool.handler({ path: '/records', method: 'GET' })
    expect(synthesisCalls).toBe(5)
    child.activeObjective!.originalText = `Tu es reviewer indépendant. Vérifie indépendamment en lecture seule. Cible /srv/review. Retourne uniquement ${JSON.stringify({ verdict: 'PASS|FAIL', criteria: [{ id: 'requested-outcome-delivered', passed: false }], findings: [], objectiveId: 'parent-objective', acceptanceSha256: 'a'.repeat(64) })}`
    await childTool.handler({ path: '/records', method: 'GET' })
    expect(synthesisCalls).toBe(6)
    status = 401
    expect((await parentTool.handler({ path: '/records', method: 'GET' })).isError).toBe(true)
    expect(synthesisCalls).toBe(6)
    status = 200
    parent.activeObjective!.objectiveId = 'new-task'
    parent.agent = { getSummarizeCallback: () => async () => { synthesisCalls++; return 'Refreshed backend summary'; } } as never
    await parentTool.handler({ path: '/records', method: 'GET' })
    expect(synthesisCalls).toBe(7)
    expect(fetchCalls).toBe(10)
  } finally { globalThis.fetch = previousFetch }
})
