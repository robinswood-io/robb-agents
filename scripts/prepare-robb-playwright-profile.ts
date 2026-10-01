import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'

const profileDir = resolve(
  process.env.CRAFT_CONFIG_DIR ?? '/tmp/robb-agents-playwright',
)
const serverPort = Number.parseInt(
  process.env.ROBB_PLAYWRIGHT_SERVER_PORT ?? '19100',
  10,
)

if (!Number.isInteger(serverPort) || serverPort < 1024 || serverPort > 65535) {
  throw new Error(`ROBB_PLAYWRIGHT_SERVER_PORT must be between 1024 and 65535, got ${serverPort}`)
}

// Config paths are resolved when the shared modules are imported, so set the
// isolated profile first and keep these imports dynamic.
process.env.CRAFT_CONFIG_DIR = profileDir

const [{ ensureConfigDir, loadStoredConfig, saveConfig }, { createWorkspaceAtPath }] = await Promise.all([
  import('../packages/shared/src/config/storage.ts'),
  import('../packages/shared/src/workspaces/storage.ts'),
])

ensureConfigDir()

let config = loadStoredConfig()
if (!config) {
  const workspaceRoot = join(profileDir, 'workspaces', 'my-workspace')
  const workspaceConfig = createWorkspaceAtPath(workspaceRoot, 'My Workspace')
  const workspaceId = randomUUID()

  config = {
    workspaces: [{
      id: workspaceId,
      rootPath: workspaceRoot,
      name: workspaceConfig.name,
      slug: workspaceConfig.slug,
      createdAt: workspaceConfig.createdAt,
    }],
    activeWorkspaceId: workspaceId,
    activeSessionId: null,
    llmConnections: [],
  }
}

config.setupDeferred = true
config.serverConfig = {
  enabled: true,
  port: serverPort,
  token: config.serverConfig?.token ?? randomUUID(),
}

saveConfig(config)
console.log(`Prepared Robb Playwright profile at ${profileDir} (Remote port ${serverPort})`)
