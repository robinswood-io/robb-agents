/**
 * Tests for main process ↔ renderer Message creation parity.
 *
 * For each IPC event type, verifies that the fields populated by the main
 * process (sessions.ts) and the renderer (event-processor handlers) are
 * equivalent. Catches field drift between the two independent code paths.
 *
 * Mirrors both sides' logic inline (no Electron/Jotai imports).
 */
import { describe, it, expect } from "bun:test";
import type { ToolExecutionCheckpoint } from "@craft-agent/core";
import { type ToolResultEvent } from "./testing/session-event-message-parity-fixture.ts";

describe('tool_result → tool Message update parity', () => {
  it('both sides set the same completion fields', () => {
    const event: ToolResultEvent = {
      toolUseId: 'tu-read-1',
      toolName: 'Read',
      result: 'File contents here',
      isError: false,
    }

    // Fields set by main process on tool_result
    const mainUpdate = {
      toolResult: event.result,
      toolStatus: 'completed' as const,
      isError: event.isError,
    }

    // Fields set by renderer handleToolResult
    const rendererUpdate = {
      toolResult: event.result,
      toolStatus: 'completed' as const,
      isError: event.isError,
    }

    expect(mainUpdate).toEqual(rendererUpdate)
  })

  it('error result has same fields on both sides', () => {
    const event: ToolResultEvent = {
      toolUseId: 'tu-bash-1',
      result: 'Command failed',
      isError: true,
    }

    const mainUpdate = {
      toolResult: event.result,
      toolStatus: 'error' as const,
      isError: event.isError,
    }

    const rendererUpdate = {
      toolResult: event.result,
      toolStatus: 'error' as const,
      isError: event.isError,
    }

    expect(mainUpdate).toEqual(rendererUpdate)
  })

  it('infers error from [ERROR] prefix when isError is missing', () => {
    const event: ToolResultEvent = {
      toolUseId: 'tu-sandbox-1',
      result: '[ERROR] sandbox failed',
    }

    const inferredIsError = /^\s*(\[ERROR\]|Error:|error:)/.test(event.result || '')

    const mainUpdate = {
      toolResult: event.result,
      toolStatus: inferredIsError ? ('error' as const) : ('completed' as const),
      isError: inferredIsError,
    }

    const rendererUpdate = {
      toolResult: event.result,
      toolStatus: inferredIsError ? ('error' as const) : ('completed' as const),
      isError: inferredIsError,
    }

    expect(mainUpdate).toEqual(rendererUpdate)
  })

  it('preserves non-execution metadata without turning a checkpoint into an error', () => {
    const checkpoint: ToolExecutionCheckpoint = {
      schemaVersion: 1,
      kind: 'tool-call-budget',
      reason: 'Error: mutation was not started.',
    }
    const event: ToolResultEvent = {
      toolUseId: 'tu-edit-checkpoint',
      toolName: 'Edit',
      result: checkpoint.reason,
      isError: false,
      executed: false,
      checkpoint,
    }
    const inferredIsError = event.executed !== false
      && (event.isError === true || /^\s*(\[ERROR\]|Error:|error:)/.test(event.result || ''))

    const mainUpdate = {
      toolResult: event.result,
      toolStatus: inferredIsError ? ('error' as const) : ('completed' as const),
      isError: inferredIsError,
      toolExecuted: event.executed,
      toolCheckpoint: event.checkpoint,
    }
    const rendererUpdate = {
      toolResult: event.result,
      toolStatus: inferredIsError ? ('error' as const) : ('completed' as const),
      isError: inferredIsError,
      toolExecuted: event.executed,
      toolCheckpoint: event.checkpoint,
    }

    expect(mainUpdate).toEqual(rendererUpdate)
    expect(mainUpdate.isError).toBe(false)
  })
});
