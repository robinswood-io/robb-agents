import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import { registerSessionsHandlers } from './sessions'

describe('interactive question response workspace authority', () => {
  it('authorizes an existing-turn retry before dispatch and forwards its exact anchor and caller', async () => {
    const handlers = new Map<string, HandlerFn>()
    const delivered: unknown[] = []
    const server = { handle: (channel: string, handler: HandlerFn) => handlers.set(channel, handler) } as unknown as RpcServer
    const deps = {
      platform: { logger: {} },
      sessionManager: {
        getSessions: () => [{ id: 'session', workspaceId: 'private-workspace' }],
        getSession: () => { throw new Error('Authorize before hydrating') },
        retryTurn: async (...args: unknown[]) => { delivered.push(args); return { status: 'started' } },
      },
    } as unknown as HandlerDeps
    registerSessionsHandlers(server, deps)
    const handler = handlers.get(RPC_CHANNELS.sessions.COMMAND)!
    const context: RequestContext = { clientId: 'client', workspaceId: 'other-workspace', webContentsId: null, actorId: 'human', roles: ['user'], authorizationGeneration: 1, allowedWorkspaceIds: '*' }
    const command = { type: 'retryTurn', userMessageId: 'latest-user' }
    await expect(handler(context, 'session', command)).rejects.toThrow('Workspace access denied')
    expect(delivered).toEqual([])
    await expect(handler({ ...context, workspaceId: 'private-workspace' }, 'session', command)).resolves.toEqual({ status: 'started' })
    expect(delivered).toEqual([['session', 'latest-user', { callerClientId: 'client' }]])
  })

  it('rejects another workspace before hydration or dispatch and pins a valid response to its actual caller', async () => {
    const handlers = new Map<string, HandlerFn>()
    const delivered: unknown[] = []
    const server = { handle: (channel: string, handler: HandlerFn) => handlers.set(channel, handler) } as unknown as RpcServer
    const deps = {
      platform: { logger: {} },
      sessionManager: {
        getSessions: () => [{ id: 'child-origin', workspaceId: 'private-workspace' }],
        getSession: () => { throw new Error('Request must authorize before hydrating') },
        respondToUserInput: async (...args: unknown[]) => { delivered.push(args); return { status: 'cancelled' } },
      },
    } as unknown as HandlerDeps
    registerSessionsHandlers(server, deps)
    const handler = handlers.get(RPC_CHANNELS.sessions.RESPOND_TO_USER_INPUT)!
    const context: RequestContext = { clientId: 'client', workspaceId: 'other-workspace', webContentsId: null, actorId: 'human', roles: ['user'], authorizationGeneration: 1, allowedWorkspaceIds: '*' }
    const response = { requestId: 'question', cancelled: true }
    await expect(handler(context, 'child-origin', response)).rejects.toThrow('Workspace access denied')
    expect(delivered).toEqual([])
    await expect(handler({ ...context, workspaceId: 'private-workspace' }, 'child-origin', response)).resolves.toEqual({ status: 'cancelled' })
    expect(delivered).toEqual([['child-origin', response, { callerClientId: 'client' }]])
  })
})
