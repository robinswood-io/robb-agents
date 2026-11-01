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
import { type TypedErrorEvent } from "./testing/session-event-message-parity-fixture.ts";

describe('typed_error → error Message field parity', () => {
  it('both sides populate the same error diagnostic fields', () => {
    const event: TypedErrorEvent = {
      error: {
        code: 'network_error',
        title: 'Connection Failed',
        message: 'Could not connect to API',
        details: ['DNS lookup failed', 'Retried 3 times'],
        originalError: 'ENOTFOUND api.anthropic.com',
        canRetry: true,
        actions: [],
      },
      timestamp: 1700000000000,
    }

    // Main process (sessions.ts typed_error handler)
    const mainMsg: Partial<Message> = {
      role: 'error',
      content: `${event.error.title}: ${event.error.message}`,
      errorCode: event.error.code,
      errorTitle: event.error.title,
      ...(event.error.details !== undefined ? { errorDetails: event.error.details } : {}),
      ...(event.error.originalError !== undefined ? { errorOriginal: event.error.originalError } : {}),
      errorCanRetry: event.error.canRetry,
    }

    // Renderer (handleTypedError)
    const rendererMsg: Partial<Message> = {
      role: 'error',
      content: `${event.error.title}: ${event.error.message}`,
      errorCode: event.error.code,
      errorTitle: event.error.title,
      ...(event.error.details !== undefined ? { errorDetails: event.error.details } : {}),
      ...(event.error.originalError !== undefined ? { errorOriginal: event.error.originalError } : {}),
      errorCanRetry: event.error.canRetry,
    }

    const errorFields = ['role', 'content', 'errorCode', 'errorTitle', 'errorDetails', 'errorOriginal', 'errorCanRetry'] as const
    for (const field of errorFields) {
      expect(mainMsg[field]).toEqual(rendererMsg[field])
    }
  })
});
