/**
 * Renderer tests — covers the three response modes.
 *
 *   - `streaming`: legacy behaviour, each text_complete finalises its own
 *     message; backwards-compatibility target.
 *   - `progress`: new default; single evolving message per run, intermediate
 *     text dropped, tool status reflected in-place.
 *   - `final_only`: silent until `complete`; single send with accumulated
 *     final text, no send if buffer is empty.
 *
 * Permissions and errors are mode-agnostic and tested separately.
 */
import { describe, expect, it } from "bun:test";
import { Renderer, type SessionEvent } from "../renderer";
import { makeAdapter, makeBinding } from "./testing/renderer-fixture.ts";

describe('Renderer — WhatsApp desktop-only approvals', () => {
  it('permission_request on WhatsApp sends an informational desktop-only message', async () => {
    const renderer = new Renderer()
    const adapter = makeAdapter({ inlineButtons: false, messageEditing: false, markdown: 'whatsapp' }, 'whatsapp')
    const binding = {
      ...makeBinding({ approvalChannel: 'chat' }),
      platform: 'whatsapp' as const,
      channelId: 'wa-1',
    }

    await renderer.handle(
      {
        type: 'permission_request',
        sessionId: 's',
        request: {
          requestId: 'r1',
          toolName: 'bash',
          description: 'run tests',
        },
      } as SessionEvent,
      binding,
      adapter,
    )

    expect(adapter.calls.filter((c) => c.kind === 'sendButtons')).toHaveLength(0)
    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    expect(sends).toHaveLength(1)
    expect(sends[0]!.text).toContain('desktop app')
  })

  it('plan_submitted on WhatsApp sends an informational desktop-only message', async () => {
    const renderer = new Renderer()
    const adapter = makeAdapter({ inlineButtons: false, messageEditing: false, markdown: 'whatsapp' }, 'whatsapp')
    const binding = {
      ...makeBinding(),
      platform: 'whatsapp' as const,
      channelId: 'wa-1',
    }

    await renderer.handle(
      {
        type: 'plan_submitted',
        sessionId: 's',
        message: { id: 'm1', role: 'assistant', content: 'Plan ready', timestamp: 1 },
      } as SessionEvent,
      binding,
      adapter,
    )

    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    expect(sends).toHaveLength(1)
    expect(sends[0]!.text).toContain('plan is ready')
    expect(sends[0]!.text).toContain('desktop app')
  })
});
