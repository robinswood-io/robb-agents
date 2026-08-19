import { beforeEach, describe, expect, it } from 'bun:test'
import { messageToStored } from '@craft-agent/core/types'
import type { AgentEvent } from '@craft-agent/shared/agent'
import type { PlatformServices } from '../runtime/platform'
import {
  SessionManager,
  createManagedSession,
  setSessionPlatform,
} from './SessionManager'

describe('assistant response app provenance', () => {
  let sessionManager: SessionManager

  beforeEach(() => {
    const platform: PlatformServices = {
      appRootPath: '/app',
      resourcesPath: '/resources',
      isPackaged: true,
      appVersion: '0.11.7',
      buildCommit: 'abc123',
      buildChannel: 'production',
      buildDirty: true,
      imageProcessor: {
        async getMetadata() { return null },
        async process() { return Buffer.alloc(0) },
      },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      isDebugMode: false,
    }
    setSessionPlatform(platform)

    sessionManager = new SessionManager()
    ;(sessionManager as unknown as { persistSession: () => void }).persistSession = () => {}
    ;(sessionManager as unknown as { sendEvent: () => void }).sendEvent = () => {}
    ;(sessionManager as unknown as { emitExecutionTelemetry: () => void }).emitExecutionTelemetry = () => {}
  })

  it('persists the producing build on each completed assistant message', async () => {
    const managed = createManagedSession({
      id: 'response-app-provenance',
      model: 'test-model',
    }, {
      id: 'workspace-response-provenance',
      name: 'Response provenance workspace',
      rootPath: '/tmp/response-provenance-test',
      createdAt: Date.now(),
    } as never, { messagesLoaded: true })
    managed.agent = { getModel: () => 'effective-model' } as never

    await (sessionManager as unknown as {
      processEvent: (session: unknown, event: AgentEvent) => Promise<void>
    }).processEvent(managed, {
      type: 'text_complete',
      text: 'Attributed response',
    })

    expect(messageToStored(managed.messages[0]!).routingMeta).toMatchObject({
      appVersion: '0.11.7',
      buildCommit: 'abc123',
      buildChannel: 'production',
      buildDirty: true,
      isPackaged: true,
      model: 'effective-model',
    })
  })
})
