import { describe, expect, it, mock } from 'bun:test'
import { ClaudeAgent } from '../claude-agent.ts'
import { AbortReason } from '../backend/types.ts'

describe('ClaudeAgent handoff interrupts', () => {
  it('hard-aborts and queues a newer instruction while an old permission is pending', () => {
    const abort = mock((_reason?: unknown) => {})
    const resolvePermission = mock((_allowed: boolean) => {})
    const agent = Object.create(ClaudeAgent.prototype) as any

    agent.promptPreparationRevision = 0
    agent.pendingPermissions = new Map([['permission-a', { resolve: resolvePermission }]])
    agent.currentQuery = {}
    agent.currentQueryAbortController = { abort }
    agent.config = { session: { id: 'claude-pending-permission' } }

    expect(agent.redirect('Use target B instead.')).toBe(false)
    expect(resolvePermission).toHaveBeenCalledWith(false)
    expect(agent.pendingPermissions.size).toBe(0)
    expect(agent.currentQuery).toBeNull()
    expect(abort).toHaveBeenCalledWith(AbortReason.Redirect)
  })

  it('hard-aborts and revokes a hook-admitted tool before accepting a newer instruction', () => {
    const abort = mock((_reason?: unknown) => {})
    const agent = Object.create(ClaudeAgent.prototype) as any

    agent.promptPreparationRevision = 0
    agent.pendingPermissions = new Map()
    agent.currentQuery = {}
    agent.currentQueryAbortController = { abort }
    agent.config = { session: { id: 'claude-admitted-tool' } }
    expect(agent.admitToolExecution({
      toolUseId: 'tool-a',
      toolName: 'Write',
      toolInput: { file_path: '/tmp/A', content: 'A' },
      sessionId: 'claude-admitted-tool',
      runtimeId: 'claude-runtime-a',
      authorizationEpoch: 0,
    })).toBe(true)

    expect(agent.redirect('Use target B instead.')).toBe(false)
    expect(agent.hasAdmittedToolExecutions()).toBe(false)
    expect(agent.currentQuery).toBeNull()
    expect(abort).toHaveBeenCalledWith(AbortReason.Redirect)
  })

  it('always aborts before asking the host to queue a newer Claude instruction', () => {
    const abort = mock((_reason?: unknown) => {})
    const agent = Object.create(ClaudeAgent.prototype) as any
    agent.promptPreparationRevision = 0
    agent.pendingPermissions = new Map()
    agent.currentQuery = {}
    agent.currentQueryAbortController = { abort }
    agent.config = { session: { id: 'claude-live-turn' } }

    expect(agent.redirect('New instruction.')).toBe(false)
    expect(agent.currentQuery).toBeNull()
    expect(abort).toHaveBeenCalledWith(AbortReason.Redirect)
  })

  it('uses Query.interrupt() for auth handoff instead of aborting the AbortController', async () => {
    const interrupt = mock(async () => {})
    const abort = mock((_reason?: unknown) => {})
    const debug = mock((_message: string) => {})
    const resolvePermission = mock((_allowed: boolean) => {})

    const agent = Object.create(ClaudeAgent.prototype) as any

    agent.currentQuery = { interrupt }
    agent.currentQueryAbortController = { abort }
    agent.pendingPermissions = new Map([['permission-1', { resolve: resolvePermission }]])
    agent.lastAbortReason = null
    agent.debug = debug

    agent.interruptForHandoff(AbortReason.AuthRequest)
    await Promise.resolve()

    expect(interrupt).toHaveBeenCalledTimes(1)
    expect(abort).not.toHaveBeenCalled()
    expect(resolvePermission).toHaveBeenCalledTimes(1)
    expect(resolvePermission).toHaveBeenCalledWith(false)
    expect(agent.pendingPermissions.size).toBe(0)
    expect(agent.lastAbortReason).toBe(AbortReason.AuthRequest)
  })

  it('logs interrupt failures instead of falling back to AbortController', async () => {
    const interrupt = mock(async () => {
      throw new Error('interrupt failed')
    })
    const abort = mock((_reason?: unknown) => {})
    const debug = mock((_message: string) => {})

    const agent = Object.create(ClaudeAgent.prototype) as any

    agent.currentQuery = { interrupt }
    agent.currentQueryAbortController = { abort }
    agent.pendingPermissions = new Map()
    agent.lastAbortReason = null
    agent.debug = debug

    agent.interruptForHandoff(AbortReason.PlanSubmitted)
    await Promise.resolve()
    await Promise.resolve()

    expect(abort).not.toHaveBeenCalled()
    expect(debug).toHaveBeenCalledWith('Claude handoff interrupt failed: interrupt failed')
  })

  it('settles pending permissions fail-closed before force-aborting the query', () => {
    const abort = mock((_reason?: unknown) => {})
    const resolvePermission = mock((_allowed: boolean) => {})
    const agent = Object.create(ClaudeAgent.prototype) as any

    agent.promptPreparationRevision = 0
    agent.lastAbortReason = null
    agent.currentQuery = {}
    agent.currentQueryAbortController = { abort }
    agent.pendingPermissions = new Map([['permission-1', { resolve: resolvePermission }]])

    agent.forceAbort(AbortReason.UserStop)

    expect(resolvePermission).toHaveBeenCalledTimes(1)
    expect(resolvePermission).toHaveBeenCalledWith(false)
    expect(agent.pendingPermissions.size).toBe(0)
    expect(abort).toHaveBeenCalledWith(AbortReason.UserStop)
    expect(agent.currentQuery).toBeNull()
  })

  it('settles pending permissions even when a persistent teardown is already otherwise empty', () => {
    const resolveFirstPermission = mock((_allowed: boolean) => {})
    const resolveSecondPermission = mock((_allowed: boolean) => {})
    const agent = Object.create(ClaudeAgent.prototype) as any

    agent.pendingPermissions = new Map([
      ['permission-1', { resolve: resolveFirstPermission }],
      ['permission-2', { resolve: resolveSecondPermission }],
    ])
    agent.persistentInput = null
    agent.persistentIterator = null
    agent.persistentAbortController = null

    agent.teardownPersistentQuery('test')
    agent.teardownPersistentQuery('already-empty')

    expect(resolveFirstPermission).toHaveBeenCalledTimes(1)
    expect(resolveFirstPermission).toHaveBeenCalledWith(false)
    expect(resolveSecondPermission).toHaveBeenCalledTimes(1)
    expect(resolveSecondPermission).toHaveBeenCalledWith(false)
    expect(agent.pendingPermissions.size).toBe(0)
  })
})
