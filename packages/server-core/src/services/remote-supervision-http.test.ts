import { describe, expect, test } from 'bun:test'
import {
  RemoteSupervisionClient,
  createSignedRemoteEnvelope,
  type RemoteAction,
  type RemoteSupervisionProfile,
  type RemoteSupervisorIdentity,
} from '@craft-agent/shared/remote-supervision'
import {
  RemoteSupervisionService,
  type RemoteSupervisionProfileStore,
} from './remote-supervision-service'
import {
  createRemoteSupervisionHttpGateway,
  startRemoteSupervisionHttpServer,
  type RemoteSupervisionPeer,
} from './remote-supervision-http'

class MemoryRemoteProfileStore implements RemoteSupervisionProfileStore {
  profile: RemoteSupervisionProfile | undefined

  load(): unknown {
    return this.profile
  }

  save(profile: RemoteSupervisionProfile): void {
    this.profile = profile
  }
}

const sharedSecret = 'remote-http-secret-0123456789abcdef'
const keyId = 'supervisor-key-1'
const owner: RemoteSupervisorIdentity = {
  subjectId: 'owner-1',
  role: 'owner',
  allowedActions: ['task.pause', 'task.cancel', 'approval.resolve'],
}
const peerIdentity: RemoteSupervisorIdentity = {
  subjectId: 'remote-operator',
  role: 'operator',
  allowedActions: ['task.pause'],
}
const peer: RemoteSupervisionPeer = {
  keyId,
  sharedSecret,
  identity: peerIdentity,
}

describe('remote supervision HTTP gateway', () => {
  test('projects only consented metadata and executes authorized actions over signed HTTP', async () => {
    const service = createService(['task.status', 'task.progress'], ['task.pause'])
    const executed: Array<{ workspaceId: string; action: RemoteAction; targetId?: string }> = []
    const server = startRemoteSupervisionHttpServer({
      resolvePeer: (candidate) => candidate === keyId ? peer : null,
      resolveService: (workspaceId) => workspaceId === 'workspace-1' ? service : null,
      executeAction: (input) => {
        executed.push({
          workspaceId: input.workspaceId,
          action: input.action,
          targetId: input.targetId,
        })
      },
    })

    try {
      const client = new RemoteSupervisionClient({
        baseUrl: server.url,
        keyId,
        sharedSecret,
      })
      await expect(client.projectTask({
        workspaceId: 'workspace-1',
        snapshot: {
          task: {
            status: 'running',
            progress: 0.75,
            cost: { amount: 42, currency: 'EUR' },
          },
        },
      })).resolves.toMatchObject({
        projection: {
          task: {
            status: 'running',
            progress: 0.75,
          },
        },
      })

      await expect(client.executeAction({
        workspaceId: 'workspace-1',
        action: 'task.pause',
        targetId: 'task-1',
      })).resolves.toMatchObject({
        action: 'task.pause',
        accepted: true,
      })
      expect(executed).toEqual([{
        workspaceId: 'workspace-1',
        action: 'task.pause',
        targetId: 'task-1',
      }])
    } finally {
      server.stop()
    }
  })

  test('rejects replayed signed requests before action execution', async () => {
    const service = createService(['task.status'], ['task.pause'])
    let executionCount = 0
    const server = startRemoteSupervisionHttpServer({
      resolvePeer: (candidate) => candidate === keyId ? peer : null,
      resolveService: () => service,
      executeAction: () => {
        executionCount += 1
      },
    })
    const body = JSON.stringify(createSignedRemoteEnvelope(keyId, sharedSecret, {
      workspaceId: 'workspace-1',
      action: 'task.pause',
    }, {
      issuedAt: new Date().toISOString(),
      requestId: '77777777-7777-4777-8777-777777777777',
      nonce: '88888888-8888-4888-8888-888888888888',
    }))

    try {
      const first = await fetch(`${server.url}/v1/remote-supervision/action`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-robb-remote-key-id': keyId,
        },
        body,
      })
      const replay = await fetch(`${server.url}/v1/remote-supervision/action`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-robb-remote-key-id': keyId,
        },
        body,
      })

      expect(first.status).toBe(200)
      expect(replay.status).toBe(409)
      expect(executionCount).toBe(1)
    } finally {
      server.stop()
    }
  })

  test('returns forbidden when consent does not allow the requested remote action', async () => {
    const service = createService(['task.status'], ['task.pause'])
    const server = startRemoteSupervisionHttpServer({
      resolvePeer: (candidate) => candidate === keyId ? peer : null,
      resolveService: () => service,
      executeAction: () => {
        throw new Error('executor should not be called')
      },
    })
    const client = new RemoteSupervisionClient({
      baseUrl: server.url,
      keyId,
      sharedSecret,
    })

    try {
      await expect(client.executeAction({
        workspaceId: 'workspace-1',
        action: 'task.cancel',
      })).rejects.toThrow('HTTP 403')
    } finally {
      server.stop()
    }
  })

  test('refuses to bind the unsigned HTTP listener to a non-loopback interface', () => {
    expect(() => startRemoteSupervisionHttpServer({
      hostname: '0.0.0.0',
      resolvePeer: () => peer,
      resolveService: () => createService(['task.status'], ['task.pause']),
      executeAction: () => undefined,
    })).toThrow('must bind to loopback')
  })

  test('rejects oversized request streams before JSON parsing', async () => {
    const gateway = createRemoteSupervisionHttpGateway({
      resolvePeer: () => peer,
      resolveService: () => createService(['task.status'], ['task.pause']),
      executeAction: () => undefined,
    })
    const response = await gateway(new Request(
      'http://127.0.0.1/v1/remote-supervision/action',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-robb-remote-key-id': keyId,
        },
        body: JSON.stringify({ padding: 'x'.repeat(70 * 1024) }),
      },
    ))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'bad_request',
      message: 'Remote supervision request body is too large',
    })
  })

  test('rate limits request floods independently of signature validity', async () => {
    const gateway = createRemoteSupervisionHttpGateway({
      maxRequestsPerMinute: 1,
      resolvePeer: () => peer,
      resolveService: () => createService(['task.status'], ['task.pause']),
      executeAction: () => undefined,
    })
    const createRequest = (): Request => new Request(
      'http://127.0.0.1/v1/remote-supervision/action',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-robb-remote-key-id': keyId,
        },
        body: '{}',
      },
    )

    expect((await gateway(createRequest())).status).toBe(401)
    const limited = await gateway(createRequest())
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
  })
})

function createService(
  fields: Parameters<RemoteSupervisionService['grant']>[1]['fields'],
  actions: Parameters<RemoteSupervisionService['grant']>[1]['actions'],
): RemoteSupervisionService {
  const service = new RemoteSupervisionService(new MemoryRemoteProfileStore())
  service.grant(owner, {
    consentId: 'consent-http',
    fields,
    actions,
    purpose: 'Remote support',
    expiresAt: '2099-01-01T00:00:00.000Z',
  }, '2026-07-24T10:00:00.000Z')
  return service
}
