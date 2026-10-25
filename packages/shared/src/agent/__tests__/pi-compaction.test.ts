import { describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent'
import type { BackendConfig } from '../backend/types'

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: { slug: 'test-workspace', createdAt: 1,
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/craft-agent-compaction-test',
    },
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/craft-agent-compaction-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    },
    isHeadless: true,
  }
}

function installFakeSubprocess(agent: PiAgent): Array<Record<string, unknown>> {
  const sent: Array<Record<string, unknown>> = []
  ;agent['ensureSubprocess'] = async () => {}
  ;agent['send'] = (message: Record<string, unknown>) => { sent.push(message); return true; }
  return sent
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('PiAgent compaction RPC', () => {
  it('keeps a local /compact turn outside the provider handoff boundary', async () => {
    const agent = new PiAgent(createConfig())
    const sent = installFakeSubprocess(agent)
    let handoffs = 0
    let writeAheads = 0
    agent.onProviderHandoff = () => { handoffs += 1 }
    agent.onBeforeProviderDispatch = async () => { writeAheads += 1 }
    ;agent['send'] = (message: Record<string, unknown>) => {
      sent.push(message)
      if (message.type !== 'compact') return true
      queueMicrotask(() => {
        ;agent['handleLine'](JSON.stringify({
          type: 'compact_result',
          id: message.id,
          success: true,
          result: {
            summary: 'Compacted locally.',
            firstKeptEntryId: 'entry-local',
            tokensBefore: 42_000,
          },
        }))
      })
    return true;
}

    const events = []
    for await (const event of agent.chat('/compact')) events.push(event)

    expect(sent.map(message => message.type)).toEqual(['compact'])
    expect(events).toEqual([
      { type: 'info', message: 'Compacted context to fit within limits (from ~42,000 tokens)' },
      { type: 'complete' },
    ])
    expect(handoffs).toBe(0)
    expect(writeAheads).toBe(0)
    agent.destroy()
  })

  it('preserves the SDK post-compaction measurement and utility model', async () => {
    const agent = new PiAgent(createConfig())
    const sent = installFakeSubprocess(agent)

    const pending = agent.compactContext('Keep verified evidence.')
    await flushMicrotasks()
    const id = sent[0]!.id as string

    ;agent['handleLine'](JSON.stringify({
      type: 'compact_result',
      id,
      success: true,
      result: {
        summary: 'Verified operational state with exact identifiers and remaining work.',
        firstKeptEntryId: 'entry-42',
        tokensBefore: 100_000,
        estimatedTokensAfter: 21_500,
        compactionModel: 'gpt-5.4-mini',
      },
    }))

    await expect(pending).resolves.toEqual({
      summary: 'Verified operational state with exact identifiers and remaining work.',
      firstKeptEntryId: 'entry-42',
      tokensBefore: 100_000,
      estimatedTokensAfter: 21_500,
      compactionModel: 'gpt-5.4-mini',
    })
    agent.destroy()
  })

  it('aborts the subprocess compaction when the host deadline expires', async () => {
    const agent = new PiAgent(createConfig())
    const sent = installFakeSubprocess(agent)
    const originalSetTimeout = globalThis.setTimeout
    ;globalThis.setTimeout = ((callback: () => void) => originalSetTimeout(callback, 1)) as typeof setTimeout

    try {
      await expect(agent.compactContext()).rejects.toThrow(/timed out/i)
      expect(sent.map(message => message.type)).toEqual(['compact', 'abort_compaction'])
      expect(sent[1]!.id).toBe(sent[0]!.id)
      expect(agent['pendingCompactions'].size).toBe(0)
    } finally {
      ;globalThis.setTimeout = originalSetTimeout
      agent.destroy()
    }
  })
})
