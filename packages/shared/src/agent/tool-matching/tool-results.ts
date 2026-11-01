/**
 * Stateless tool matching for SDK message → AgentEvent conversion.
 *
 * This module extracts tool_start and tool_result events from SDK message
 * content blocks using DIRECT ID matching instead of FIFO queues.
 *
 * Key principle: Every output is derived from the current message + an
 * append-only tool index. No mutable queues, stacks, or order-dependent state.
 *
 * The SDK provides:
 * - `parent_tool_use_id` on every message — identifies the subagent context (Task ID or null)
 * - `tool_use_id` on each tool_result content block — directly identifies which tool the result is for
 *
 * Together these eliminate the need for FIFO matching, parent stacks, and orphan recovery.
 */
import type { AgentEvent } from "@craft-agent/core/types";
import { detectBackgroundEvents } from './background-events.ts';
import { isToolResultError, serializeResult } from './tool-metadata.ts';
import type { ContentBlock, ToolResultBlock } from './transcript.ts';
import { ToolIndex } from './transcript.ts';

/**
 * Extract tool_result events from user message content blocks.
 *
 * Each tool_result content block carries an explicit `tool_use_id` that
 * directly identifies which tool the result belongs to. No FIFO matching needed.
 *
 * Falls back to the convenience field `tool_use_result` + `parent_tool_use_id`
 * when content blocks don't contain tool_result entries (e.g., some MCP tools).
 *
 * @param contentBlocks - Content blocks from SDKUserMessage.message.content (may be empty)
 * @param sdkParentToolUseId - parent_tool_use_id from the SDK message
 * @param toolUseResultValue - Convenience field tool_use_result from SDK message
 * @param toolIndex - Read-only lookup for tool name/input
 * @param turnId - Current turn correlation ID
 * @returns Array of tool_result AgentEvents (and background task events)
 */
export function extractToolResults(
  contentBlocks: ContentBlock[],
  sdkParentToolUseId: string | null,
  toolUseResultValue: unknown,
  toolIndex: ToolIndex,
  turnId?: string,
): AgentEvent[] {
  const events: AgentEvent[] = [];

  // Primary path: extract tool_use_id directly from content blocks
  const toolResultBlocks = contentBlocks.filter(
    (b): b is ToolResultBlock => b.type === 'tool_result'
  );

  if (toolResultBlocks.length > 0) {
    // Direct ID matching — each block explicitly identifies its tool
    for (const block of toolResultBlocks) {
      const toolUseId = block.tool_use_id;
      const entry = toolIndex.getEntry(toolUseId);

      const resultStr = serializeResult(block.content);
      const isError = block.is_error ?? isToolResultError(block.content);

      const optionalParentToolUseId = sdkParentToolUseId ?? undefined;
      events.push({
        type: 'tool_result',
        toolUseId,
        toolName: entry?.name,
        result: resultStr,
        isError,
        ...(entry?.input !== undefined ? { input: entry?.input } : {}),
        ...(turnId !== undefined ? { turnId } : {}),
        parentToolUseId: optionalParentToolUseId,
      });

      // Detect background tasks/shells from results
      if (entry) {
        const bgEvents = detectBackgroundEvents(toolUseId, entry, resultStr, isError, turnId);
        events.push(...bgEvents);
      }
    }
  } else if (toolUseResultValue !== undefined) {
    // Fallback: use convenience fields when content blocks are unavailable.
    // This handles edge cases like in-process MCP tools that don't provide
    // tool_result content blocks.
    //
    // When sdkParentToolUseId is set, it points to the tool's own ID (for
    // regular tools using the convenience API) — so we use it as toolUseId.
    // When null (top-level tools without content blocks), we generate a
    // synthetic ID so the result isn't silently dropped.
    //
    // parentToolUseId is intentionally set to undefined here because in the
    // fallback path we only have one ID — using it as BOTH toolUseId and
    // parentToolUseId would create a self-referencing loop. The safe default
    // is to treat the tool as top-level when parent is ambiguous.
    const toolUseId = sdkParentToolUseId ?? `fallback-${turnId ?? 'unknown'}`;
    const entry = toolIndex.getEntry(toolUseId);

    const resultStr = serializeResult(toolUseResultValue);
    const isError = isToolResultError(toolUseResultValue);

    events.push({
      type: 'tool_result',
      toolUseId,
      toolName: entry?.name,
      result: resultStr,
      isError,
      ...(entry?.input !== undefined ? { input: entry?.input } : {}),
      ...(turnId !== undefined ? { turnId } : {}),
      parentToolUseId: undefined,
    });

    if (entry) {
      const bgEvents = detectBackgroundEvents(toolUseId, entry, resultStr, isError, turnId);
      events.push(...bgEvents);
    }
  }

  return events;
}
