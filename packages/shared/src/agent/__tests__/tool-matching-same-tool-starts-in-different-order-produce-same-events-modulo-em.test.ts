/**
 * Tests for stateless tool matching logic.
 *
 * These tests verify that extractToolStarts() and extractToolResults() produce
 * deterministic output regardless of processing order. This is the core invariant
 * that makes the tool matching pipeline stateless.
 *
 * Key property under test: same SDK messages → same AgentEvents, regardless of order.
 */
import { describe, it, expect } from "bun:test";
import { ToolIndex, extractToolStarts, extractToolResults, type ContentBlock } from "../tool-matching";
import { makeToolResultBlock, makeToolUseBlock } from "./testing/tool-matching-fixture.ts";

describe('Determinism property', () => {
  it('same tool_starts in different order produce same events (modulo emission order)', () => {
    // Process blocks in order A, B, C
    const indexA = new ToolIndex()
    const emittedA = new Set<string>()
    const blocksA: ContentBlock[] = [
      makeToolUseBlock('Read', { file_path: '/a.ts' }, 'toolu_1'),
      makeToolUseBlock('Grep', { pattern: 'foo' }, 'toolu_2'),
      makeToolUseBlock('Bash', { command: 'ls', description: 'List' }, 'toolu_3'),
    ]
    const eventsA = extractToolStarts(blocksA, null, indexA, emittedA)

    // Process blocks in order C, A, B
    const indexB = new ToolIndex()
    const emittedB = new Set<string>()
    const blocksB: ContentBlock[] = [
      makeToolUseBlock('Bash', { command: 'ls', description: 'List' }, 'toolu_3'),
      makeToolUseBlock('Read', { file_path: '/a.ts' }, 'toolu_1'),
      makeToolUseBlock('Grep', { pattern: 'foo' }, 'toolu_2'),
    ]
    const eventsB = extractToolStarts(blocksB, null, indexB, emittedB)

    // Both should produce 3 events with same content (order follows input order)
    expect(eventsA).toHaveLength(3)
    expect(eventsB).toHaveLength(3)

    // Sort by toolUseId for comparison (order-independent)
    const sortById = (events: ReturnType<typeof extractToolStarts>) => events.map(event => {
      if (event.type !== 'tool_start') throw new Error('Expected a native tool-start event')
      return event
    }).sort((a, b) => a.toolUseId.localeCompare(b.toolUseId))
    const sortedA = sortById(eventsA)
    const sortedB = sortById(eventsB)

    for (let i = 0; i < 3; i++) {
      expect(sortedA[i]!.toolName).toBe(sortedB[i]!.toolName)
      expect(sortedA[i]!.toolUseId).toBe(sortedB[i]!.toolUseId)
      expect(sortedA[i]!.parentToolUseId).toBe(sortedB[i]!.parentToolUseId)
    }
  })

  it('out-of-order results always match to correct tool by ID', () => {
    // Setup: register tools
    const index = new ToolIndex()
    index.register('toolu_read', 'Read', { file_path: '/foo.ts' })
    index.register('toolu_grep', 'Grep', { pattern: 'bar' })
    index.register('toolu_bash', 'Bash', { command: 'ls' })

    // Results in order: Bash, Read, Grep
    const result1: ContentBlock[] = [makeToolResultBlock('toolu_bash', 'output1')]
    const result2: ContentBlock[] = [makeToolResultBlock('toolu_read', 'output2')]
    const result3: ContentBlock[] = [makeToolResultBlock('toolu_grep', 'output3')]

    const e1 = extractToolResults(result1, null, undefined, index)
    const e2 = extractToolResults(result2, null, undefined, index)
    const e3 = extractToolResults(result3, null, undefined, index)

    // Each result matches its own tool, not FIFO order
    expect(e1[0]).toMatchObject({ toolUseId: 'toolu_bash', toolName: 'Bash', result: 'output1' })
    expect(e2[0]).toMatchObject({ toolUseId: 'toolu_read', toolName: 'Read', result: 'output2' })
    expect(e3[0]).toMatchObject({ toolUseId: 'toolu_grep', toolName: 'Grep', result: 'output3' })

    // Now process in DIFFERENT order: Read, Grep, Bash
    const f1 = extractToolResults(result2, null, undefined, index)
    const f2 = extractToolResults(result3, null, undefined, index)
    const f3 = extractToolResults(result1, null, undefined, index)

    // Same results regardless of order!
    expect(f1[0]).toMatchObject({ toolUseId: 'toolu_read', toolName: 'Read', result: 'output2' })
    expect(f2[0]).toMatchObject({ toolUseId: 'toolu_grep', toolName: 'Grep', result: 'output3' })
    expect(f3[0]).toMatchObject({ toolUseId: 'toolu_bash', toolName: 'Bash', result: 'output1' })
  })

  it('concurrent Tasks: children assigned to correct parent by SDK field, not by timing', () => {
    const index = new ToolIndex()
    const emitted = new Set<string>()

    // Task1 starts
    const task1Blocks: ContentBlock[] = [
      makeToolUseBlock('Task', { prompt: 'search' }, 'toolu_task1'),
    ]
    extractToolStarts(task1Blocks, null, index, emitted)

    // Task2 starts
    const task2Blocks: ContentBlock[] = [
      makeToolUseBlock('Task', { prompt: 'build' }, 'toolu_task2'),
    ]
    extractToolStarts(task2Blocks, null, index, emitted)

    // Child1 of Task1 starts (SDK says parent = task1)
    const child1Blocks: ContentBlock[] = [
      makeToolUseBlock('Grep', { pattern: 'foo' }, 'toolu_child1'),
    ]
    const child1Events = extractToolStarts(child1Blocks, 'toolu_task1', index, emitted)

    expect(child1Events[0]).toMatchObject({
      toolName: 'Grep',
      parentToolUseId: 'toolu_task1',  // Correct: assigned to Task1
    })

    // Child2 of Task2 starts (SDK says parent = task2)
    const child2Blocks: ContentBlock[] = [
      makeToolUseBlock('Bash', { command: 'npm build' }, 'toolu_child2'),
    ]
    const child2Events = extractToolStarts(child2Blocks, 'toolu_task2', index, emitted)

    expect(child2Events[0]).toMatchObject({
      toolName: 'Bash',
      parentToolUseId: 'toolu_task2',  // Correct: assigned to Task2
    })

    // Results: child2 result arrives with its own tool_use_id
    const child2Result: ContentBlock[] = [
      makeToolResultBlock('toolu_child2', 'build complete'),
    ]
    const resultEvents = extractToolResults(child2Result, 'toolu_task2', undefined, index)

    expect(resultEvents[0]).toMatchObject({
      toolUseId: 'toolu_child2',
      toolName: 'Bash',
      parentToolUseId: 'toolu_task2',
    })
  })
});
