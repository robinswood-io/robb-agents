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
import { ToolIndex, extractToolResults, type ContentBlock } from "../tool-matching";
import { makeToolResultBlock, resetCounters } from "./testing/tool-matching-fixture.ts";

describe('extractToolResults', () => {
  let toolIndex: ToolIndex

  beforeEach(() => {
    toolIndex = new ToolIndex()
    resetCounters()
  })

  it('detects KillShell events', () => {
    toolIndex.register('toolu_kill', 'KillShell', { shell_id: 'shell_789' })

    const blocks: ContentBlock[] = [
      makeToolResultBlock('toolu_kill', 'Shell killed'),
    ]

    const events = extractToolResults(blocks, null, undefined, toolIndex)

    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      type: 'shell_killed',
      shellId: 'shell_789',
    })
  })
});
