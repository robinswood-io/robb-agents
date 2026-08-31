import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'

const PROBE_TIMEOUT_MS = 20_000
const AUTH_TIMEOUT_MS = 10 * 60 * 1000
const AUTH_POLL_INTERVAL_MS = 2_000
const MAX_PROBE_OUTPUT_BYTES = 128 * 1024

const SAFE_ENVIRONMENT_KEYS = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC',
  'PROCESSOR_ARCHITECTURE', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'HOME', 'USER', 'USERNAME', 'LOGNAME', 'SHELL', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE',
])

type SpawnLike = (
  command: string,
  args: readonly string[],
  options: Parameters<typeof spawn>[2],
) => ChildProcess

export type AntigravityProbeResult =
  | { status: 'ready'; models: string[] }
  | { status: 'unauthenticated' }
  | { status: 'unavailable' }
  | { status: 'error' }

export interface GoogleAntigravitySetupOptions {
  environment?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  command?: string
  pathExists?: (path: string) => boolean
  spawnImpl?: SpawnLike
  launchInteractive?: (command: string, platform: NodeJS.Platform) => Promise<void>
  now?: () => number
  delay?: (milliseconds: number) => Promise<void>
}

export function buildGoogleAntigravityEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string' || value.startsWith('()')) continue
    const normalized = platform === 'win32' ? key.toUpperCase() : key
    if (SAFE_ENVIRONMENT_KEYS.has(normalized)) environment[key] = value
  }
  return environment
}

export function resolveGoogleAntigravityCommand(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  pathExists: (path: string) => boolean = existsSync,
): string {
  const override = environment.ROBB_ANTIGRAVITY_COMMAND?.trim()
  if (override) return override

  const userHome = environment.HOME || environment.USERPROFILE || homedir()
  const executable = platform === 'win32' ? 'agy.exe' : 'agy'
  const candidates = platform === 'win32'
    ? [
        join(userHome, 'AppData', 'Local', 'agy', 'bin', executable),
        join(userHome, '.local', 'bin', executable),
      ]
    : [join(userHome, '.local', 'bin', executable)]
  return candidates.find(pathExists) ?? executable
}

function parseModelIds(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map(line => line.trim().split(/\s+/)[0] ?? '')
    .filter(id => /^(?:gemini|claude|gpt)-[a-z0-9][a-z0-9.-]*$/i.test(id))
}

export async function probeGoogleAntigravity(
  command: string,
  options: Pick<GoogleAntigravitySetupOptions, 'environment' | 'platform' | 'spawnImpl'> = {},
): Promise<AntigravityProbeResult> {
  const platform = options.platform ?? process.platform
  const spawnImpl = options.spawnImpl ?? spawn
  const child = spawnImpl(command, ['models'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildGoogleAntigravityEnvironment(options.environment, platform),
  })

  return await new Promise<AntigravityProbeResult>((resolve) => {
    let settled = false
    let output = ''
    let outputBytes = 0
    const finish = (result: AntigravityProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(result)
    }
    const append = (chunk: Buffer | string) => {
      if (outputBytes >= MAX_PROBE_OUTPUT_BYTES) return
      const text = chunk.toString()
      outputBytes += Buffer.byteLength(text)
      output += text.slice(0, Math.max(0, MAX_PROBE_OUTPUT_BYTES - output.length))
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.once('error', () => finish({ status: 'unavailable' }))
    child.once('exit', (code) => {
      if (code === 0) {
        const models = parseModelIds(output)
        finish(models.length > 0 ? { status: 'ready', models } : { status: 'error' })
        return
      }
      const normalized = output.toLowerCase()
      finish(normalized.includes('sign in') || normalized.includes('authentication')
        ? { status: 'unauthenticated' }
        : { status: 'error' })
    })
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      finish({ status: 'error' })
    }, PROBE_TIMEOUT_MS)
    timeout.unref?.()
  })
}

async function launchInteractiveAntigravity(
  command: string,
  platform: NodeJS.Platform,
  spawnImpl: SpawnLike = spawn,
): Promise<void> {
  let child: ChildProcess
  if (platform === 'darwin') {
    child = spawnImpl('/usr/bin/osascript', [
      '-e', 'on run argv',
      '-e', 'tell application "Terminal" to activate',
      '-e', 'tell application "Terminal" to do script (quoted form of item 1 of argv)',
      '-e', 'end run',
      '--', command,
    ], { detached: true, stdio: 'ignore' })
  } else if (platform === 'win32') {
    child = spawnImpl('cmd.exe', ['/d', '/s', '/c', 'start', '', command], {
      detached: true,
      windowsHide: false,
      stdio: 'ignore',
    })
  } else {
    child = spawnImpl('x-terminal-emulator', ['-e', command], { detached: true, stdio: 'ignore' })
  }
  child.unref()
}

export async function startGoogleAntigravitySetup(
  options: GoogleAntigravitySetupOptions = {},
): Promise<{ success: boolean; error?: string }> {
  const environment = options.environment ?? process.env
  const platform = options.platform ?? process.platform
  const command = options.command
    ?? resolveGoogleAntigravityCommand(environment, platform, options.pathExists)
  const probeOptions = { environment, platform, spawnImpl: options.spawnImpl }
  const initial = await probeGoogleAntigravity(command, probeOptions)
  if (initial.status === 'ready') return { success: true }
  if (initial.status === 'unavailable') {
    return {
      success: false,
      error: 'Google Antigravity CLI is not installed. Install it from antigravity.google/docs/cli/install, then try again.',
    }
  }
  if (initial.status === 'error') {
    return {
      success: false,
      error: 'Google Antigravity CLI could not verify the account. Run `agy models` in Terminal, then try again.',
    }
  }

  try {
    await (options.launchInteractive ?? ((value, targetPlatform) => (
      launchInteractiveAntigravity(value, targetPlatform, options.spawnImpl)
    )))(command, platform)
  } catch {
    return {
      success: false,
      error: 'Google Antigravity needs an interactive sign-in. Run `agy` in Terminal, complete Google login, then try again.',
    }
  }

  const now = options.now ?? Date.now
  const delay = options.delay ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  const deadline = now() + AUTH_TIMEOUT_MS
  while (now() < deadline) {
    await delay(AUTH_POLL_INTERVAL_MS)
    const probe = await probeGoogleAntigravity(command, probeOptions)
    if (probe.status === 'ready') return { success: true }
    if (probe.status === 'unavailable') break
  }
  return {
    success: false,
    error: 'Google Antigravity sign-in did not complete in time. Finish it in Terminal, then try again.',
  }
}
