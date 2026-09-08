import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import { getPiModelsForAuthProvider } from '../models-pi.ts'

const PI_ANTHROPIC_OPUS_DEFAULT = getPiModelsForAuthProvider('anthropic').some(m => m.id === 'pi/claude-opus-4-8')
  ? 'pi/claude-opus-4-8'
  : 'pi/claude-opus-4-7'




const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href
const PI_RESOLVER_SETUP_PATH = pathToFileURL(join(import.meta.dir, '..', '..', '..', 'tests', 'setup', 'register-pi-model-resolver.ts')).href

function setupWorkspaceConfigDir() {
  const configDir = mkdtempSync(join(tmpdir(), 'craft-agent-config-'))
  const workspaceRoot = join(configDir, 'workspaces', 'my-workspace')
  mkdirSync(workspaceRoot, { recursive: true })

  // Make workspace appear valid to loadStoredConfig() so migration can run.
  writeFileSync(
    join(workspaceRoot, 'config.json'),
    JSON.stringify(
      {
        id: 'ws-config-1',
        name: 'My Workspace',
        slug: 'my-workspace',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      null,
      2,
    ),
    'utf-8',
  )

  return { configDir, workspaceRoot, configPath: join(configDir, 'config.json') }
}

function writeRootConfig(configPath: string, workspaceRoot: string, llmConnections: any[]) {
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        workspaces: [
          {
            id: 'ws-1',
            name: 'My Workspace',
            rootPath: workspaceRoot,
            createdAt: Date.now(),
          },
        ],
        activeWorkspaceId: 'ws-1',
        activeSessionId: null,
        defaultLlmConnection: 'pi-api-key',
        llmConnections,
      },
      null,
      2,
    ),
    'utf-8',
  )
}

function runMigration(configDir: string) {
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import '${PI_RESOLVER_SETUP_PATH}'; import { migrateLegacyLlmConnectionsConfig, migrateOrphanedDefaultConnections } from '${STORAGE_MODULE_PATH}'; migrateLegacyLlmConnectionsConfig(); migrateOrphanedDefaultConnections();`,
  ], {
    env: {
      ...process.env,
      CRAFT_CONFIG_DIR: configDir,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (run.exitCode !== 0) {
    throw new Error(
      `migration subprocess failed (exit ${run.exitCode})\nstdout:\n${run.stdout.toString()}\nstderr:\n${run.stderr.toString()}`,
    )
  }
}

function readPiApiKeyConnection(configPath: string): any {
  const migrated = JSON.parse(readFileSync(configPath, 'utf-8'))
  return migrated.llmConnections.find((c: any) => c.slug === 'pi-api-key')
}

function getModelIds(connection: any): string[] {
  return (connection.models ?? []).map((m: any) => typeof m === 'string' ? m : m.id)
}

describe('startup migration (integration)', () => {
  it('repairs broken pi-api-key openai-codex provider on startup migration', () => {
    const { configDir, workspaceRoot, configPath } = setupWorkspaceConfigDir()

    writeRootConfig(configPath, workspaceRoot, [
      {
        slug: 'pi-api-key',
        name: 'Craft Agents Backend (OpenAI)',
        providerType: 'pi',
        authType: 'api_key',
        piAuthProvider: 'openai-codex',
        createdAt: Date.now(),
        models: [],
        defaultModel: '',
      },
    ])

    runMigration(configDir)

    const connection = readPiApiKeyConnection(configPath)
    expect(connection).toBeDefined()
    expect(connection.piAuthProvider).toBe('openai')
    expect(connection.authType).toBe('api_key')
  })

  it('preserves userDefined3Tier model subsets during startup migration', () => {
    const { configDir, workspaceRoot, configPath } = setupWorkspaceConfigDir()
    const userDefinedModels = ['pi/claude-opus-4-6', 'pi/claude-sonnet-4-6', 'pi/claude-haiku-4-5']
    const migratedModels = [...userDefinedModels]

    writeRootConfig(configPath, workspaceRoot, [
      {
        slug: 'pi-api-key',
        name: 'Craft Agents Backend (Anthropic)',
        providerType: 'pi',
        authType: 'api_key',
        piAuthProvider: 'anthropic',
        modelSelectionMode: 'userDefined3Tier',
        createdAt: Date.now(),
        models: userDefinedModels,
        defaultModel: userDefinedModels[0],
      },
    ])

    runMigration(configDir)

    const connection = readPiApiKeyConnection(configPath)
    expect(connection).toBeDefined()
    expect(connection.modelSelectionMode).toBe('userDefined3Tier')
    expect(connection.models).toEqual(migratedModels)
    expect(connection.defaultModel).toBe(migratedModels[0])
  })

  it('normalizes auto mode model set back to provider defaults', () => {
    const { configDir, workspaceRoot, configPath } = setupWorkspaceConfigDir()

    writeRootConfig(configPath, workspaceRoot, [
      {
        slug: 'pi-api-key',
        name: 'Craft Agents Backend (Anthropic)',
        providerType: 'pi',
        authType: 'api_key',
        piAuthProvider: 'anthropic',
        modelSelectionMode: 'automaticallySyncedFromProvider',
        createdAt: Date.now(),
        models: ['pi/claude-haiku-4-5'],
        defaultModel: 'pi/claude-haiku-4-5',
      },
    ])

    runMigration(configDir)

    const connection = readPiApiKeyConnection(configPath)
    expect(connection).toBeDefined()
    expect(connection.modelSelectionMode).toBe('automaticallySyncedFromProvider')
    const modelIds = getModelIds(connection)
    expect(modelIds.length).toBeGreaterThan(1)
    expect(modelIds).toContain(PI_ANTHROPIC_OPUS_DEFAULT)
    expect(modelIds).toContain(connection.defaultModel)
  })

  it('preserves unavailable explicit model IDs for runtime validation instead of replacing them', () => {
    const { configDir, workspaceRoot, configPath } = setupWorkspaceConfigDir()

    writeRootConfig(configPath, workspaceRoot, [
      {
        slug: 'pi-api-key',
        name: 'Craft Agents Backend (Anthropic)',
        providerType: 'pi',
        authType: 'api_key',
        piAuthProvider: 'anthropic',
        modelSelectionMode: 'userDefined3Tier',
        createdAt: Date.now(),
        models: ['pi/claude-opus-4-6', 'pi/not-real', 'pi/claude-haiku-4-5'],
        defaultModel: 'pi/not-real',
      },
    ])

    runMigration(configDir)

    const connection = readPiApiKeyConnection(configPath)
    expect(connection).toBeDefined()
    expect(connection.modelSelectionMode).toBe('userDefined3Tier')
    expect(connection.models).toEqual(['pi/claude-opus-4-6', 'pi/not-real', 'pi/claude-haiku-4-5'])
    expect(connection.defaultModel).toBe('pi/not-real')
  })

  it('does not replace a user-owned model list when its models are absent from the catalog', () => {
    const { configDir, workspaceRoot, configPath } = setupWorkspaceConfigDir()

    writeRootConfig(configPath, workspaceRoot, [
      {
        slug: 'pi-api-key',
        name: 'Craft Agents Backend (Anthropic)',
        providerType: 'pi',
        authType: 'api_key',
        piAuthProvider: 'anthropic',
        modelSelectionMode: 'userDefined3Tier',
        createdAt: Date.now(),
        models: ['pi/not-real-1', 'pi/not-real-2'],
        defaultModel: 'pi/not-real-1',
      },
    ])

    runMigration(configDir)

    const connection = readPiApiKeyConnection(configPath)
    expect(connection).toBeDefined()
    expect(connection.modelSelectionMode).toBe('userDefined3Tier')
    const modelIds = getModelIds(connection)
    expect(modelIds).toEqual(['pi/not-real-1', 'pi/not-real-2'])
    expect(connection.defaultModel).toBe('pi/not-real-1')
  })

  it('preserves legacy explicit model IDs without choosing a different model', () => {
    const { configDir, workspaceRoot, configPath } = setupWorkspaceConfigDir()

    // Use actual catalog IDs as fixtures and preserve their explicit legacy spelling.
    const openrouterIds = getPiModelsForAuthProvider('openrouter').map(m => m.id)
    expect(openrouterIds).toContain('pi/openrouter/auto')
    const otherPrefixed = openrouterIds.find(id => id !== 'pi/openrouter/auto')
    if (!otherPrefixed) throw new Error('expected at least two OpenRouter models in catalog')
    const expectedPrefixed = ['pi/openrouter/auto', otherPrefixed]
    const legacyUnprefixed = expectedPrefixed.map(id => id.slice('pi/'.length))

    writeRootConfig(configPath, workspaceRoot, [
      {
        slug: 'pi-api-key',
        name: 'Craft Agents Backend (OpenRouter)',
        providerType: 'pi',
        authType: 'api_key',
        piAuthProvider: 'openrouter',
        modelSelectionMode: 'userDefined3Tier',
        createdAt: Date.now(),
        models: legacyUnprefixed,
        defaultModel: legacyUnprefixed[0],
      },
    ])

    runMigration(configDir)

    const connection = readPiApiKeyConnection(configPath)
    expect(connection).toBeDefined()
    expect(connection.modelSelectionMode).toBe('userDefined3Tier')
    const modelIds = getModelIds(connection)
    expect(modelIds).toEqual(legacyUnprefixed)
    expect(connection.defaultModel).toBe(legacyUnprefixed[0])
  })
})

function readConfigJson(configPath: string): any {
  return JSON.parse(readFileSync(configPath, 'utf-8'))
}

function findConnection(configPath: string, slug: string): any {
  return readConfigJson(configPath).llmConnections.find((c: any) => c.slug === slug)
}

function modelIdsOf(connection: any): string[] {
  return (connection?.models ?? []).map((m: any) => typeof m === 'string' ? m : m.id)
}

describe('preserving existing explicit selections at startup', () => {
  it('preserves an orphaned selected connection and rejects backend creation instead of using another one', () => {
    const { configDir, workspaceRoot, configPath } = setupWorkspaceConfigDir()
    writeRootConfig(configPath, workspaceRoot, [{
      slug: 'pi-api-key', name: 'Available connection', providerType: 'anthropic',
      authType: 'api_key', createdAt: Date.now(), models: ['claude-sonnet-4-6'], defaultModel: 'claude-sonnet-4-6',
    }])
    const config = readConfigJson(configPath)
    config.defaultLlmConnection = 'retired-selected-connection'
    writeFileSync(configPath, JSON.stringify(config))
    runMigration(configDir)
    expect(readConfigJson(configPath).defaultLlmConnection).toBe('retired-selected-connection')

    const factoryPath = pathToFileURL(join(import.meta.dir, '..', '..', 'agent', 'backend', 'factory.ts')).href
    const result = Bun.spawnSync([process.execPath, '--eval', `
      import { resolveBackendContext } from '${factoryPath}';
      try { resolveBackendContext({}); process.exit(2); }
      catch (error) { console.log(error.message); }
    `], { env: { ...process.env, CRAFT_CONFIG_DIR: configDir }, stdout: 'pipe', stderr: 'pipe' })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain('selected LLM connection is unavailable')
  })

  for (const selected of ['claude-opus-4-5-20251101', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-sonnet-4-5-20250929']) {
    it(`preserves connection and workspace model ${selected}`, () => {
      const { configDir, workspaceRoot, configPath } = setupWorkspaceConfigDir()
      const workspacePath = join(workspaceRoot, 'config.json')
      const workspace = JSON.parse(readFileSync(workspacePath, 'utf-8'))
      workspace.defaults = { model: selected, defaultLlmConnection: 'retired-explicit-connection' }
      writeFileSync(workspacePath, JSON.stringify(workspace))
      writeRootConfig(configPath, workspaceRoot, [{
        slug: 'pi-api-key', name: 'Explicit selection', providerType: 'anthropic',
        authType: 'api_key', createdAt: Date.now(), models: [selected], defaultModel: selected,
      }])
      runMigration(configDir)
      runMigration(configDir)
      expect(readPiApiKeyConnection(configPath).defaultModel).toBe(selected)
      expect(getModelIds(readPiApiKeyConnection(configPath))).toEqual([selected])
      expect(JSON.parse(readFileSync(workspacePath, 'utf-8')).defaults)
        .toEqual({ model: selected, defaultLlmConnection: 'retired-explicit-connection' })
    })
  }

  it('keeps provider defaults available for a connection without a prior model selection', () => {
    const { configDir, workspaceRoot, configPath } = setupWorkspaceConfigDir()
    writeRootConfig(configPath, workspaceRoot, [{
      slug: 'pi-api-key', name: 'New connection', providerType: 'anthropic',
      authType: 'api_key', createdAt: Date.now(),
    }])
    runMigration(configDir)
    const connection = readPiApiKeyConnection(configPath)
    expect(connection.defaultModel).toBeTruthy()
    expect(getModelIds(connection)).toContain(connection.defaultModel)
  })
})
