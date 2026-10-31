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
import { ToolIndex, extractToolResults, parseWorkflowIdFromTranscriptPath, type ContentBlock } from "../tool-matching";
import { makeToolResultBlock, resetCounters } from "./testing/tool-matching-fixture.ts";

describe('extractToolResults', () => {
  let toolIndex: ToolIndex

  beforeEach(() => {
    toolIndex = new ToolIndex()
    resetCounters()
  })

  it('matches tool result by explicit tool_use_id in content block', () => {
    // Register tool first (simulates prior tool_start)
    toolIndex.register('toolu_read1', 'Read', { file_path: '/foo.ts' })

    const blocks: ContentBlock[] = [
      makeToolResultBlock('toolu_read1', 'file contents here'),
    ]

    const events = extractToolResults(blocks, 'toolu_read1', undefined, toolIndex)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'toolu_read1',
      toolName: 'Read',
      result: 'file contents here',
      isError: false,
    })
  })

  it('matches out-of-order results correctly (no FIFO)', () => {
    // Register Read first, then Grep (order A → B)
    toolIndex.register('toolu_read', 'Read', { file_path: '/foo.ts' })
    toolIndex.register('toolu_grep', 'Grep', { pattern: 'bar' })

    // Grep result arrives FIRST (out of registration order)
    const grepResult: ContentBlock[] = [
      makeToolResultBlock('toolu_grep', '3 matches found'),
    ]
    const grepEvents = extractToolResults(grepResult, 'toolu_task1', undefined, toolIndex)

    expect(grepEvents).toHaveLength(1)
    expect(grepEvents[0]).toMatchObject({
      toolUseId: 'toolu_grep',
      toolName: 'Grep',
      result: '3 matches found',
    })

    // Read result arrives SECOND
    const readResult: ContentBlock[] = [
      makeToolResultBlock('toolu_read', 'file contents'),
    ]
    const readEvents = extractToolResults(readResult, 'toolu_task1', undefined, toolIndex)

    expect(readEvents).toHaveLength(1)
    expect(readEvents[0]).toMatchObject({
      toolUseId: 'toolu_read',
      toolName: 'Read',
      result: 'file contents',
    })
  })

  it('handles multiple tool_result blocks in one message', () => {
    toolIndex.register('toolu_1', 'Read', {})
    toolIndex.register('toolu_2', 'Grep', {})

    const blocks: ContentBlock[] = [
      makeToolResultBlock('toolu_1', 'content A'),
      makeToolResultBlock('toolu_2', 'content B'),
    ]

    const events = extractToolResults(blocks, null, undefined, toolIndex)

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ toolUseId: 'toolu_1', toolName: 'Read' })
    expect(events[1]).toMatchObject({ toolUseId: 'toolu_2', toolName: 'Grep' })
  })

  it('propagates isError from content block', () => {
    toolIndex.register('toolu_1', 'Bash', { command: 'exit 1' })

    const blocks: ContentBlock[] = [
      makeToolResultBlock('toolu_1', 'command failed', true),
    ]

    const events = extractToolResults(blocks, 'toolu_1', undefined, toolIndex)

    expect(events[0]).toMatchObject({
      toolUseId: 'toolu_1',
      isError: true,
    })
  })

  it('sets parentToolUseId from SDK parent_tool_use_id', () => {
    toolIndex.register('toolu_child', 'Read', {})

    const blocks: ContentBlock[] = [
      makeToolResultBlock('toolu_child', 'data'),
    ]

    // SDK says parent is toolu_task1
    const events = extractToolResults(blocks, 'toolu_task1', undefined, toolIndex)

    expect(events[0]).toMatchObject({
      parentToolUseId: 'toolu_task1',
    })
  })

  it('sets parentToolUseId to undefined when SDK parent is null', () => {
    toolIndex.register('toolu_1', 'Bash', {})

    const blocks: ContentBlock[] = [
      makeToolResultBlock('toolu_1', 'output'),
    ]

    const events = extractToolResults(blocks, null, undefined, toolIndex)
    expect(events[0]).toMatchObject({ parentToolUseId: undefined })
  })

  it('falls back to convenience fields when no content blocks', () => {
    toolIndex.register('toolu_1', 'Read', {})

    // No tool_result content blocks, but tool_use_result is present
    const events = extractToolResults([], 'toolu_1', 'file contents', toolIndex)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'toolu_1',
      toolName: 'Read',
      result: 'file contents',
    })
  })

  it('fallback path does not self-reference parentToolUseId', () => {
    // When content blocks are empty and we fall back to convenience fields,
    // parentToolUseId must NOT equal toolUseId (no self-referencing loop)
    toolIndex.register('toolu_1', 'Read', { file_path: '/foo.ts' })

    // No content blocks — triggers fallback. sdkParentToolUseId = 'toolu_1'
    const events = extractToolResults([], 'toolu_1', 'file contents', toolIndex)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'toolu_1',
      toolName: 'Read',
      result: 'file contents',
      // parentToolUseId must be undefined, not 'toolu_1' (self-reference)
      parentToolUseId: undefined,
    })
  })

  it('fallback path handles top-level tools without content blocks (sdkParentToolUseId=null)', () => {
    // Top-level tools have null parent_tool_use_id. Without content blocks,
    // the result must still be emitted (not silently dropped).
    const events = extractToolResults([], null, 'some output', toolIndex, 'turn_42')

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'fallback-turn_42',
      result: 'some output',
      parentToolUseId: undefined,
    })
  })

  it('fallback path generates stable synthetic ID without turnId', () => {
    // Edge case: no turnId and no sdkParentToolUseId
    const events = extractToolResults([], null, 'result data', toolIndex)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      toolUseId: 'fallback-unknown',
      result: 'result data',
    })
  })

  it('handles unknown tool (not in index)', () => {
    // No registration — tool_use_id doesn't exist in index
    const blocks: ContentBlock[] = [
      makeToolResultBlock('toolu_unknown', 'some result'),
    ]

    const events = extractToolResults(blocks, null, undefined, toolIndex)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      toolUseId: 'toolu_unknown',
      toolName: undefined,
      result: 'some result',
    })
  })

  it('serializes non-string results to JSON', () => {
    toolIndex.register('toolu_1', 'mcp__api', {})

    const blocks: ContentBlock[] = [
      makeToolResultBlock('toolu_1', { data: [1, 2, 3], status: 'ok' }),
    ]

    const events = extractToolResults(blocks, 'toolu_1', undefined, toolIndex)

    expect(events[0]).toMatchObject({
      result: JSON.stringify({ data: [1, 2, 3], status: 'ok' }, null, 2),
    })
  })

  it('passes turnId through to events', () => {
    toolIndex.register('toolu_1', 'Read', {})

    const blocks: ContentBlock[] = [
      makeToolResultBlock('toolu_1', 'data'),
    ]

    const events = extractToolResults(blocks, null, undefined, toolIndex, 'turn_xyz')
    expect(events[0]).toMatchObject({ turnId: 'turn_xyz' })
  })

  // --- Background event detection ---

  it('detects background Task from agentId in result when run_in_background is true', () => {
    toolIndex.register('toolu_task', 'Task', { _intent: 'Search codebase', run_in_background: true })

    const blocks: ContentBlock[] = [
      makeToolResultBlock('toolu_task', 'Done.\nagentId: abc123'),
    ]

    const events = extractToolResults(blocks, null, undefined, toolIndex)

    // Should have tool_result + task_backgrounded
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'tool_result', toolUseId: 'toolu_task' })
    expect(events[1]).toMatchObject({
      type: 'task_backgrounded',
      toolUseId: 'toolu_task',
      taskId: 'abc123',
      intent: 'Search codebase',
    })
  })

  it('does NOT emit task_backgrounded for foreground Agent with agentId in result', () => {
    // Foreground Agent tool (no run_in_background) — agentId in result should be ignored
    toolIndex.register('toolu_agent', 'Agent', { _intent: 'Explore codebase', prompt: 'Find auth code' })

    const blocks: ContentBlock[] = [
      makeToolResultBlock('toolu_agent', 'Found auth in /src/auth.ts\nagentId: fg_agent_xyz'),
    ]

    const events = extractToolResults(blocks, null, undefined, toolIndex)

    // Should ONLY have tool_result — no task_backgrounded
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'tool_result', toolUseId: 'toolu_agent' })
  })

  it('detects an async-by-default Agent launch (no run_in_background) via result signature', () => {
    // The SDK backgrounds Agent/Task automatically and returns a launch ack
    // WITHOUT run_in_background in the input. The "working in the background" +
    // output_file signature distinguishes it from a foreground agent that merely
    // mentions "agentId:".
    toolIndex.register('toolu_async', 'Agent', { _intent: 'Investigate Intercom data' })

    const asyncResult = [
      'Async agent launched successfully.',
      'agentId: async_agent_9f8e7d',
      'The agent is working in the background. You will be notified when it completes.',
      'output_file: /private/tmp/claude-501/proj/sess/tasks/async_agent_9f8e7d.output',
    ].join('\n')

    const blocks: ContentBlock[] = [
      makeToolResultBlock('toolu_async', asyncResult),
    ]

    const events = extractToolResults(blocks, null, undefined, toolIndex)

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'tool_result', toolUseId: 'toolu_async' })
    expect(events[1]).toMatchObject({
      type: 'task_backgrounded',
      toolUseId: 'toolu_async',
      taskId: 'async_agent_9f8e7d',
      intent: 'Investigate Intercom data',
    })
  })

  it('falls back to the Agent description for intent when _intent is absent', () => {
    // The built-in Agent/Task tool does not set `_intent`, but it carries a concise
    // `description` param. The chip should show that instead of the opaque agent ID.
    toolIndex.register('toolu_desc', 'Agent', { description: "Look up today's AI news", prompt: 'Search the web...' })

    const asyncResult = [
      'Async agent launched successfully.',
      'agentId: async_agent_desc1',
      'The agent is working in the background.',
      'output_file: /tmp/tasks/async_agent_desc1.output',
    ].join('\n')

    const blocks: ContentBlock[] = [
      makeToolResultBlock('toolu_desc', asyncResult),
    ]

    const events = extractToolResults(blocks, null, undefined, toolIndex)

    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      type: 'task_backgrounded',
      toolUseId: 'toolu_desc',
      taskId: 'async_agent_desc1',
      intent: "Look up today's AI news",
    })
  })

  it('prefers _intent over description when both are present on an Agent launch', () => {
    toolIndex.register('toolu_both', 'Agent', { _intent: 'Explicit intent', description: 'Short desc' })

    const asyncResult = [
      'Async agent launched successfully.',
      'agentId: async_agent_both1',
      'The agent is working in the background.',
      'output_file: /tmp/tasks/async_agent_both1.output',
    ].join('\n')

    const events = extractToolResults(
      [makeToolResultBlock('toolu_both', asyncResult)],
      null,
      undefined,
      toolIndex,
    )

    expect(events[1]).toMatchObject({ type: 'task_backgrounded', intent: 'Explicit intent' })
  })

  it('still ignores a foreground Agent that only mentions agentId (no async signature)', () => {
    // Guards against false positives: a foreground result quoting "agentId:" but
    // lacking the background phrasing / output_file must NOT be backgrounded.
    toolIndex.register('toolu_fg', 'Agent', { _intent: 'Explore', prompt: 'Find code' })

    const blocks: ContentBlock[] = [
      makeToolResultBlock('toolu_fg', 'The relevant agentId: abc123 is referenced in config.'),
    ]

    const events = extractToolResults(blocks, null, undefined, toolIndex)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'tool_result', toolUseId: 'toolu_fg' })
  })

  it('detects background Shell from shell_id in result', () => {
    toolIndex.register('toolu_bash', 'Bash', { command: 'npm test', description: 'Run tests' })

    const blocks: ContentBlock[] = [
      makeToolResultBlock('toolu_bash', 'shell_id: shell_456'),
    ]

    const events = extractToolResults(blocks, null, undefined, toolIndex)

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'tool_result' })
    expect(events[1]).toMatchObject({
      type: 'shell_backgrounded',
      toolUseId: 'toolu_bash',
      shellId: 'shell_456',
      intent: 'Run tests',
      command: 'npm test',
    })
  })

  it('parseWorkflowIdFromTranscriptPath extracts wf ids and ignores non-workflow paths', () => {
    expect(parseWorkflowIdFromTranscriptPath(
      '/x/.claude/projects/p/s/subagents/workflows/wf_ec253af1-05a/agent-a7cd.jsonl',
    )).toBe('wf_ec253af1-05a')
    // Trailing directory form (from the Workflow tool's "Transcript dir:" line)
    expect(parseWorkflowIdFromTranscriptPath('/x/s/subagents/workflows/wf_abc123')).toBe('wf_abc123')
    // Ordinary (non-workflow) sub-agent transcript → null
    expect(parseWorkflowIdFromTranscriptPath('/x/s/subagents/agent-deadbeef.jsonl')).toBeNull()
    expect(parseWorkflowIdFromTranscriptPath(undefined)).toBeNull()
  })

  it('detects a backgrounded Workflow launch and marks it kind=workflow', () => {
    toolIndex.register('toolu_wf', 'Workflow', {})

    const wfResult = [
      'Workflow launched in background. Task ID: w5jhmnljq',
      'Summary: Read-only sweep of PII tickets',
      'Transcript dir: /Users/x/.claude/projects/proj/sess/subagents/workflows/wf_ec253af1-05a',
      'Script file: /Users/x/.claude/projects/proj/sess/workflows/scripts/pii-wf_ec253af1-05a.js',
    ].join('\n')

    const events = extractToolResults([makeToolResultBlock('toolu_wf', wfResult)], null, undefined, toolIndex)

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'tool_result', toolUseId: 'toolu_wf' })
    expect(events[1]).toMatchObject({
      type: 'task_backgrounded',
      toolUseId: 'toolu_wf',
      taskId: 'w5jhmnljq',
      kind: 'workflow',
      intent: 'Read-only sweep of PII tickets',
      workflowId: 'wf_ec253af1-05a',
    })
  })

  it('does not mark an errored Workflow launch as backgrounded', () => {
    toolIndex.register('toolu_wferr', 'Workflow', {})
    const events = extractToolResults(
      [makeToolResultBlock('toolu_wferr', 'Workflow launch failed: syntax error', true)],
      null,
      undefined,
      toolIndex,
    )
    expect(events.some(e => e.type === 'task_backgrounded')).toBe(false)
  })
});
