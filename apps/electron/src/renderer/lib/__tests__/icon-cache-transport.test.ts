import { afterEach, expect, it } from 'bun:test'
import { WsRpcServer } from '../../../../../../packages/server-core/src/transport/server'
import { WsRpcClient } from '../../../../../../packages/server-core/src/transport/client'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { clearIconCaches, loadSkillIcon, loadSourceIcon } from '../icon-cache'

const originalWindow = globalThis.window
afterEach(() => {
  clearIconCaches()
  ;((globalThis) as { window: unknown }).window = originalWindow
})

it('releases a failed shared image read so a later request can succeed', async () => {
  let rejectRead!: (error: Error) => void
  let reads = 0
  const firstRead = new Promise<string>((_resolve, reject) => { rejectRead = reject })
  ;((globalThis) as { window: unknown }).window = {
    electronAPI: {
      readWorkspaceImage: () => {
        reads += 1
        return reads === 1 ? firstRead : Promise.resolve('data:image/png;base64,iVBORw0KGgo=')
      },
    },
  }
  const source = { workspaceId: 'qa-recover', config: { slug: 'qa', name: 'QA', type: 'local', icon: './icon.png' } }
  const first = loadSourceIcon(source)
  const duplicate = loadSourceIcon(source)
  rejectRead(new Error('temporary file read failure'))
  expect(await Promise.all([first, duplicate])).toEqual([null, null])
  expect(reads).toBe(1)
  expect(await loadSourceIcon(source)).toBe('data:image/png;base64,iVBORw0KGgo=')
  expect(reads).toBe(2)
})

it('keeps shared image reads isolated between workspaces', async () => {
  const reads: string[] = []
  ;((globalThis) as { window: unknown }).window = {
    electronAPI: {
      readWorkspaceImage: async (workspaceId: string) => { reads.push(workspaceId); return `data:${workspaceId}` },
    },
  }
  const skill = { slug: 'same-name', iconPath: 'skills/same-name/icon.png' }
  expect(await Promise.all([loadSkillIcon(skill, 'qa-a'), loadSkillIcon(skill, 'qa-b')]))
    .toEqual(['data:qa-a', 'data:qa-b'])
  expect(reads).toEqual(['qa-a', 'qa-b'])
})

it('keeps a new message available while two composers load the same 35 skill icons', async () => {
  const token = 'local-icon-transport-regression-test'
  const server = new WsRpcServer({
    host: '127.0.0.1', port: 0, requireAuth: true,
    validateToken: async value => value === token,
  })
  let releaseImages!: () => void
  const imagesReady = new Promise<void>(resolve => { releaseImages = resolve })
  let imageReads = 0
  server.handle(RPC_CHANNELS.workspace.READ_IMAGE, async () => {
    imageReads += 1
    await imagesReady
    return 'data:image/png;base64,iVBORw0KGgo='
  })
  server.handle(RPC_CHANNELS.sessions.SEND_MESSAGE, async () => 'message accepted')
  await server.listen()
  const client = new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
    token, workspaceId: 'qa-icons', autoReconnect: false,
  })
  const loads: Array<Promise<string | null>> = []
  try {
    ;((globalThis) as { window: unknown }).window = {
      electronAPI: {
        readWorkspaceImage: (workspaceId: string, path: string) =>
          client.invoke(RPC_CHANNELS.workspace.READ_IMAGE, workspaceId, path),
      },
    }
    clearIconCaches()
    client.connect()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('test client connection timeout')), 2000)
      const off = client.onConnectionStateChanged(state => {
        if (state.status === 'connected') { clearTimeout(timer); off(); resolve() }
      })
    })
    for (let composer = 0; composer < 2; composer++) {
      for (let index = 0; index < 35; index++) {
        loads.push(loadSkillIcon({ slug: `qa-${index}`, iconPath: `skills/qa-${index}/icon.png` }, 'qa-icons'))
      }
    }
    const accepted = await client.invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, 'qa-session', 'complete my request')
    expect(accepted).toBe('message accepted')
    expect(imageReads).toBe(35)
  } finally {
    releaseImages()
    await Promise.allSettled(loads)
    client.destroy()
    await server.close()
  }
})
