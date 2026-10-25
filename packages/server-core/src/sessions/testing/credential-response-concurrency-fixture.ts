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
  const manager = new SessionManager()
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
  const runtime = manager as unknown as {
    sessions: Map<string, typeof managed>
    sendEvent: (event: Record<string, unknown>) => void
    handleCredentialInput: (...args: unknown[]) => Promise<boolean>
    credentialResponsesInFlight: Map<string, unknown>
    oauthResponsesInFlight: Map<string, unknown>
    cancelPendingAuthForHumanContinuation: (session: typeof managed) => boolean
    persistSession: () => boolean
    scheduleDeferredAutomaticSessions: () => void
    pendingCredentialResolvers: Map<string, (response: unknown) => void>
    ensureMessagesLoaded: (session: typeof managed) => Promise<void>
    mintAuthenticatedInternalContinuation: (
      session: typeof managed,
      kind: 'auth-result' | 'auth-retry',
    ) => symbol | undefined
    sendAuthenticatedInternalContinuation: (
      session: typeof managed,
      message: string,
      kind: 'auth-result' | 'auth-retry',
      token: symbol,
      input?: { existingMessageId?: string; isAuthRetry?: boolean },
    ) => Promise<void>
    flushSession: (sessionId: string) => Promise<void>
    processNextQueuedMessage: (sessionId: string) => void
    deferredAutomaticSessions: Set<string>
  }
  sessionRuntimeStateForTest(manager).sessions.set(id, managed)
  runtime.sendEvent = (event: Record<string, unknown>) => events.push(event)
  return { manager, managed, request, runtime, events }
}
