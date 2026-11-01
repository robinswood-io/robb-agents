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

describe('Renderer — final_only mode', () => {
  let renderer: Renderer

  beforeEach(() => {
    renderer = new Renderer()
  })

  it('happy path: silent until complete, one send with concatenated final text', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding({ responseMode: 'final_only' as ResponseMode })
    await play(renderer, binding, adapter, [
      ev.toolStart('Read'),
      ev.toolResult(),
      ev.final('Part 1.'),
      ev.final('Part 2.'),
      ev.complete(),
    ])

    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    const edits = adapter.calls.filter((c) => c.kind === 'editMessage')
    expect(edits.length).toBe(0)
    expect(sends.length).toBe(1)
    expect(sends[0]!.text).toBe('Part 1.\n\nPart 2.')
  })

  it('empty completion: no send at all', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding({ responseMode: 'final_only' as ResponseMode })
    await play(renderer, binding, adapter, [ev.toolStart('Read'), ev.toolResult(), ev.complete()])
    expect(adapter.calls.length).toBe(0)
  })

  it('tool-terminated run with only intermediate text → still sends the last assistant text', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding({ responseMode: 'final_only' as ResponseMode })
    await play(renderer, binding, adapter, [
      ev.intermediate('Here is the summary you asked for.'),
      ev.toolStart('SendTelegram'),
      ev.toolResult(),
      ev.complete(),
    ])

    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    expect(sends.length).toBe(1)
    expect(sends[0]!.text).toBe('Here is the summary you asked for.')
  })

  it('non-intermediate final is preferred over earlier intermediate text', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding({ responseMode: 'final_only' as ResponseMode })
    await play(renderer, binding, adapter, [
      ev.intermediate('thinking out loud'),
      ev.final('The real answer.'),
      ev.complete(),
    ])

    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    expect(sends.length).toBe(1)
    expect(sends[0]!.text).toBe('The real answer.')
  })

  it('treats text_complete without isIntermediate as final (backwards compat)', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding({ responseMode: 'final_only' as ResponseMode })
    await play(renderer, binding, adapter, [ev.completeText('legacy-shape-text'), ev.complete()])

    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    expect(sends.length).toBe(1)
    expect(sends[0]!.text).toBe('legacy-shape-text')
  })
});
