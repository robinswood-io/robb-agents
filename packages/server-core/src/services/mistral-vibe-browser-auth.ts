import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { APP_VERSION } from '@craft-agent/shared/version'

const START_TIMEOUT_MS = 15_000
const DEFAULT_FLOW_TTL_MS = 10 * 60 * 1000
const MAX_FLOW_TTL_MS = 15 * 60 * 1000

const SAFE_ENVIRONMENT_KEYS = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC',
  'PROCESSOR_ARCHITECTURE', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'HOME', 'USER', 'USERNAME', 'LOGNAME', 'SHELL', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  'VIBE_HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'LC_ALL',
  'LC_CTYPE', 'TZ', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
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

export interface MistralVibeBrowserAuthFlow {
  authUrl: string
  expiresAt: number
  complete(): Promise<void>
  close(): void
}

export interface StartMistralVibeBrowserAuthOptions {
  environment?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  command?: string
  spawnImpl?: SpawnLike
  pathExists?: (path: string) => boolean
  now?: () => number
}

export function buildMistralVibeEnvironment(
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

export function resolveMistralVibeAcpCommand(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  pathExists: (path: string) => boolean = existsSync,
): string {
  const override = environment.ROBB_VIBE_ACP_COMMAND?.trim()
  if (override) return override

  const userHome = environment.HOME || environment.USERPROFILE || homedir()
  const executable = platform === 'win32' ? 'vibe-acp.exe' : 'vibe-acp'
  const uvToolPath = join(userHome, '.local', 'bin', executable)
  return pathExists(uvToolPath) ? uvToolPath : executable
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function safeMistralSignInUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Mistral Vibe did not return a sign-in URL')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.hostname !== 'console.mistral.ai') {
    throw new Error('Mistral Vibe returned an untrusted sign-in URL')
  }
  return url.toString()
}

function resolveExpiry(value: unknown, now: number): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(parsed) || parsed <= now) return now + DEFAULT_FLOW_TTL_MS
  return Math.min(parsed, now + MAX_FLOW_TTL_MS)
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Mistral Vibe did not start in time')), START_TIMEOUT_MS)
    child.once('spawn', () => {
      clearTimeout(timeout)
      resolve()
    })
    child.once('error', () => {
      clearTimeout(timeout)
      reject(new Error('Mistral Vibe is not installed or is not available on PATH'))
    })
  })
}

async function requestWithTimeout<T>(
  request: (cancellationSignal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      request(controller.signal),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort()
          reject(new Error(message))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export async function startMistralVibeBrowserAuth(
  options: StartMistralVibeBrowserAuthOptions = {},
): Promise<MistralVibeBrowserAuthFlow> {
  const environment = options.environment ?? process.env
  const platform = options.platform ?? process.platform
  const command = options.command
    ?? resolveMistralVibeAcpCommand(environment, platform, options.pathExists)
  const spawnImpl = options.spawnImpl ?? spawn
  const now = options.now ?? Date.now
  const child = spawnImpl(command, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: buildMistralVibeEnvironment(environment, platform),
  })

  // Vibe-owned stderr may contain account or provider context. Drain it without
  // relaying its contents into Robb logs or RPC errors.
  child.stderr?.on('data', () => undefined)

  let connection: ReturnType<ReturnType<typeof client>['connect']> | undefined
  const close = () => {
    connection?.close()
    if (child.exitCode === null && !child.killed) child.kill()
  }

  try {
    await waitForSpawn(child)
    if (!child.stdin || !child.stdout) throw new Error('Mistral Vibe ACP streams are unavailable')

    const app = client({ name: 'Robb Agents' })
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    )
    connection = app.connect(stream)
    child.once('exit', () => connection?.close())

    const initializeResult = await requestWithTimeout(
      cancellationSignal => connection!.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { _meta: { 'browser-auth-delegated': true } },
        clientInfo: { name: 'Robb Agents', version: APP_VERSION },
      }, { cancellationSignal }),
      START_TIMEOUT_MS,
      'Mistral Vibe ACP initialization timed out',
    )

    const supportsDelegatedAuth = initializeResult.authMethods?.some(
      method => method.id === 'browser-auth-delegated',
    )
    if (!supportsDelegatedAuth) {
      throw new Error('Mistral Vibe must be updated to a version supporting delegated browser authentication')
    }

    const startResponse = await requestWithTimeout(
      cancellationSignal => connection!.agent.request(
        'authenticate' as string,
        {
          methodId: 'browser-auth-delegated',
          action: 'start',
          signInTarget: 'mistral',
        },
        { cancellationSignal },
      ) as Promise<Record<string, unknown>>,
      START_TIMEOUT_MS,
      'Mistral Vibe browser authentication timed out while starting',
    )
    const metadata = asRecord(asRecord(startResponse._meta)?.['browser-auth-delegated'])
    const attemptId = metadata?.attemptId
    if (typeof attemptId !== 'string' || !attemptId) {
      throw new Error('Mistral Vibe did not return a browser authentication attempt')
    }
    const authUrl = safeMistralSignInUrl(metadata.signInUrl)
    const expiresAt = resolveExpiry(metadata.expiresAt, now())

    return {
      authUrl,
      expiresAt,
      async complete() {
        const remainingMs = Math.max(1, expiresAt - now())
        const response = await requestWithTimeout(
          cancellationSignal => connection!.agent.request(
            'authenticate' as string,
            {
              methodId: 'browser-auth-delegated',
              action: 'complete',
              attemptId,
            },
            { cancellationSignal },
          ) as Promise<Record<string, unknown>>,
          remainingMs,
          'Mistral Vibe browser authentication expired before completion',
        )
        const completed = asRecord(asRecord(response._meta)?.['browser-auth-delegated'])
        if (completed?.status !== 'completed') {
          throw new Error('Mistral Vibe browser authentication did not complete')
        }
      },
      close,
    }
  } catch (error) {
    close()
    throw error
  }
}
