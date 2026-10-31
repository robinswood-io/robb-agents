import { afterEach, expect, it } from 'bun:test';
import { loadSession } from '@craft-agent/shared/sessions';
import { cleanupRestartRecovery, harness } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

it('persists the cleared column and emits an explicit null for remote clients', async () => {
  const h = harness();
  const managed = h.make('kanban-column-clear');
  managed.kanbanColumn = 'review';
  await h.save(managed);
  await h.manager.setKanbanColumn(managed.id, null);
  expect(managed.kanbanColumn).toBeUndefined();
  expect(loadSession(h.rootPath, managed.id)?.kanbanColumn).toBeUndefined();
  expect(h.events.some(event => event.type === 'session_metadata_changed'
    && event.changes.kanbanColumn === null)).toBe(true);
});
