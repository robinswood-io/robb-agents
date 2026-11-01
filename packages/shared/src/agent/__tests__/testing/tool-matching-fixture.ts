import { type ToolUseBlock, type ToolResultBlock } from "../../tool-matching";



// ============================================================================
// Test Helpers
// ============================================================================

export let idCounter = 0


export function resetCounters() {
  idCounter = 0
}


export function makeToolUseBlock(
  name: string,
  input: Record<string, unknown> = {},
  id?: string,
): ToolUseBlock {
  return {
    type: 'tool_use',
    id: id ?? `toolu_${++idCounter}`,
    name,
    input,
  }
}


export function makeToolResultBlock(
  toolUseId: string,
  content: unknown = 'success',
  isError = false,
): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
    is_error: isError,
  }
}
