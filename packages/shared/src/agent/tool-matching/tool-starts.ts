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
import { extractToolMetadata } from './tool-metadata.ts';
import type { ContentBlock, ToolUseBlock } from './transcript.ts';
import { ToolIndex, stripInternalFields } from './transcript.ts';

/**
 * Extract tool_start events from assistant message content blocks.
 *
 * Each tool_use block in the content becomes a tool_start event.
 * Parent assignment comes directly from the SDK's parent_tool_use_id field
 * on the message — no stacks or FIFO needed.
 *
 * Fallback: When SDK's parent_tool_use_id is null AND exactly one Task is active,
 * we assign that Task as the parent. This handles cases where the SDK doesn't
 * provide parent info for subagent child tools.
 *
 * @param contentBlocks - Content blocks from SDKAssistantMessage.message.content
 * @param sdkParentToolUseId - parent_tool_use_id from the SDK message (null = top-level)
 * @param toolIndex - Append-only index to register new tools in
 * @param emittedToolStartIds - Set of tool IDs already emitted (for stream/assistant dedup)
 * @param turnId - Current turn correlation ID
 * @param activeParentTools - Set of currently active Task tool IDs (for fallback parent assignment)
 * @param sessionDir - Session directory for reading tool metadata (prevents race when concurrent sessions clobber singleton)
 * @returns Array of tool_start AgentEvents
 */
export function extractToolStarts(
  contentBlocks: ContentBlock[],
  sdkParentToolUseId: string | null,
  toolIndex: ToolIndex,
  emittedToolStartIds: Set<string>,
  turnId?: string,
  activeParentTools?: Set<string>,
  sessionDir?: string,
): AgentEvent[] {
  const events: AgentEvent[] = [];

  for (const block of contentBlocks) {
    if (block.type !== 'tool_use') continue;
    const toolBlock = block as ToolUseBlock;

    // Register in index (idempotent — handles both stream and assistant events)
    toolIndex.register(toolBlock.id, toolBlock.name, toolBlock.input);

    // Determine parent: SDK's parent_tool_use_id is authoritative when present.
    // Fallback: if SDK provides null AND exactly one Task is active, use that Task.
    // This handles subagent child tools when SDK doesn't provide parent info.
    let parentToolUseId: string | undefined;
    if (sdkParentToolUseId) {
      // SDK provided explicit parent — use it
      parentToolUseId = sdkParentToolUseId;
    } else if (activeParentTools && activeParentTools.size === 1) {
      // Fallback: exactly one active Task, assign it as parent for child tools.
      // We can't safely assign when multiple Tasks are active (ambiguous).
      // Don't assign if this tool IS the Task (would create self-reference).
      const [singleActiveParent] = activeParentTools;
      if (toolBlock.id !== singleActiveParent) {
        parentToolUseId = singleActiveParent;
      }
    }

    // Dedup: stream_event arrives before assistant message, both have the same tool_use block.
    // The Set is append-only and order-independent (same ID always deduplicates the same way).
    if (emittedToolStartIds.has(toolBlock.id)) {
      // Already emitted via stream — re-emit only when we have newly useful data.
      // 1) Complete input arrived on assistant message (stream starts with {})
      // 2) Metadata became available later in toolMetadataStore (race-safe)
      const hasNewInput = Object.keys(toolBlock.input).length > 0;
      const { intent, displayName } = extractToolMetadata(toolBlock, sessionDir);
      const hasMetadataUpdate = !!intent || !!displayName;
      if (hasNewInput || hasMetadataUpdate) {
        events.push({
          type: 'tool_start',
          toolName: toolBlock.name,
          toolUseId: toolBlock.id,
          input: stripInternalFields(toolBlock.input),
          intent,
          displayName,
          turnId,
          parentToolUseId,
        });
      }
      continue;
    }

    emittedToolStartIds.add(toolBlock.id);

    const { intent, displayName } = extractToolMetadata(toolBlock, sessionDir);

    events.push({
      type: 'tool_start',
      toolName: toolBlock.name,
      toolUseId: toolBlock.id,
      input: stripInternalFields(toolBlock.input),
      intent,
      displayName,
      turnId,
      parentToolUseId,
    });
  }

  return events;
}
