import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

function setupConfigDir() {
  const configDir = mkdtempSync(join(tmpdir(), 'craft-agent-config-rtk-'))
  writeFileSync(join(configDir, 'config-defaults.json'), JSON.stringify({
    version: 'test',
    description: 'test defaults',
    defaults: {
      notificationsEnabled: true,
      colorTheme: 'default',
      autoCapitalisation: true,
      sendMessageKey: 'enter',
      spellCheck: false,
      keepAwakeWhileRunning: false,
      richToolDescriptions: true,
      extendedPromptCache: false,
      browserToolEnabled: true,
      rtkEnabled: true,
      allowRemoteEvaluate: true,
    },
    workspaceDefaults: {
      thinkingLevel: 'high',
      permissionMode: 'allow-all',
      cyclablePermissionModes: ['allow-all', 'ask', 'safe'],
      localMcpServers: { enabled: true },
    },
  }), 'utf8')
  return configDir
}

function runEval(configDir: string, code: string): string {
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import { getRtkEnabled, setRtkEnabled } from '${STORAGE_MODULE_PATH}'; ${code}`,
  ], {
    env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (run.exitCode !== 0) throw new Error(run.stderr.toString())
  return run.stdout.toString().trim()
}

describe('RTK default storage', () => {
  it('enables RTK when no user preference has been recorded', () => {
    const configDir = setupConfigDir()
    expect(runEval(configDir, 'console.log(String(getRtkEnabled()))')).toBe('true')
  })

  it('persists an explicit opt-out for a first-run profile', () => {
    const configDir = setupConfigDir()
    runEval(configDir, 'setRtkEnabled(false)')
    expect(runEval(configDir, 'console.log(String(getRtkEnabled()))')).toBe('false')
    expect(JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8')).rtkEnabled).toBe(false)
  })
})
