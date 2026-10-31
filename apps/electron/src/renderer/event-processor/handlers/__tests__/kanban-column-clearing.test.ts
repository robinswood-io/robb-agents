import { expect, it } from 'bun:test';
import { deserializeEnvelope, serializeEnvelope } from '@craft-agent/server-core/transport';
import { processEvent } from '../../processor';
import type { AgentEvent, SessionState } from '../../types';

function initial(): SessionState {
  return {
    session: {
      id: 'session', workspaceId: 'workspace', workspaceName: 'Workspace',
      lastMessageAt: 1, messages: [], isProcessing: false, kanbanColumn: 'review',
    },
    streaming: null,
  };
}

it('preserves an explicit Kanban clear through JSON transport and removes the displayed column', () => {
  const event: AgentEvent = {
    type: 'session_metadata_changed', sessionId: 'session', changes: { kanbanColumn: null },
  };
  const envelope = deserializeEnvelope(serializeEnvelope({
    id: 'column-clear', type: 'event', channel: 'sessions:event', args: [event],
  }));
  expect(envelope.args?.[0]).toEqual(event);
  const before = initial();
  const after = processEvent(before, event).state;
  expect(after.session.kanbanColumn).toBeUndefined();
  expect(Object.hasOwn(after.session, 'kanbanColumn')).toBe(false);
  expect(before.session.kanbanColumn).toBe('review');
  expect(after.session.isProcessing).toBe(false);
});

it('keeps the current column when another metadata field changes', () => {
  const after = processEvent(initial(), {
    type: 'session_metadata_changed', sessionId: 'session', changes: { taskNodeCount: 3 },
  }).state;
  expect(after.session.kanbanColumn).toBe('review');
  expect(after.session.taskNodeCount).toBe(3);
});
