import { describe, expect, it } from 'bun:test'
import type { AgentEvent } from '@craft-agent/core/types'
import { PiEventAdapter } from '../../../shared/src/agent/backend/pi/event-adapter'
import { AutomaticRecoveryStalledError, createAutomaticRecoveryToolDeadline, withAutomaticRecoveryInactivityTimeout } from './turn-recovery'

const start = (id = 'docker-build', timeout: unknown = 420): AgentEvent => ({
  type: 'tool_start', toolName: 'Bash', toolUseId: id, input: { timeout },
})
const result = (id = 'docker-build'): AgentEvent => ({
  type: 'tool_result', toolName: 'Bash', toolUseId: id, result: 'fixture receipt', isError: false,
})

describe('automatic recovery watchdog', () => {
  it('does not interrupt a live tool before its separately bounded deadline', async () => {
    const deadline = createAutomaticRecoveryToolDeadline('pi', 10)
    const adapter = new PiEventAdapter()
    async function* source(): AsyncGenerator<AgentEvent> {
      yield* adapter.adaptEvent({ type: 'tool_execution_start', toolName: 'bash', toolCallId: 'docker-build',
        args: { command: 'docker build --pull=false -t fixture:test .', timeout: 420 } })
      await new Promise(resolve => setTimeout(resolve, 35))
      yield* adapter.adaptEvent({ type: 'tool_execution_end', toolName: 'bash', toolCallId: 'docker-build',
        result: { content: [{ type: 'text', text: 'fixture receipt' }] }, isError: false })
    }
    const events: AgentEvent[] = []
    for await (const event of withAutomaticRecoveryInactivityTimeout(source(), 10, deadline.remainingMs)) {
      deadline.observe(event); events.push(event)
    }
    expect(events.map(event => event.type)).toEqual(['tool_start', 'tool_result'])
    expect(deadline.remainingMs()).toBe(10)
  })

  it('preserves the real 420-second timeout beyond the observed 300007-ms gap, with a fixed 30-second receipt grace', () => {
    let now = 0; const deadline = createAutomaticRecoveryToolDeadline('pi', 300_000, () => now)
    deadline.observe(start())
    expect(deadline.remainingMs()).toBe(450_000)
    now = 300_007
    expect(deadline.remainingMs()).toBe(149_993)
    deadline.observe(start())
    deadline.observe({ type: 'status', message: 'Still working' })
    expect(deadline.remainingMs()).toBe(149_993)
    now = 450_000
    expect(deadline.remainingMs()).toBe(0)
    deadline.observe(result())
    expect(deadline.remainingMs()).toBe(300_000)
  })

  it('expires synchronously even when unrelated provider events are immediately available', async () => {
    let now = 0; let nextCalls = 0
    const deadline = createAutomaticRecoveryToolDeadline('pi', 300_000, () => now)
    deadline.observe(start()); now = 450_001
    const noisy = { [Symbol.asyncIterator]() { return { next: async () => { nextCalls++; return { done: false as const, value: { type: 'status', message: 'noise' } } } } } }
    const iterator = withAutomaticRecoveryInactivityTimeout(noisy, 300_000, deadline.remainingMs)
    await expect(iterator.next()).rejects.toBeInstanceOf(AutomaticRecoveryStalledError)
    expect(nextCalls).toBe(0)
  })

  it.each([undefined, null, '420', -1, 0, NaN, Infinity, -Infinity])('does not extend the watchdog for invalid timeout %s', timeout => {
    const deadline = createAutomaticRecoveryToolDeadline('pi', 300_000)
    deadline.observe({ ...start('invalid'), input: { timeout } } as AgentEvent)
    expect(deadline.remainingMs()).toBe(300_000)
  })

  it('caps excessive finite timeouts and overflow at an absolute 30 minutes', () => {
    for (const timeout of [3600, Number.MAX_VALUE]) {
      let now = 0; const deadline = createAutomaticRecoveryToolDeadline('pi', 300_000, () => now)
      deadline.observe(start('large', timeout))
      expect(deadline.remainingMs()).toBe(1_800_000)
      now = 1_800_001
      expect(deadline.remainingMs()).toBe(-1)
    }
  })

  it('does not guess units for another provider or MCP tool', () => {
    for (const provider of ['anthropic', 'openai', 'unknown']) {
      const deadline = createAutomaticRecoveryToolDeadline(provider, 300_000)
      deadline.observe(start())
      expect(deadline.remainingMs()).toBe(300_000)
    }
    const deadline = createAutomaticRecoveryToolDeadline('pi', 300_000)
    deadline.observe({ ...start(), toolName: 'mcp__remote__Bash' } as AgentEvent)
    expect(deadline.remainingMs()).toBe(300_000)
  })

  it('does not resurrect a finished call from a delayed or duplicate start', () => {
    const deadline = createAutomaticRecoveryToolDeadline('pi', 300_000)
    deadline.observe(result()); deadline.observe(start())
    expect(deadline.remainingMs()).toBe(300_000)
  })

  it('releases only the matching pending tool, and keeps each first deadline absolute', () => {
    let now = 0; const deadline = createAutomaticRecoveryToolDeadline('pi', 300_000, () => now)
    deadline.observe(start('first', 420))
    now = 100_000; deadline.observe(start('second', 600))
    deadline.observe(result('unknown'))
    expect(deadline.remainingMs()).toBe(350_000)
    deadline.observe(result('first'))
    expect(deadline.remainingMs()).toBe(630_000)
    const newTurn = createAutomaticRecoveryToolDeadline('pi', 300_000, () => now)
    expect(newTurn.remainingMs()).toBe(300_000)
    deadline.observe(result('second'))
    expect(deadline.remainingMs()).toBe(300_000)
  })

  it('restores the ordinary stall bound after the tool result', async () => {
    const deadline = createAutomaticRecoveryToolDeadline('pi', 10)
    async function* source(): AsyncGenerator<AgentEvent> {
      yield start(); yield result()
      await new Promise<void>(() => {})
    }
    let caught: unknown
    try { for await (const event of withAutomaticRecoveryInactivityTimeout(source(), 10, deadline.remainingMs)) deadline.observe(event) }
    catch (error) { caught = error }
    expect(caught).toBeInstanceOf(AutomaticRecoveryStalledError)
    expect((caught as Error).message).toContain('10 ms')
  })

  it('lets a permission TTL that appears after next() win the watchdog race once', async () => {
    let permissionRemaining: number | undefined
    let expired = false
    async function* source(): AsyncGenerator<AgentEvent> {
      await new Promise<void>(() => {})
    }
    setTimeout(() => { permissionRemaining = 20 }, 2)
    setTimeout(() => { expired = true; permissionRemaining = undefined }, 15)

    const iterator = withAutomaticRecoveryInactivityTimeout(
      source(),
      10,
      undefined,
      () => permissionRemaining,
    )
    await expect(iterator.next()).rejects.toBeInstanceOf(AutomaticRecoveryStalledError)
    expect(expired).toBe(true)
  })
})
