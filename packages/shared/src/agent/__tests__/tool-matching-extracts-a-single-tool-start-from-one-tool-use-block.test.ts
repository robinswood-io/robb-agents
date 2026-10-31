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
import { ToolIndex, extractToolStarts, type ContentBlock } from "../tool-matching";
import { toolMetadataStore } from "../../interceptor-common";
import { makeToolUseBlock, resetCounters } from "./testing/tool-matching-fixture.ts";

describe('extractToolStarts', () => {
  let toolIndex: ToolIndex

  let emittedIds: Set<string>

  beforeEach(() => {
    toolIndex = new ToolIndex()
    emittedIds = new Set()
    resetCounters()
  })

  it('extracts a single tool_start from one tool_use block', () => {
    const blocks: ContentBlock[] = [
      makeToolUseBlock('Read', { file_path: '/foo.ts' }, 'toolu_read1'),
    ]

    const events = extractToolStarts(blocks, null, toolIndex, emittedIds)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'tool_start',
      toolName: 'Read',
      toolUseId: 'toolu_read1',
      input: { file_path: '/foo.ts' },
      parentToolUseId: undefined,
    })
  })

  it('sets parentToolUseId from SDK parent_tool_use_id (top-level = undefined)', () => {
    const blocks: ContentBlock[] = [makeToolUseBlock('Grep', {}, 'toolu_1')]
    const events = extractToolStarts(blocks, null, toolIndex, emittedIds)

    expect(events[0]).toMatchObject({
      parentToolUseId: undefined,
    })
  })

  it('sets parentToolUseId from SDK parent_tool_use_id (subagent child)', () => {
    const blocks: ContentBlock[] = [makeToolUseBlock('Grep', {}, 'toolu_child1')]
    const events = extractToolStarts(blocks, 'toolu_task1', toolIndex, emittedIds)

    expect(events[0]).toMatchObject({
      parentToolUseId: 'toolu_task1',
    })
  })

  it('extracts multiple tool_starts from one message', () => {
    const blocks: ContentBlock[] = [
      makeToolUseBlock('Read', { file_path: '/a.ts' }, 'toolu_1'),
      makeToolUseBlock('Read', { file_path: '/b.ts' }, 'toolu_2'),
      makeToolUseBlock('Grep', { pattern: 'foo' }, 'toolu_3'),
    ]

    const events = extractToolStarts(blocks, null, toolIndex, emittedIds)

    expect(events).toHaveLength(3)
    expect(events[0]).toMatchObject({ toolName: 'Read', toolUseId: 'toolu_1' })
    expect(events[1]).toMatchObject({ toolName: 'Read', toolUseId: 'toolu_2' })
    expect(events[2]).toMatchObject({ toolName: 'Grep', toolUseId: 'toolu_3' })
  })

  it('deduplicates stream + assistant events (same tool_use_id)', () => {
    const blocks: ContentBlock[] = [
      makeToolUseBlock('Read', { file_path: '/foo.ts' }, 'toolu_1'),
    ]

    // First call (from stream_event)
    const events1 = extractToolStarts(blocks, null, toolIndex, emittedIds)
    expect(events1).toHaveLength(1)

    // Second call (from assistant message) — same ID, but now with complete input
    const events2 = extractToolStarts(blocks, null, toolIndex, emittedIds)
    // Should re-emit with complete input since input is non-empty
    expect(events2).toHaveLength(1)
    expect(events2[0]).toMatchObject({ toolUseId: 'toolu_1' })
  })

  it('deduplicates when stream had empty input and assistant has full input', () => {
    const streamBlocks: ContentBlock[] = [
      makeToolUseBlock('Read', {}, 'toolu_1'),
    ]
    const assistantBlocks: ContentBlock[] = [
      makeToolUseBlock('Read', { file_path: '/foo.ts' }, 'toolu_1'),
    ]

    // Stream event: empty input
    const events1 = extractToolStarts(streamBlocks, null, toolIndex, emittedIds)
    expect(events1).toHaveLength(1)
    expect(events1[0]).toMatchObject({ input: {} })

    // Assistant message: full input — should re-emit with complete data
    const events2 = extractToolStarts(assistantBlocks, null, toolIndex, emittedIds)
    expect(events2).toHaveLength(1)
    expect(events2[0]).toMatchObject({ input: { file_path: '/foo.ts' } })
  })

  it('re-emits duplicate empty-input tool_start when metadata arrives late', () => {
    const toolUseId = 'toolu_browser_1'
    const streamBlocks: ContentBlock[] = [
      makeToolUseBlock('mcp__session__browser_open', {}, toolUseId),
    ]

    try {
      // First stream event with empty input and no stored metadata
      const events1 = extractToolStarts(streamBlocks, null, toolIndex, emittedIds)
      expect(events1).toHaveLength(1)
      expect(events1[0]).toMatchObject({
        toolUseId,
        input: {},
        intent: undefined,
        displayName: undefined,
      })

      // Metadata is captured later by interceptor/store
      toolMetadataStore.set(toolUseId, {
        intent: 'Open the in-app browser window',
        displayName: 'Open Browser',
        timestamp: Date.now(),
      })

      // Duplicate assistant event still has empty input for browser_open,
      // but should re-emit now that metadata is available.
      const events2 = extractToolStarts(streamBlocks, null, toolIndex, emittedIds)
      expect(events2).toHaveLength(1)
      expect(events2[0]).toMatchObject({
        toolUseId,
        input: {},
        intent: 'Open the in-app browser window',
        displayName: 'Open Browser',
      })
    } finally {
      toolMetadataStore.delete(toolUseId)
    }
  })

  it('registers tools in the index', () => {
    const blocks: ContentBlock[] = [
      makeToolUseBlock('Read', { file_path: '/foo.ts' }, 'toolu_1'),
    ]

    extractToolStarts(blocks, null, toolIndex, emittedIds)

    expect(toolIndex.has('toolu_1')).toBe(true)
    expect(toolIndex.getName('toolu_1')).toBe('Read')
    expect(toolIndex.getInput('toolu_1')).toEqual({ file_path: '/foo.ts' })
  })

  it('extracts intent from _intent field', () => {
    const blocks: ContentBlock[] = [
      makeToolUseBlock('Grep', { pattern: 'foo', _intent: 'Find usages of foo' }, 'toolu_1'),
    ]

    const events = extractToolStarts(blocks, null, toolIndex, emittedIds)
    expect(events[0]).toMatchObject({ intent: 'Find usages of foo' })
  })

  it('extracts intent from Bash description field', () => {
    const blocks: ContentBlock[] = [
      makeToolUseBlock('Bash', { command: 'ls', description: 'List files' }, 'toolu_1'),
    ]

    const events = extractToolStarts(blocks, null, toolIndex, emittedIds)
    expect(events[0]).toMatchObject({ intent: 'List files' })
  })

  it('extracts displayName from _displayName field', () => {
    const blocks: ContentBlock[] = [
      makeToolUseBlock('mcp__craft__search', { _displayName: 'Search Docs', _intent: 'Find docs' }, 'toolu_1'),
    ]

    const events = extractToolStarts(blocks, null, toolIndex, emittedIds)
    expect(events[0]).toMatchObject({ displayName: 'Search Docs' })
  })

  it('passes turnId through to events', () => {
    const blocks: ContentBlock[] = [makeToolUseBlock('Read', {}, 'toolu_1')]
    const events = extractToolStarts(blocks, null, toolIndex, emittedIds, 'turn_abc')

    expect(events[0]).toMatchObject({ turnId: 'turn_abc' })
  })

  it('ignores non-tool_use blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Hello world' } as ContentBlock,
      makeToolUseBlock('Read', {}, 'toolu_1'),
      { type: 'thinking', thinking: '...' } as ContentBlock,
    ]

    const events = extractToolStarts(blocks, null, toolIndex, emittedIds)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ toolName: 'Read' })
  })

  // --- Fallback parent assignment (when SDK parent_tool_use_id is null) ---

  it('assigns fallback parent when SDK parent is null and exactly one Task is active', () => {
    const activeParents = new Set(['toolu_task1'])

    const blocks: ContentBlock[] = [
      makeToolUseBlock('Grep', { pattern: 'foo' }, 'toolu_child1'),
    ]

    // SDK says parent is null, but we have one active Task
    const events = extractToolStarts(blocks, null, toolIndex, emittedIds, undefined, activeParents)

    expect(events[0]).toMatchObject({
      toolName: 'Grep',
      toolUseId: 'toolu_child1',
      parentToolUseId: 'toolu_task1',  // Fallback assigned
    })
  })

  it('does not assign fallback when SDK provides explicit parent', () => {
    const activeParents = new Set(['toolu_task1'])

    const blocks: ContentBlock[] = [
      makeToolUseBlock('Read', {}, 'toolu_child2'),
    ]

    // SDK says parent is toolu_task2 (different from activeParents)
    const events = extractToolStarts(blocks, 'toolu_task2', toolIndex, emittedIds, undefined, activeParents)

    expect(events[0]).toMatchObject({
      parentToolUseId: 'toolu_task2',  // SDK value takes precedence
    })
  })

  it('does not assign fallback when multiple Tasks are active (ambiguous)', () => {
    const activeParents = new Set(['toolu_taskA', 'toolu_taskB'])

    const blocks: ContentBlock[] = [
      makeToolUseBlock('Bash', { command: 'ls' }, 'toolu_child'),
    ]

    // SDK says null, but multiple Tasks are active — can't safely assign
    const events = extractToolStarts(blocks, null, toolIndex, emittedIds, undefined, activeParents)

    expect(events[0]).toMatchObject({
      parentToolUseId: undefined,  // Not assigned — ambiguous
    })
  })

  it('does not assign fallback when no Tasks are active', () => {
    const activeParents = new Set<string>()

    const blocks: ContentBlock[] = [
      makeToolUseBlock('Read', {}, 'toolu_1'),
    ]

    const events = extractToolStarts(blocks, null, toolIndex, emittedIds, undefined, activeParents)

    expect(events[0]).toMatchObject({
      parentToolUseId: undefined,  // No active Tasks
    })
  })

  it('does not self-reference Task tool as its own parent', () => {
    // When a Task tool starts, it should NOT be assigned as its own parent
    const activeParents = new Set(['toolu_task1'])

    const blocks: ContentBlock[] = [
      makeToolUseBlock('Task', { prompt: 'nested' }, 'toolu_task1'),
    ]

    const events = extractToolStarts(blocks, null, toolIndex, emittedIds, undefined, activeParents)

    expect(events[0]).toMatchObject({
      toolName: 'Task',
      toolUseId: 'toolu_task1',
      parentToolUseId: undefined,  // Not self-referencing
    })
  })

  it('activeParentTools parameter is optional (backward compatible)', () => {
    const blocks: ContentBlock[] = [
      makeToolUseBlock('Read', {}, 'toolu_1'),
    ]

    // Call without activeParentTools parameter
    const events = extractToolStarts(blocks, null, toolIndex, emittedIds)

    expect(events[0]).toMatchObject({
      toolName: 'Read',
      parentToolUseId: undefined,
    })
  })
});
