import type { AgentToolResult } from '@earendil-works/pi-agent-core';

/**
 * Close a blocked tool call without claiming that the underlying operation ran.
 * Pi treats this as a normal tool result so it can synthesize a checkpoint;
 * the host uses the structured details to exclude it from execution evidence.
 */
export function createToolExecutionCheckpointResult(reason: string): AgentToolResult<any> {
  return {
    content: [{ type: 'text', text: reason }],
    details: {
      costControlBlocked: true,
      continuationRequired: true,
      executed: false,
      checkpoint: {
        schemaVersion: 1,
        kind: 'tool-call-budget',
        reason,
      },
    },
  };
}
