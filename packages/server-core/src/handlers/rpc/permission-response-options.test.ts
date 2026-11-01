import { OAuthFlowStore } from '@craft-agent/shared/auth';
import type { ISessionManager } from '@craft-agent/server-core/handlers';
import { SessionManager as FixtureSessionManager } from '@craft-agent/server-core/sessions';
import { createHeadlessPlatform } from '../../runtime/platform-headless.ts';
import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import { registerSessionsHandlers } from './sessions'

describe('permission response RPC options', () => {
  it('forwards rememberForMinutes to the session manager unchanged', async () => {
    const handlers = new Map<string, HandlerFn<unknown[]>>()
    const delivered: unknown[] = []
    const server = ({handle: (channel, handler) => handlers.set(channel, (ctx, ...args): unknown => Reflect.apply(handler, undefined, [ctx, ...args])),
push: () => {},
invokeClient: async () => undefined,
hasClientCapability: () => false,
findClientsWithCapability: () => []} satisfies RpcServer)
    const deps = ({platform: createHeadlessPlatform(),
sessionManager: Object.assign(new FixtureSessionManager(), ({
        getSessionWorkspaceId: () => 'private-workspace',
        getSession: async () => { throw new Error('permission response guard must not hydrate messages') },
        respondToPermission: (...args: unknown[]) => {
          delivered.push(args)
          return true
        },
      } satisfies Partial<ISessionManager>)),
oauthFlowStore: new OAuthFlowStore()} satisfies HandlerDeps)
    registerSessionsHandlers(server, deps)

    const context: RequestContext = {
      clientId: 'client',
      workspaceId: 'private-workspace',
      webContentsId: null,
      actorId: 'human',
      roles: ['user'],
      authorizationGeneration: 1,
      allowedWorkspaceIds: '*',
    }
    const options = { rememberForMinutes: 10 }
    const handler = handlers.get(RPC_CHANNELS.sessions.RESPOND_TO_PERMISSION)!

    await expect(handler(context, 'session', 'approval', true, false, options)).resolves.toBe(true)
    expect(delivered).toEqual([['session', 'approval', true, false, options]])
  })
})
