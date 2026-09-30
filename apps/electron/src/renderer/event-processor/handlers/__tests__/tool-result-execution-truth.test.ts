import { describe, expect, it } from 'bun:test'
import { handleToolResult } from '../tool'
import { handleComplete, handleError, handleTypedError } from '../session'
import type { SessionState, ToolResultEvent } from '../../types'

function stateWithTool(toolName = 'Edit'): SessionState {
  return {
    session: {
      id: 'session-1',
      lastMessageAt: Date.now(),
      isProcessing: true,
      messages: [{
        id: 'tool-1',
        role: 'tool',
        content: `Running ${toolName}...`,
        timestamp: 1,
        toolName,
        toolUseId: 'call-1',
        toolStatus: 'executing',
      }],
    } as never,
    streaming: null,
  }
}

describe('tool_result execution truth', () => {
  for (const typed of [false, true]) {
    it(`preserves unknown execution through ${typed ? 'typed' : 'plain'} transport failure and complete`, () => {
      const state = stateWithTool('Bash')
      const completed = {
        ...state.session.messages[0]!, id: 'completed', toolUseId: 'completed-call',
        toolStatus: 'completed' as const, toolExecuted: true, toolResult: 'build=0',
      }
      const checkpoint = {
        ...completed, id: 'checkpoint', toolUseId: 'checkpoint-call',
        toolExecuted: false, toolResult: 'Edit was not started.',
      }
      state.session.messages.push(completed, checkpoint)
      const content = 'Result unavailable after transport interruption; inspect the existing operation.'
      const failure = typed
        ? handleTypedError(state, { type: 'typed_error', sessionId: 'session-1',
          error: { code: 'unknown_error', title: '', message: content, canRetry: true, actions: [] } })
        : handleError(state, { type: 'error', sessionId: 'session-1', error: content })
      const stopped = handleComplete(failure.state, { type: 'complete', sessionId: 'session-1', reason: 'error' })
      expect(stopped.state.session.isProcessing).toBe(false)
      expect(stopped.state.session.messages[0]?.toolStatus).toBe('error')
      expect(stopped.state.session.messages[0]?.toolResult).toBeUndefined()
      expect(stopped.state.session.messages[0]?.toolExecuted).toBeUndefined()
      expect(stopped.state.session.messages[1]).toEqual(completed)
      expect(stopped.state.session.messages[2]).toEqual(checkpoint)
      expect(stopped.state.session.messages.at(-1)).toMatchObject({ role: 'error', content })
      // The source state and genuine receipts remain immutable.
      expect(state.session.messages[0]?.toolStatus).toBe('executing')
      expect(state.session.messages).toHaveLength(3)
    })
  }

  it('retains a non-executed checkpoint as a non-error completion envelope', () => {
    const checkpoint = {
      schemaVersion: 1 as const,
      kind: 'tool-call-budget' as const,
      reason: 'Error: Edit was not started.',
    }
    const event: ToolResultEvent = {
      type: 'tool_result',
      sessionId: 'session-1',
      toolUseId: 'call-1',
      toolName: 'Edit',
      result: checkpoint.reason,
      isError: false,
      executed: false,
      checkpoint,
    }

    const next = handleToolResult(stateWithTool(), event)
    expect(next.session.messages[0]).toMatchObject({
      toolStatus: 'completed',
      isError: false,
      toolExecuted: false,
      toolCheckpoint: checkpoint,
    })
  })

  it('does not auto-complete child tools when a parent task was not executed', () => {
    const state = stateWithTool('Task')
    state.session.messages.push({
      id: 'child-1',
      role: 'tool',
      content: 'Running Read...',
      timestamp: 2,
      toolName: 'Read',
      toolUseId: 'child-call',
      parentToolUseId: 'call-1',
      toolStatus: 'executing',
    })

    const next = handleToolResult(state, {
      type: 'tool_result',
      sessionId: 'session-1',
      toolUseId: 'call-1',
      toolName: 'Task',
      result: 'Task was not started.',
      isError: false,
      executed: false,
      checkpoint: {
        schemaVersion: 1,
        kind: 'tool-call-budget',
        reason: 'Task was not started.',
      },
    })

    expect(next.session.messages[1]?.toolStatus).toBe('executing')
  })
})
