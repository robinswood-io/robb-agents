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
import { ev, makeAdapter, makeBinding, play } from "./testing/renderer-fixture.ts";

describe('Renderer — permissions and errors', () => {
  it('permission_request sends buttons in chat channel', async () => {
    const renderer = new Renderer()
    const adapter = makeAdapter()
    const binding = makeBinding({ approvalChannel: 'chat' })
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
    const buttons = adapter.calls.filter((c) => c.kind === 'sendButtons')
    expect(buttons.length).toBe(1)
  })

  it('permission_request fires recordPermissionMessage with the rendering binding, requestId, messageId', async () => {
    const recorded: Array<{ bindingId: string; sessionId: string; requestId: string; messageId: string }> = []
    const renderer = new Renderer({
      recordPermissionMessage: (b, requestId, messageId) => {
        recorded.push({
          bindingId: b.id,
          sessionId: b.sessionId,
          requestId,
          messageId,
        })
      },
    })
    const adapter = makeAdapter()
    const binding = makeBinding({ approvalChannel: 'chat' })
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

    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.bindingId).toBe(binding.id)
    expect(recorded[0]?.sessionId).toBe(binding.sessionId)
    expect(recorded[0]?.requestId).toBe('r1')
    expect(recorded[0]?.messageId).toBeTruthy()
  })

  it('error event emits ❌ message and resets state', async () => {
    const renderer = new Renderer()
    const adapter = makeAdapter()
    const binding = makeBinding()
    await play(renderer, binding, adapter, [
      ev.toolStart('Read'),
      { type: 'error', sessionId: 's', error: 'boom' } as SessionEvent,
      ev.complete(), // should be a no-op after reset
    ])
    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    // First send: the progress bubble. Second send: the error message.
    expect(sends.length).toBe(2)
    expect(sends[1]!.text).toContain('❌')
    expect(sends[1]!.text).toContain('boom')
  })
});
