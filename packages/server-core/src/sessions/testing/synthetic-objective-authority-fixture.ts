import { withSessionOperationsForTest } from './session-operation-access.ts';
import { sessionManagerForTest } from "./private-runtime-access.ts";
import { sessionRuntimeStateForTest } from "./runtime-state-access.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, createManagedSession } from "../SessionManager.ts";



export const managers: SessionManager[] = []

export const roots: string[] = []

export const modeSessionIds: string[] = []


export function harness(id: string) {
  const rootPath = mkdtempSync(join(tmpdir(), 'synthetic-objective-authority-'))
  roots.push(rootPath)
  const manager = withSessionOperationsForTest(new SessionManager())
  managers.push(manager)
  const host = sessionManagerForTest(manager)
  host.enqueuePersist = () => true
  host.flushSession = async () => {}
  const events: unknown[] = []
  host.sendEvent = (event: unknown) => { events.push(event) }
  host.emitExecutionTelemetry = () => {}
  host.startGenerationTelemetry = () => {}
  host.finishGenerationTelemetry = () => {}
  host.beginAutomaticSessionStatusLifecycle = async () => {}
  host.finishAutomaticSessionStatusLifecycle = async () => {}
  host.isSessionBeingViewed = () => true
  host.markSessionRead = async () => {}
  host.processNextQueuedMessage = () => {}
  const managed = createManagedSession({ id }, {
    id: 'synthetic-objective-workspace',
    name: 'Synthetic objective workspace',
    rootPath,
    createdAt: 1,
  } as never, { messagesLoaded: true })
  sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed)
  return { manager, host, managed, events }
}
