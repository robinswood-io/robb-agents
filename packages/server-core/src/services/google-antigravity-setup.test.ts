import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import {
  buildGoogleAntigravityEnvironment,
  probeGoogleAntigravity,
  resolveGoogleAntigravityCommand,
  startGoogleAntigravitySetup,
} from './google-antigravity-setup.ts'

class FakeAgyProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false

  constructor(output: string, private readonly code: number) {
    super()
    queueMicrotask(() => {
      this.stdout.end(output)
      this.emit('exit', this.code)
    })
  }

  kill(): boolean {
    this.killed = true
    return true
  }

  unref(): void {}
}

describe('Google Antigravity account setup', () => {
  it('resolves ~/.local/bin and removes ambient API credentials', () => {
    const environment = {
      HOME: '/Users/tester',
      PATH: '/usr/bin:/bin',
      GEMINI_API_KEY: 'must-not-be-forwarded',
      GOOGLE_APPLICATION_CREDENTIALS: '/secret/service-account.json',
      HTTPS_PROXY: 'https://proxy.example.test',
    }
    expect(resolveGoogleAntigravityCommand(environment, 'darwin', path => path.endsWith('/agy')))
      .toBe('/Users/tester/.local/bin/agy')
    expect(buildGoogleAntigravityEnvironment(environment, 'darwin')).toEqual({
      HOME: '/Users/tester',
      PATH: '/usr/bin:/bin',
      HTTPS_PROXY: 'https://proxy.example.test',
    })
  })

  it('recognizes an authenticated model catalogue', async () => {
    const result = await probeGoogleAntigravity('/test/agy', {
      spawnImpl: (() => new FakeAgyProcess(
        'Fetching available models...\ngemini-3.7-flash-high\tGemini 3.7 Flash (High)\n',
        0,
      ) as unknown as ChildProcess),
    })
    expect(result).toEqual({ status: 'ready', models: ['gemini-3.7-flash-high'] })
  })

  it('returns success without opening a terminal when the keyring session is ready', async () => {
    let launched = false
    const result = await startGoogleAntigravitySetup({
      command: '/test/agy',
      spawnImpl: (() => new FakeAgyProcess(
        'gemini-3.7-flash-low\tGemini 3.7 Flash (Low)\n',
        0,
      ) as unknown as ChildProcess),
      launchInteractive: async () => { launched = true },
    })
    expect(result).toEqual({ success: true, models: ['gemini-3.7-flash-low'] })
    expect(launched).toBe(false)
  })

  it('classifies the official unauthenticated response without exposing it', async () => {
    const result = await probeGoogleAntigravity('/test/agy', {
      spawnImpl: (() => new FakeAgyProcess(
        'Error: Please sign in to view available models.',
        1,
      ) as unknown as ChildProcess),
    })
    expect(result).toEqual({ status: 'unauthenticated' })
  })

  it('parses models across carriage returns and includes Claude and GPT partner models', async () => {
    const rawOutput = 'Fetching available models...\rclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\r\nclaude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n'
    const result = await probeGoogleAntigravity('/test/agy', {
      spawnImpl: (() => new FakeAgyProcess(rawOutput, 0) as unknown as ChildProcess),
    })
    expect(result).toEqual({
      status: 'ready',
      models: ['claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium'],
    })
  })
})
