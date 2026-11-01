import { sessionManagerForTest } from "./private-runtime-access.ts";
import { withSessionOperationsForTest } from './session-operation-access.ts';
import { sessionRuntimeStateForTest } from "./runtime-state-access.ts";
import { SessionManager, createManagedSession } from "../SessionManager";
import { transitionObjectiveContract } from "../objective-contract";



export const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}


export const managers: SessionManager[] = []

export const spies: Array<{ mockRestore(): void }> = []


export function harness(id: string) {
  const manager = withSessionOperationsForTest(new SessionManager())
  managers.push(manager)
  const managed = createManagedSession({ id }, {
    id: 'credential-workspace',
    name: 'Credential workspace',
    rootPath: '/tmp/credential-response-concurrency',
    createdAt: 1,
  } as never, { messagesLoaded: true })
  const request = {
    type: 'credential' as const,
    requestId: `${id}-request`,
    sessionId: id,
    sourceSlug: 'fixture-source',
    sourceName: 'Fixture source',
    mode: 'bearer' as const,
  }
  managed.pendingAuthRequestId = request.requestId
  managed.pendingAuthRequest = request
  managed.activeObjective = transitionObjectiveContract({
    messageId: `${id}-objective`,
    text: 'Inspecte la source autorisée et termine la mission.',
    nowMs: 1,
  })
  managed.messages = [{
    id: `${id}-auth-message`,
    role: 'auth-request',
    content: 'Authenticate',
    timestamp: 1,
    authRequestId: request.requestId,
    authRequestType: 'credential',
    authSourceSlug: request.sourceSlug,
    authSourceName: request.sourceName,
    authStatus: 'pending',
  }]
  const events: Array<Record<string, unknown>> = []
  const runtime = sessionManagerForTest(manager)
  sessionRuntimeStateForTest(manager).sessions.set(id, managed)
  runtime.sendEvent = (event: Record<string, unknown>) => events.push(event)
  return { manager, managed, request, runtime, events }
}
