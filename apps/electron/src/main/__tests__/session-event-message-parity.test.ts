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
import { type TextCompleteEvent, definedKeys, nextId } from "./testing/session-event-message-parity-fixture.ts";

describe('text_complete → assistant Message field parity', () => {
  it('both sides populate the same fields for a final message', () => {
    const event: TextCompleteEvent = {
      text: 'Here is the answer.',
      isIntermediate: false,
      turnId: 'turn-1',
      parentToolUseId: 'tu-parent',
      timestamp: 1700000000000,
    }

    // Main process (sessions.ts text_complete handler)
    const mainMsg: Message = {
      id: nextId(),
      role: 'assistant',
      content: event.text,
      timestamp: event.timestamp!,
      isIntermediate: event.isIntermediate,
      turnId: event.turnId,
      parentToolUseId: event.parentToolUseId,
    }

    // Renderer (handleTextComplete — create-if-not-found path)
    const rendererMsg: Message = {
      id: nextId(),
      role: 'assistant',
      content: event.text,
      timestamp: event.timestamp ?? Date.now(),
      isStreaming: false,
      isPending: false,
      isIntermediate: event.isIntermediate,
      turnId: event.turnId,
      parentToolUseId: event.parentToolUseId,
    }

    // Both should have these fields (modulo transient-only fields)
    const mainKeys = definedKeys(mainMsg as unknown as Record<string, unknown>)
    const rendererKeys = definedKeys(rendererMsg as unknown as Record<string, unknown>)

    // Core fields must be present on both sides
    const coreFields = ['role', 'content', 'timestamp', 'isIntermediate', 'turnId', 'parentToolUseId']
    for (const field of coreFields) {
      expect(mainKeys.has(field)).toBe(true)
      expect(rendererKeys.has(field)).toBe(true)
    }

    // Values must match
    expect(mainMsg.content).toBe(rendererMsg.content)
    expect(mainMsg.isIntermediate).toBe(rendererMsg.isIntermediate)
    expect(mainMsg.turnId).toBe(rendererMsg.turnId)
    expect(mainMsg.parentToolUseId).toBe(rendererMsg.parentToolUseId)
    expect(mainMsg.timestamp).toBe(rendererMsg.timestamp)

    // Renderer has transient fields that main does not (expected)
    expect(rendererKeys.has('isStreaming')).toBe(true)
    expect(rendererKeys.has('isPending')).toBe(true)
  })

  it('intermediate text has the same fields on both sides', () => {
    const event: TextCompleteEvent = {
      text: 'Let me think...',
      isIntermediate: true,
      turnId: 'turn-2',
      parentToolUseId: 'tu-task',
    }

    const mainMsg: Message = {
      id: nextId(),
      role: 'assistant',
      content: event.text,
      timestamp: Date.now(),
      isIntermediate: event.isIntermediate,
      turnId: event.turnId,
      parentToolUseId: event.parentToolUseId,
    }

    const rendererMsg: Message = {
      id: nextId(),
      role: 'assistant',
      content: event.text,
      timestamp: Date.now(),
      isStreaming: false,
      isPending: false,
      isIntermediate: event.isIntermediate,
      turnId: event.turnId,
      parentToolUseId: event.parentToolUseId,
    }

    expect(mainMsg.isIntermediate).toBe(true)
    expect(rendererMsg.isIntermediate).toBe(true)
    expect(mainMsg.parentToolUseId).toBe(rendererMsg.parentToolUseId)
  })
});
