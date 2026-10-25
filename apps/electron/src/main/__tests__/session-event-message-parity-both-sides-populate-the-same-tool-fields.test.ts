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
import type { Message } from "@craft-agent/core";
import { type ToolStartEvent, nextId } from "./testing/session-event-message-parity-fixture.ts";

describe('tool_start → tool Message field parity', () => {
  it('both sides populate the same tool fields', () => {
    const event: ToolStartEvent = {
      toolName: 'Read',
      toolUseId: 'tu-read-1',
      toolInput: { file_path: '/src/main.ts' },
      toolIntent: 'Reading the main file',
      toolDisplayName: 'Read File',
      toolDisplayMeta: { displayName: 'Read', category: 'native' },
      turnId: 'turn-3',
      parentToolUseId: 'tu-task-parent',
      timestamp: 1700000000000,
    }

    // Main process (sessions.ts tool_start — new message path)
    const mainMsg: Message = {
      id: nextId(),
      role: 'tool',
      content: `Running ${event.toolName}...`,
      timestamp: event.timestamp!,
      toolName: event.toolName,
      toolUseId: event.toolUseId,
      toolInput: event.toolInput,
      toolStatus: 'executing',
      toolIntent: event.toolIntent,
      toolDisplayName: event.toolDisplayName,
      toolDisplayMeta: event.toolDisplayMeta,
      turnId: event.turnId,
      parentToolUseId: event.parentToolUseId,
    }

    // Renderer (handleToolStart — new message path)
    const rendererMsg: Message = {
      id: nextId(),
      role: 'tool',
      content: '',
      timestamp: event.timestamp ?? Date.now(),
      toolUseId: event.toolUseId,
      toolName: event.toolName,
      toolInput: event.toolInput,
      toolStatus: 'executing',
      turnId: event.turnId,
      parentToolUseId: event.parentToolUseId,
      toolIntent: event.toolIntent,
      toolDisplayName: event.toolDisplayName,
      toolDisplayMeta: event.toolDisplayMeta,
    }

    // Core tool fields must match
    const toolFields = [
      'toolName', 'toolUseId', 'toolInput', 'toolStatus',
      'toolIntent', 'toolDisplayName', 'toolDisplayMeta',
      'turnId', 'parentToolUseId',
    ] as const

    for (const field of toolFields) {
      expect(mainMsg[field]).toEqual(rendererMsg[field])
    }
  })
});
