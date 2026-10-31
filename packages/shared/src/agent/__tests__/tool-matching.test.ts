/**
 * Tests for stateless tool matching logic.
 *
 * These tests verify that extractToolStarts() and extractToolResults() produce
 * deterministic output regardless of processing order. This is the core invariant
 * that makes the tool matching pipeline stateless.
 *
 * Key property under test: same SDK messages → same AgentEvents, regardless of order.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { ToolIndex } from "../tool-matching";
import { resetCounters } from "./testing/tool-matching-fixture.ts";

describe('ToolIndex', () => {
  let index: ToolIndex

  beforeEach(() => {
    index = new ToolIndex()
    resetCounters()
  })

  it('registers and looks up tools', () => {
    index.register('toolu_1', 'Read', { file_path: '/foo' })
    expect(index.getName('toolu_1')).toBe('Read')
    expect(index.getInput('toolu_1')).toEqual({ file_path: '/foo' })
    expect(index.has('toolu_1')).toBe(true)
  })

  it('returns undefined for unknown tools', () => {
    expect(index.getName('unknown')).toBeUndefined()
    expect(index.getInput('unknown')).toBeUndefined()
    expect(index.has('unknown')).toBe(false)
  })

  it('is idempotent — registering same ID twice keeps first entry', () => {
    index.register('toolu_1', 'Read', { file_path: '/foo' })
    index.register('toolu_1', 'Read', { file_path: '/bar' })
    // First non-empty registration wins
    expect(index.getInput('toolu_1')).toEqual({ file_path: '/foo' })
  })

  it('upgrades empty input to complete input', () => {
    // Stream events register with empty input first
    index.register('toolu_1', 'Read', {})
    expect(index.getInput('toolu_1')).toEqual({})

    // Assistant message arrives with complete input
    index.register('toolu_1', 'Read', { file_path: '/foo' })
    expect(index.getInput('toolu_1')).toEqual({ file_path: '/foo' })
  })

  it('is order-independent — same entries regardless of insertion order', () => {
    const indexA = new ToolIndex()
    indexA.register('toolu_1', 'Read', { file_path: '/foo' })
    indexA.register('toolu_2', 'Bash', { command: 'ls' })

    const indexB = new ToolIndex()
    indexB.register('toolu_2', 'Bash', { command: 'ls' })
    indexB.register('toolu_1', 'Read', { file_path: '/foo' })

    expect(indexA.getName('toolu_1')).toBe(indexB.getName('toolu_1'))
    expect(indexA.getName('toolu_2')).toBe(indexB.getName('toolu_2'))
    expect(indexA.getInput('toolu_1')).toEqual(indexB.getInput('toolu_1'))
    expect(indexA.getInput('toolu_2')).toEqual(indexB.getInput('toolu_2'))
  })

  it('tracks size correctly', () => {
    expect(index.size).toBe(0)
    index.register('toolu_1', 'Read', {})
    expect(index.size).toBe(1)
    index.register('toolu_2', 'Bash', {})
    expect(index.size).toBe(2)
    // Re-registering same ID doesn't increase size
    index.register('toolu_1', 'Read', { file_path: '/foo' })
    expect(index.size).toBe(2)
  })
});
