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
import { describe, expect, it, beforeEach } from "bun:test";
import { Renderer } from "../renderer";
import { type ResponseMode } from "../types";
import { ev, makeAdapter, makeBinding, play } from "./testing/renderer-fixture.ts";

describe('Renderer — streaming mode (legacy)', () => {
  let renderer: Renderer

  beforeEach(() => {
    renderer = new Renderer()
  })

  it('each text_complete finalises its own message (legacy behaviour)', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding({ responseMode: 'streaming' as ResponseMode })
    await play(renderer, binding, adapter, [
      ev.delta('first'),
      ev.completeText('first'),
      ev.delta('second'),
      ev.completeText('second'),
      ev.complete(),
    ])

    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    // Two separate messages, one per text_complete cycle.
    expect(sends.length).toBe(2)
    expect(sends[0]!.text).toBe('first')
    expect(sends[1]!.text).toBe('second')
  })
});
