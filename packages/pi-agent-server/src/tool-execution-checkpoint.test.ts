import { describe, expect, it } from 'bun:test';
import { createToolExecutionCheckpointResult } from './tool-execution-checkpoint.ts';

describe('createToolExecutionCheckpointResult', () => {
  it('declares a blocked call as non-executed while requiring continuation', () => {
    const reason = 'Edit was not started because the tool-call budget was exhausted.';
    const result = createToolExecutionCheckpointResult(reason);

    expect(result).toEqual({
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
    });
  });
});
