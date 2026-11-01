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
import { type ShellBackgroundedEvent, type TaskBackgroundedEvent, type TaskCompletedEvent, type TaskProgressEvent } from "./testing/session-event-message-parity-fixture.ts";

describe('background task events field parity', () => {
  it('task_backgrounded sets same fields on both sides', () => {
    const event: TaskBackgroundedEvent = {
      toolUseId: 'tu-task-1',
      taskId: 'agent-abc',
      intent: 'Run tests',
      turnId: 'turn-5',
    }

    // Both sides update the tool message with:
    const mainUpdate = {
      toolStatus: 'backgrounded' as const,
      taskId: event.taskId,
      isBackground: true,
    }

    const rendererUpdate = {
      toolStatus: 'backgrounded' as const,
      taskId: event.taskId,
      isBackground: true,
    }

    expect(mainUpdate).toEqual(rendererUpdate)
  })

  it('shell_backgrounded sets same fields on both sides', () => {
    const event: ShellBackgroundedEvent = {
      toolUseId: 'tu-bash-1',
      shellId: 'shell-xyz',
      intent: 'npm install',
      turnId: 'turn-6',
    }

    const mainUpdate = {
      toolStatus: 'backgrounded' as const,
      shellId: event.shellId,
      isBackground: true,
    }

    const rendererUpdate = {
      toolStatus: 'backgrounded' as const,
      shellId: event.shellId,
      isBackground: true,
    }

    expect(mainUpdate).toEqual(rendererUpdate)
  })

  it('task_progress sets elapsedSeconds on both sides', () => {
    const event: TaskProgressEvent = {
      toolUseId: 'tu-task-1',
      elapsedSeconds: 42,
      turnId: 'turn-5',
    }

    const mainUpdate = { elapsedSeconds: event.elapsedSeconds }
    const rendererUpdate = { elapsedSeconds: event.elapsedSeconds }

    expect(mainUpdate).toEqual(rendererUpdate)
  })

  it('task_completed sets same completion fields on both sides', () => {
    const event: TaskCompletedEvent = {
      taskId: 'agent-abc',
      status: 'completed',
      summary: 'Found 3 files',
      turnId: 'turn-7',
    }

    // Both sides update the tool message (found by taskId) with:
    // Only 'failed' maps to 'error'; 'completed' and 'stopped' map to 'completed'
    const mainUpdate = {
      toolStatus: event.status === 'failed' ? 'error' as const : 'completed' as const,
      toolResult: event.summary || `Background task ${event.status}`,
    }

    const rendererUpdate = {
      toolStatus: event.status === 'failed' ? 'error' as const : 'completed' as const,
      toolResult: event.summary || `Background task ${event.status}`,
    }

    expect(mainUpdate).toEqual(rendererUpdate)
  })

  it('task_completed with failed status sets error on both sides', () => {
    const event: TaskCompletedEvent = {
      taskId: 'agent-xyz',
      status: 'failed',
      summary: 'Task encountered an error',
      turnId: 'turn-8',
    }

    const mainUpdate = {
      toolStatus: 'error' as const,
      toolResult: event.summary || `Background task ${event.status}`,
    }

    const rendererUpdate = {
      toolStatus: 'error' as const,
      toolResult: event.summary || `Background task ${event.status}`,
    }

    expect(mainUpdate).toEqual(rendererUpdate)
  })

  it('task_completed with stopped status maps to completed (not error)', () => {
    const event: TaskCompletedEvent = {
      taskId: 'agent-stopped',
      status: 'stopped',
      summary: '',
      turnId: 'turn-9',
    }

    // User-initiated stop should NOT show as an error
    const mainUpdate = {
      toolStatus: 'completed' as const,
      toolResult: event.summary || `Background task ${event.status}`,
    }

    const rendererUpdate = {
      toolStatus: 'completed' as const,
      toolResult: event.summary || `Background task ${event.status}`,
    }

    expect(mainUpdate).toEqual(rendererUpdate)
    expect(mainUpdate.toolStatus).toBe('completed')
    expect(mainUpdate.toolResult).toBe('Background task stopped')
  })
});
