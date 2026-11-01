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
import { Renderer } from "../renderer";
import { ev, makeAdapter, makeBinding, play } from "./testing/renderer-fixture.ts";

describe('Renderer — legacy config coercion', () => {
  it('streamResponses=true with no responseMode → streaming behaviour', async () => {
    const renderer = new Renderer()
    const adapter = makeAdapter()
    const binding = makeBinding()
    // Simulate a legacy binding (responseMode field absent).
    expect(Reflect.deleteProperty(binding.config, 'responseMode')).toBe(true)
    expect(Object.hasOwn(binding.config, 'responseMode')).toBe(false)
    binding.config.streamResponses = true

    await play(renderer, binding, adapter, [ev.completeText('hi'), ev.complete()])

    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    expect(sends.length).toBe(1)
    expect(sends[0]!.text).toBe('hi')
  })

  it('streamResponses=false with no responseMode → final_only behaviour', async () => {
    const renderer = new Renderer()
    const adapter = makeAdapter()
    const binding = makeBinding()
    expect(Reflect.deleteProperty(binding.config, 'responseMode')).toBe(true)
    expect(Object.hasOwn(binding.config, 'responseMode')).toBe(false)
    binding.config.streamResponses = false

    await play(renderer, binding, adapter, [
      ev.toolStart('Read'),
      ev.toolResult(),
      ev.final('done'),
      ev.complete(),
    ])

    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    const edits = adapter.calls.filter((c) => c.kind === 'editMessage')
    expect(edits.length).toBe(0)
    expect(sends.length).toBe(1)
    expect(sends[0]!.text).toBe('done')
  })
});
