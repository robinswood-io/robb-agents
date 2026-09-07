import { describe, expect, it } from 'bun:test'
import { handleToolResult } from '../tool'
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
