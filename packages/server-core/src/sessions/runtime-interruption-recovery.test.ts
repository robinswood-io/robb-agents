import { beforeEach, describe, expect, it } from 'bun:test'
import type { AgentEvent } from '@craft-agent/shared/agent'
import { SessionManager, createManagedSession } from './SessionManager.ts'

describe('runtime interruption recovery seam', () => {
  let sessionManager: SessionManager

  beforeEach(() => {
    sessionManager = new SessionManager()
    ;(sessionManager as unknown as { persistSession: () => void }).persistSession = () => {}
    ;(sessionManager as unknown as { sendEvent: () => void }).sendEvent = () => {}
    ;(sessionManager as unknown as { emitExecutionTelemetry: () => void }).emitExecutionTelemetry = () => {}
  })

  it('keeps a process crash non-terminal so the bounded recovery path can resume it', async () => {
    const managed = createManagedSession({
      id: 'runtime-interrupted',
      name: 'Runtime interruption',
    }, {
      id: 'workspace-runtime-interrupted',
      name: 'Runtime interruption workspace',
      rootPath: '/tmp/runtime-interruption-recovery-test',
      createdAt: Date.now(),
    } as never, { messagesLoaded: true })
    managed.isProcessing = true
    managed.messages.push({
      id: 'user-1',
      role: 'user',
      content: 'Finish the work',
      timestamp: 1,
    })

    const event: AgentEvent = {
      type: 'runtime_interrupted',
      message: 'Pi subprocess exited unexpectedly (signal SIGSEGV)',
      code: 'process_exit',
      signal: 'SIGSEGV',
    }
    await (sessionManager as unknown as {
      processEvent: (session: unknown, agentEvent: AgentEvent) => Promise<void>
    }).processEvent(managed, event)

    expect(managed.messages).toHaveLength(1)
    expect(managed.messages.some(message => message.role === 'error')).toBe(false)
    expect(managed.terminalErrorGeneration).toBeUndefined()
    expect(managed.isProcessing).toBe(true)
  })
})
