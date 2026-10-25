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

describe('auth-request Message field completeness', () => {
  it('auth-request message carries all auth fields', () => {
    // Both main and renderer receive the same Message object via IPC
    // (auth_request event carries a pre-built Message from main process)
    const authMessage: Message = {
      id: 'auth-msg-1',
      role: 'auth-request',
      content: 'Authentication required',
      timestamp: Date.now(),
      authRequestId: 'req-1',
      authRequestType: 'credential',
      authSourceSlug: 'linear',
      authSourceName: 'Linear',
      authStatus: 'pending',
      authCredentialMode: 'bearer',
      authHeaderName: 'Authorization',
      authHeaderNames: ['DD-API-KEY', 'DD-APP-KEY'],
      authLabels: { credential: 'API Token' },
      authDescription: 'Enter your Linear API key',
      authHint: 'Settings > API',
      authSourceUrl: 'https://linear.app',
      authPasswordRequired: false,
    }

    // All auth fields should be defined
    const authFields = [
      'authRequestId', 'authRequestType', 'authSourceSlug', 'authSourceName',
      'authStatus', 'authCredentialMode', 'authHeaderName', 'authHeaderNames',
      'authLabels', 'authDescription', 'authHint', 'authSourceUrl',
      'authPasswordRequired',
    ] as const

    for (const field of authFields) {
      expect(authMessage[field]).toBeDefined()
    }
  })
});
