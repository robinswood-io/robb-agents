import { describe, expect, it } from 'bun:test';
import { MissionWorkItemSchema } from './schema.ts';

function workItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'publish',
    kind: 'task',
    title: 'Publish',
    prompt: 'Publish an approved record',
    objectiveId: 'objective-one',
    acceptanceCriteria: [{ id: 'published', description: 'Published' }],
    requiredEvidence: [{ id: 'mutation-receipt', description: 'Host receipt', kind: 'receipt' }],
    effect: 'external-mutation',
    connectorInvocation: {
      schemaVersion: 1,
      pack: 'googleWorkspace',
      operationId: 'drive.update',
      resourceType: 'file',
      resourceId: 'file-42',
      payload: { name: 'approved-report.xlsx' },
      autonomy: 'A3',
      receiptRequirementId: 'mutation-receipt',
      compensation: { strategy: 'manual' },
    },
    ...overrides,
  };
}

describe('Mission structured connector invocation', () => {
  it('requires external mutations to carry a bounded invocation and receipt contract', () => {
    expect(MissionWorkItemSchema.safeParse(workItem()).success).toBe(true);
    expect(MissionWorkItemSchema.safeParse(workItem({ connectorInvocation: undefined })).success).toBe(false);
    expect(MissionWorkItemSchema.safeParse(workItem({ requiredEvidence: [] })).success).toBe(false);
  });

  it('rejects oversized or non-JSON payloads and incomplete executable compensation', () => {
    const base = workItem();
    const invocation = base.connectorInvocation as Record<string, unknown>;
    expect(MissionWorkItemSchema.safeParse(workItem({
      connectorInvocation: { ...invocation, payload: { content: 'x'.repeat(70 * 1024) } },
    })).success).toBe(false);
    expect(MissionWorkItemSchema.safeParse(workItem({
      connectorInvocation: { ...invocation, payload: { createdAt: new Date() } },
    })).success).toBe(false);
    expect(MissionWorkItemSchema.safeParse(workItem({
      connectorInvocation: {
        ...invocation,
        compensation: { strategy: 'inverse-operation' },
      },
    })).success).toBe(false);
  });
});
