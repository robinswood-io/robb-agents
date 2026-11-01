import { createLogger } from "../../utils/debug.ts";

export const log = createLogger('tool-matching');

/**
 * Parse the workflow run id (`wf_...`) from a subagent transcript path (or any
 * string containing one). Workflow sub-agent transcripts live under
 * `.../subagents/workflows/<wf_id>/agent-<id>.jsonl`, so this both (a) extracts
 * the id from the Workflow tool result's "Transcript dir:" line and (b) attributes
 * a SubagentStop's transcript path to the owning workflow. Returns null for
 * non-workflow paths (ordinary sub-agents live under `.../subagents/agent-*`).
 */
export function parseWorkflowIdFromTranscriptPath(path: string | undefined): string | null {
  if (!path) return null;
  // The id charset [A-Za-z0-9_-] naturally bounds the match (it stops at `/`,
  // `.`, whitespace or newline), so no explicit terminator is needed — and adding
  // one breaks the "Transcript dir:" tail case where the id is followed by \n.
  const m = path.match(/\/workflows\/(wf_[A-Za-z0-9_-]+)/);
  return m?.[1] ?? null;
}

// ============================================================================
// Tool Index — append-only, order-independent lookup
// ============================================================================

export interface ToolEntry {
  name: string;
  input: Record<string, unknown>;
}

/**
 * Append-only index of tool metadata, built from tool_start events.
 * Order-independent: inserting A then B = inserting B then A.
 * Used to look up tool name/input when processing tool_result blocks
 * (which carry tool_use_id but not tool_name).
 */
export class ToolIndex {
  private entries = new Map<string, ToolEntry>();

  /** Register a tool (idempotent — same ID always maps to same entry) */
  register(toolUseId: string, name: string, input: Record<string, unknown>): void {
    // Update input if we now have more complete data (stream events start with empty input)
    const existing = this.entries.get(toolUseId);
    if (existing && Object.keys(existing.input).length === 0 && Object.keys(input).length > 0) {
      this.entries.set(toolUseId, { name, input });
    } else if (!existing) {
      this.entries.set(toolUseId, { name, input });
    }
  }

  getName(toolUseId: string): string | undefined {
    return this.entries.get(toolUseId)?.name;
  }

  getInput(toolUseId: string): Record<string, unknown> | undefined {
    return this.entries.get(toolUseId)?.input;
  }

  getEntry(toolUseId: string): ToolEntry | undefined {
    return this.entries.get(toolUseId);
  }

  has(toolUseId: string): boolean {
    return this.entries.has(toolUseId);
  }

  get size(): number {
    return this.entries.size;
  }
}

// ============================================================================
// Content block types (subset of Anthropic SDK types we need)
// ============================================================================

/** Represents a tool_use content block from an assistant message */
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Represents a tool_result content block from a user message */
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
}

/** Represents a text content block */
export interface TextBlock {
  type: 'text';
  text: string;
}

/** Union of content blocks we handle */
export type ContentBlock = ToolUseBlock | ToolResultBlock | TextBlock | { type: string };

// ============================================================================
// Pure extraction functions
// ============================================================================

/** Strip internal metadata fields (_displayName, _intent) from tool input */
export function stripInternalFields(input: unknown): Record<string, unknown> {
  const { _displayName, _intent, ...clean } = input as Record<string, unknown>;
  return clean;
}
