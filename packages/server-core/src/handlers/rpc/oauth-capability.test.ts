import { describe, expect, it } from 'bun:test'
import { completeOAuthFlow } from './oauth'

function createFlow() {
  return {
    flowId: 'flow',
    state: 'state',
    codeVerifier: 'verifier',
    redirectUri: 'https://localhost/callback',
    source: {},
    clientId: 'oauth-client',
    tokenEndpoint: 'https://provider.invalid/token',
    provider: 'google',
    ownerClientId: 'owner',
    workspaceId: 'workspace',
    sourceSlug: 'source',
    sessionId: 'session',
    authRequestId: 'request',
  }
}

function baseOptions(flow: ReturnType<typeof createFlow>) {
  let removed = false
  let exchanges = 0
  let completions = 0
  let pushes = 0
  return {
    options: {
      code: 'code',
      state: flow.state,
      flowStore: {
        getByState: () => flow,
        remove: () => { removed = true },
      },
      credManager: {
        exchangeAndStore: async () => {
          exchanges++
          return { success: true, email: 'user@example.test' }
        },
      },
      sessionManager: {
        completeAuthRequest: async () => { completions++ },
        isPendingOAuthRequest: () => true,
        claimPendingOAuthRequest: () => true,
        releasePendingOAuthRequest: () => {},
      },
      pushSourcesChanged: () => { pushes++ },
      logger: { info: () => {} },
      clientId: flow.ownerClientId,
      workspaceId: flow.workspaceId,
    },
    counts: () => ({ removed, exchanges, completions, pushes }),
  }
}

describe('OAuth session capability binding', () => {
  it('rejects a stale bound request before exchanging or storing credentials', async () => {
    const flow = createFlow()
    const h = baseOptions(flow)
    const checks: unknown[] = []
    h.options.sessionManager.isPendingOAuthRequest = (...args: unknown[]) => {
      checks.push(args)
      return false
    }

    await expect(completeOAuthFlow(h.options)).rejects.toThrow('no longer pending')
    expect(checks).toEqual([['session', 'request', 'source', 'workspace']])
    expect(h.counts()).toEqual({ removed: true, exchanges: 0, completions: 0, pushes: 0 })
  })

  it('does not complete an obsolete card when cancellation wins during token exchange', async () => {
    const flow = createFlow()
    const h = baseOptions(flow)
    let current = true
    h.options.sessionManager.isPendingOAuthRequest = () => current
    const exchangeAndStore = h.options.credManager.exchangeAndStore
    h.options.credManager.exchangeAndStore = async () => {
      current = false
      return exchangeAndStore()
    }

    await expect(completeOAuthFlow(h.options)).resolves.toEqual({
      success: false,
      error: 'OAuth authentication request is no longer pending',
    })
    expect(h.counts()).toEqual({ removed: true, exchanges: 1, completions: 0, pushes: 1 })
  })

  it('completes a still-current bound request exactly once', async () => {
    const flow = createFlow()
    const h = baseOptions(flow)

    await expect(completeOAuthFlow(h.options)).resolves.toEqual({
      success: true,
      email: 'user@example.test',
    })
    expect(h.counts()).toEqual({ removed: true, exchanges: 1, completions: 1, pushes: 1 })
  })

  it('allows only one of two OAuth flows bound to the same pending request to store credentials', async () => {
    const firstFlow = createFlow()
    const secondFlow = { ...createFlow(), flowId: 'flow-2', state: 'state-2' }
    const flows = new Map([[firstFlow.state, firstFlow], [secondFlow.state, secondFlow]])
    let claimed = false
    let exchanges = 0
    let completions = 0
    let releaseExchange!: () => void
    const exchangeGate = new Promise<void>(resolve => { releaseExchange = resolve })
    let exchangeEntered!: () => void
    const entered = new Promise<void>(resolve => { exchangeEntered = resolve })
    const sessionManager = {
      completeAuthRequest: async () => { completions++ },
      isPendingOAuthRequest: () => true,
      claimPendingOAuthRequest: () => {
        if (claimed) return false
        claimed = true
        return true
      },
      releasePendingOAuthRequest: () => { claimed = false },
    }
    const optionsFor = (flow: ReturnType<typeof createFlow>) => ({
      code: 'code',
      state: flow.state,
      flowStore: {
        getByState: (state: string) => flows.get(state) ?? null,
        remove: (state: string) => { flows.delete(state) },
      },
      credManager: {
        exchangeAndStore: async () => {
          exchanges++
          exchangeEntered()
          await exchangeGate
          return { success: true }
        },
      },
      sessionManager,
      pushSourcesChanged: () => {},
      logger: { info: () => {} },
      clientId: flow.ownerClientId,
      workspaceId: flow.workspaceId,
    })

    const first = completeOAuthFlow(optionsFor(firstFlow))
    await entered
    await expect(completeOAuthFlow(optionsFor(secondFlow))).rejects.toThrow('already being completed')
    expect(exchanges).toBe(1)
    releaseExchange()
    await expect(first).resolves.toEqual({ success: true })
    expect(completions).toBe(1)
    expect(claimed).toBe(false)
  })
})
