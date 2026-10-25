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
import { ev, makeAdapter, makeBinding, play } from "./testing/renderer-fixture.ts";

describe('Renderer — progress mode (default)', () => {
  let renderer: Renderer

  beforeEach(() => {
    renderer = new Renderer()
  })

  it('happy path: tool run → evolving bubble → final text edit', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding() // default = progress
    await play(renderer, binding, adapter, [
      ev.toolStart('Read'),
      ev.toolResult(),
      ev.final('The answer is 42.'),
      ev.complete(),
    ])

    // Exactly one send (the initial bubble) + edits for status transitions + final.
    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    expect(sends.length).toBe(1)
    expect(sends[0]!.text).toBe('🔧 Read…')

    const edits = adapter.calls.filter((c) => c.kind === 'editMessage')
    // tool_result → '💭 thinking…', then complete → final text.
    expect(edits.map((e) => e.text)).toEqual(['💭 thinking…', 'The answer is 42.'])
  })

  it('text-only run: one send + one edit with final', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding()
    await play(renderer, binding, adapter, [
      ev.delta('hello '),
      ev.delta('world'),
      ev.final('hello world'),
      ev.complete(),
    ])

    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    const edits = adapter.calls.filter((c) => c.kind === 'editMessage')
    expect(sends.length).toBe(1)
    expect(sends[0]!.text).toBe('💭 thinking…')
    expect(edits.length).toBe(1)
    expect(edits[0]!.text).toBe('hello world')
  })

  it('drops intermediate text — never appears in any message', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding()
    await play(renderer, binding, adapter, [
      ev.intermediate('I am thinking about the question'),
      ev.toolStart('Read'),
      ev.toolResult(),
      ev.final('Final: 42'),
      ev.complete(),
    ])

    const all = adapter.calls
      .filter((c) => c.kind === 'sendText' || c.kind === 'editMessage')
      .map((c) => c.text ?? '')
    expect(all.some((t) => t.includes('I am thinking'))).toBe(false)
    expect(all.some((t) => t.includes('Final: 42'))).toBe(true)
  })

  it('degrades to single send on complete for adapters without edit support', async () => {
    const adapter = makeAdapter({ messageEditing: false })
    const binding = makeBinding()
    await play(renderer, binding, adapter, [
      ev.toolStart('Read'),
      ev.toolResult(),
      ev.final('The answer is 42.'),
      ev.complete(),
    ])

    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    const edits = adapter.calls.filter((c) => c.kind === 'editMessage')
    // Bubble is posted (status only, cannot edit) + one final send via complete.
    expect(edits.length).toBe(0)
    expect(sends.map((s) => s.text)).toEqual(['🔧 Read…', 'The answer is 42.'])
  })

  it('tool-terminated run with no non-intermediate final → falls back to last assistant text', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding()
    // Automation pattern: agent narrates, calls a tool to deliver its result,
    // and never emits a clean non-intermediate final text_complete.
    await play(renderer, binding, adapter, [
      ev.intermediate('Sending the report now.'),
      ev.toolStart('SendTelegram'),
      ev.toolResult(),
      ev.complete(),
    ])

    const edits = adapter.calls.filter((c) => c.kind === 'editMessage')
    // Must NOT be left frozen on a status label; the last assistant text wins.
    expect(edits.at(-1)!.text).toBe('Sending the report now.')
    expect(edits.some((e) => e.text === '💭 thinking…')).toBe(true)
  })

  it('still leaves status in place when the run produced no assistant text at all', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding()
    await play(renderer, binding, adapter, [
      ev.toolStart('Read'),
      ev.toolResult(),
      ev.complete(),
    ])
    const all = adapter.calls
      .filter((c) => c.kind === 'sendText' || c.kind === 'editMessage')
      .map((c) => c.text ?? '')
    // No empty-string edit on complete (would trip Telegram "not modified").
    expect(all.every((t) => t.length > 0)).toBe(true)
  })

  it('collapses redundant status edits (same status twice = one edit total)', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding()
    await play(renderer, binding, adapter, [
      ev.toolStart('Read'),
      ev.toolResult(),
      ev.toolResult(), // duplicate → should NOT emit a second edit to thinking
      ev.final('done'),
      ev.complete(),
    ])

    const edits = adapter.calls.filter((c) => c.kind === 'editMessage')
    // thinking (from first tool_result) + final (from complete) = 2
    expect(edits.length).toBe(2)
    expect(edits[0]!.text).toBe('💭 thinking…')
    expect(edits[1]!.text).toBe('done')
  })
});
