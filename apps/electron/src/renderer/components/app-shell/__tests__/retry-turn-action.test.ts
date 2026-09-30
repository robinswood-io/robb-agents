import { describe, expect, it, mock } from 'bun:test'
import { createRetryTurnAction } from '../retry-turn-action'

describe('existing request retry action', () => {
  it('reports an already-running acknowledgement while local state is stopped without dispatching again or forcing processing', async () => {
    const state = { isProcessing: false }
    const sessionCommand = mock(async () => ({ status: 'already_running' }))
    const onAlreadyRunning = mock(() => {})
    const onPendingChange = mock((_pending: boolean) => {})
    const onError = mock((_error: unknown) => {})
    const retry = createRetryTurnAction({ sessionId: 'stopped-session', sessionCommand,
      isProcessing: () => state.isProcessing, onPendingChange, onAlreadyRunning, onError })

    await retry('existing-user')
    expect(sessionCommand).toHaveBeenCalledTimes(1)
    expect(sessionCommand).toHaveBeenCalledWith('stopped-session', { type: 'retryTurn', userMessageId: 'existing-user' })
    expect(onAlreadyRunning).toHaveBeenCalledTimes(1)
    expect(onPendingChange.mock.calls).toEqual([[true], [false]])
    expect(state.isProcessing).toBe(false)
    expect(onError).not.toHaveBeenCalled()
  })

  it('does not report an already-running notice for a newly started retry', async () => {
    const onAlreadyRunning = mock(() => {})
    const retry = createRetryTurnAction({ sessionId: 'stopped-session',
      sessionCommand: async () => ({ status: 'started' }), isProcessing: () => false,
      onPendingChange: () => {}, onAlreadyRunning, onError: () => {} })
    await retry('existing-user')
    expect(onAlreadyRunning).not.toHaveBeenCalled()
  })

  it('sends only the anchored command and coalesces rapid repeated clicks', async () => {
    let acknowledge!: () => void
    const acknowledgement = new Promise<void>(resolve => { acknowledge = resolve })
    const sessionCommand = mock(() => acknowledgement)
    const onPendingChange = mock((_pending: boolean) => {})
    const onError = mock((_error: unknown) => {})
    const retry = createRetryTurnAction({ sessionId: 'session-1', sessionCommand,
      isProcessing: () => false, onPendingChange, onError })

    const firstClick = retry('original-user-request')
    await retry('original-user-request')
    expect(sessionCommand).toHaveBeenCalledTimes(1)
    expect(sessionCommand).toHaveBeenCalledWith('session-1', { type: 'retryTurn', userMessageId: 'original-user-request' })
    expect(onPendingChange.mock.calls).toEqual([[true]])
    acknowledge()
    await firstClick
    expect(onPendingChange.mock.calls).toEqual([[true], [false]])
    expect(onError).not.toHaveBeenCalled()
  })

  it('keeps the error visible to the caller and makes retry available after a rejection', async () => {
    const error = new Error('The request is stale')
    const sessionCommand = mock(async () => { throw error })
    const onPendingChange = mock((_pending: boolean) => {})
    const onError = mock((_error: unknown) => {})
    const retry = createRetryTurnAction({ sessionId: 'session-1', sessionCommand,
      isProcessing: () => false, onPendingChange, onError })

    await retry('old-request')
    expect(onError).toHaveBeenCalledWith(error)
    expect(onPendingChange.mock.calls).toEqual([[true], [false]])
    await retry('old-request')
    expect(sessionCommand).toHaveBeenCalledTimes(2)
  })

  it('does not dispatch while a worker is active or without a request anchor', async () => {
    const sessionCommand = mock(async () => {})
    const onPendingChange = mock((_pending: boolean) => {})
    const retry = createRetryTurnAction({ sessionId: 'session-1', sessionCommand,
      isProcessing: () => true, onPendingChange, onError: () => {} })
    await retry('original-user-request')
    await retry('')
    expect(sessionCommand).not.toHaveBeenCalled()
    expect(onPendingChange).not.toHaveBeenCalled()
  })
})
