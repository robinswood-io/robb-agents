import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, Message, StoredMessage } from '@craft-agent/core/types'
import { getSessionFilePath } from '@craft-agent/shared/sessions/storage'
import { SessionManager, createManagedSession } from './SessionManager'

type Managed = ReturnType<typeof createManagedSession>

describe('tool start durability before results arrive', () => {
  let root: string
  let manager: SessionManager
  let managed: Managed
  let runtime: {
    sessions: Map<string, Managed>
    processEvent: (session: Managed, event: AgentEvent) => Promise<void>
    persistSession: (session: Managed) => void
    sendEvent: (event: unknown) => void
    emitExecutionTelemetry: () => void
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tool-start-durability-'))
    manager = new SessionManager()
    managed = createManagedSession({ id: 'tool-start-session', name: 'Durability fixture' }, {
      id: 'test-workspace', slug: 'test', name: 'Test workspace', rootPath: root, createdAt: 1,
    }, { messagesLoaded: true })
    runtime = manager as unknown as typeof runtime
    runtime.sessions.set(managed.id, managed)
    runtime.sendEvent = () => {}
    runtime.emitExecutionTelemetry = () => {}
  })

  afterEach(async () => {
    await manager.flushAllSessions()
    rmSync(root, { recursive: true, force: true })
  })

  function readTools(): StoredMessage[] {
    return readFileSync(getSessionFilePath(root, managed.id), 'utf8').trim().split('\n')
      .slice(1).map(line => JSON.parse(line) as StoredMessage).filter(message => message.type === 'tool')
  }

  it('retains the final unfinished tool when the normal quit flush runs without any later event', async () => {
    await runtime.processEvent(managed, { type: 'tool_start', toolName: 'Grep', toolUseId: 'pending-grep', input: { pattern: 'synthetic-sentinel', glob: '*.ts' } })
    const live = managed.messages.at(-1) as Message
    expect(live.toolStatus).toBe('executing')
    // Same seam used by Electron before-quit: no tool_result or completion save.
    await manager.flushAllSessions()
    expect(readTools()).toHaveLength(1)
    expect(readTools()[0]).toMatchObject({ id: live.id, toolUseId: 'pending-grep', toolStatus: 'executing', toolInput: { pattern: 'synthetic-sentinel', glob: '*.ts' } })
    expect(readTools()[0]?.toolResult).toBeUndefined()
    expect(readTools()[0]?.toolExecuted).toBeUndefined()
  })

  it('persists the SDK second start event input on the same tool record before a result arrives', async () => {
    await runtime.processEvent(managed, { type: 'tool_start', toolName: 'Grep', toolUseId: 'dual-start-grep', input: {} })
    // Seed the existing placeholder, as a prior unrelated save could do.
    runtime.persistSession(managed)
    await manager.flushAllSessions()
    const id = readTools()[0]!.id
    await runtime.processEvent(managed, { type: 'tool_start', toolName: 'Grep', toolUseId: 'dual-start-grep', input: { pattern: 'complete-input', glob: '*.json' }, parentToolUseId: 'parent-tool', intent: 'Find the requested value' })
    await manager.flushAllSessions()
    expect(readTools()).toHaveLength(1)
    expect(readTools()[0]).toMatchObject({ id, toolInput: { pattern: 'complete-input', glob: '*.json' }, parentToolUseId: 'parent-tool', toolIntent: 'Find the requested value', toolStatus: 'executing' })
    expect(readTools()[0]?.toolResult).toBeUndefined()
  })
})
