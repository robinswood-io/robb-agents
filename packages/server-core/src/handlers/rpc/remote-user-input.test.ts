import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UserInputAnswer, UserInputQuestion, UserInputResponseResult } from '@craft-agent/core/types'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { createManagedSession, SessionManager } from '../../sessions/SessionManager'
import { WsRpcClient } from '../../transport/client'
import { WsRpcServer } from '../../transport/server'
import { createWebuiRpcAuthorizer } from '../../webui/remote-rpc-policy'
import { RemoteDeviceRegistry } from '../../webui/remote-device-registry'
import type { HandlerDeps } from '../handler-deps'
import { registerSessionsHandlers } from './sessions'

type Managed = ReturnType<typeof createManagedSession>
const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })

const questions: UserInputQuestion[] = [
  { id: 'format', question: 'Quel format ?', options: [{ id: 'short', label: 'Court' }, { id: 'long', label: 'Détaillé' }] },
  { id: 'checks', question: 'Quels contrôles ?', multiSelect: true, options: [{ id: 'amount', label: 'Montants' }, { id: 'date', label: 'Dates' }] },
  { id: 'detail', question: 'Quel détail ajouter ?' },
]
// Same structured payload as the card: one entry per question, option IDs and
// optional free text. No human answer is reconstructed from tool output.
const answers: UserInputAnswer[] = [
  { questionId: 'format', optionIds: ['short'] },
  { questionId: 'checks', optionIds: ['date', 'amount'] },
  { questionId: 'detail', optionIds: [], text: '  Ajouter le total.  ' },
]

async function harness() {
  const rootPath = mkdtempSync(join(tmpdir(), 'robb-remote-input-'))
  cleanup.push(() => rmSync(rootPath, { recursive: true, force: true }))
  const workspace = { id: 'allowed-workspace', name: 'Fixture', slug: 'fixture', rootPath, createdAt: 1 }
  const parent = createManagedSession({ id: 'parent' }, workspace, { messagesLoaded: true })
  const origin = createManagedSession({ id: 'child-origin', parentSessionId: parent.id }, workspace, { messagesLoaded: true })
  const foreign = createManagedSession({ id: 'foreign-session' }, { ...workspace, id: 'foreign-workspace' }, { messagesLoaded: true })
  const manager = new SessionManager()
  const snapshots: Array<{ id: string; requests: Managed['userInputRequests'] }> = []
  const dispatches: Array<{ id: string; messageId?: string; callerClientId?: string }> = []
  const internals = manager as unknown as {
    sessions: Map<string, Managed>
    enqueuePersist: (session: Managed) => void
    sendEvent: () => void
  }
  for (const session of [parent, origin, foreign]) internals.sessions.set(session.id, session)
  internals.enqueuePersist = session => snapshots.push({ id: session.id, requests: structuredClone(session.userInputRequests) })
  internals.sendEvent = () => {}
  manager.flushSession = async () => {}
  manager.waitForInit = async () => {}
  // Stop at the durable dispatch seam: the real response lifecycle still
  // validates ownership, canonicalizes answers and creates its single receipt.
  manager.sendMessage = async (id, _text, _attachments, _stored, _options, messageId, _retry, ack, context) => {
    dispatches.push({ id, messageId, callerClientId: context?.callerClientId })
    const message = internals.sessions.get(id)?.messages.find(item => item.id === messageId)
    if (!message) throw new Error('Missing durable response message')
    message.isQueued = false
    ack?.(message.id)
  }
  const { requestId } = await manager.requestUserInput(origin.id, questions)
  const foreignRequest = await manager.requestUserInput(foreign.id, questions)
  const devices = new RemoteDeviceRegistry()
  devices.register({ id: 'fixture-device', name: 'Fixture device', allowedWorkspaceIds: [workspace.id], expiresAt: '2099-01-01T00:00:00.000Z', authorizationGeneration: 1 })
  const server = new WsRpcServer({
    host: '127.0.0.1', port: 0, requireAuth: true, requireAuthoritativePrincipal: true, serverId: 'fixture',
    validateToken: async token => token === 'isolated-test-token' ? {
      actorId: 'remote-device:fixture-device', allowedWorkspaceIds: [workspace.id], capabilities: [], roles: ['remote-device'], authorizationGeneration: 1,
    } : false,
    authorizeRequest: createWebuiRpcAuthorizer(devices),
  })
  cleanup.push(() => server.close())
  registerSessionsHandlers(server, {
    sessionManager: manager,
    platform: { logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } },
  } as unknown as HandlerDeps)
  await server.listen()
  const client = new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
    workspaceId: workspace.id, token: 'isolated-test-token', mode: 'remote', autoReconnect: false, requestTimeout: 2_000, connectTimeout: 2_000,
  })
  cleanup.push(() => client.destroy())
  return { client, devices, parent, origin, foreign, requestId, foreignRequest, snapshots, dispatches }
}

describe('remote interactive answers across transport and session ownership', () => {
  it('loads the pending child card, validates three answers, then returns one durable receipt across retries', async () => {
    const h = await harness()
    const sessions = await h.client.invoke(RPC_CHANNELS.sessions.GET)
    expect(sessions.map((session: { id: string }) => session.id).sort()).toEqual(['child-origin', 'parent'])
    const before = await h.client.invoke(RPC_CHANNELS.sessions.GET_MESSAGES, h.parent.id)
    expect(before.userInputRequests).toHaveLength(1)
    expect(before.userInputRequests[0]).toMatchObject({ id: h.requestId, sessionId: h.origin.id, status: 'pending', questions })
    await expect(h.client.invoke(RPC_CHANNELS.sessions.GET_MESSAGES, h.foreign.id)).rejects.toThrow('Workspace access denied')
    // A parent displays its child's card, but only the actual child owns it.
    await expect(h.client.invoke(RPC_CHANNELS.sessions.RESPOND_TO_USER_INPUT, h.parent.id, { requestId: h.requestId, answers })).rejects.toThrow('does not belong')
    await expect(h.client.invoke(RPC_CHANNELS.sessions.RESPOND_TO_USER_INPUT, h.foreign.id, { requestId: h.foreignRequest.requestId, answers })).rejects.toThrow('Workspace access denied')
    await expect(h.client.invoke(RPC_CHANNELS.sessions.RESPOND_TO_USER_INPUT, h.origin.id, { requestId: h.foreignRequest.requestId, answers })).rejects.toThrow('does not belong')
    await expect(h.client.invoke(RPC_CHANNELS.sessions.RESPOND_TO_USER_INPUT, h.origin.id, {
      requestId: h.requestId, answers: [{ questionId: 'format', optionIds: ['forged'] }, ...answers.slice(1)],
    })).rejects.toThrow('Unknown option')
    expect(h.dispatches).toHaveLength(0)
    expect(h.origin.userInputRequests?.[0]?.status).toBe('pending')

    const response: UserInputResponseResult = await h.client.invoke(RPC_CHANNELS.sessions.RESPOND_TO_USER_INPUT, h.origin.id, { requestId: h.requestId, answers })
    expect(response).toMatchObject({ status: 'accepted', delivery: 'started' })
    expect(response.responseMessageId).toBeTruthy()
    expect(h.dispatches).toEqual([{ id: h.origin.id, messageId: response.responseMessageId, callerClientId: expect.any(String) }])
    expect(h.origin.messages).toHaveLength(1)
    expect(h.snapshots.some(snapshot => snapshot.id === h.origin.id && snapshot.requests?.[0]?.responseMessageId === response.responseMessageId)).toBe(true)
    const after = await h.client.invoke(RPC_CHANNELS.sessions.GET_MESSAGES, h.parent.id)
    expect(after.userInputRequests[0]).toMatchObject({ status: 'answered', answers: [answers[0], { questionId: 'checks', optionIds: ['amount', 'date'] }, { questionId: 'detail', optionIds: [], text: 'Ajouter le total.' }] })
    expect(await h.client.invoke(RPC_CHANNELS.sessions.RESPOND_TO_USER_INPUT, h.origin.id, { requestId: h.requestId, answers })).toMatchObject({ status: 'already_answered', responseMessageId: response.responseMessageId })
    expect(h.dispatches).toHaveLength(1)
    expect(h.foreign.userInputRequests?.[0]?.status).toBe('pending')
  })

  it('revalidates device authority after card hydration and denies a revoked device before receipt creation', async () => {
    const h = await harness()
    const session = await h.client.invoke(RPC_CHANNELS.sessions.GET_MESSAGES, h.parent.id)
    expect(session.userInputRequests[0].status).toBe('pending')
    expect(h.devices.revoke('fixture-device')).toBe(true)
    await expect(h.client.invoke(RPC_CHANNELS.sessions.RESPOND_TO_USER_INPUT, h.origin.id, { requestId: h.requestId, answers })).rejects.toThrow('RPC channel denied')
    expect(h.origin.userInputRequests?.[0]?.status).toBe('pending')
    expect(h.origin.messages).toHaveLength(0)
    expect(h.dispatches).toHaveLength(0)
  })
})
