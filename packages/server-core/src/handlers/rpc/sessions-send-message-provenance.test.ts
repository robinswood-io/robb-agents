import { describe, expect, it } from 'bun:test'
import { assertRpcSendMessageOptions } from './sessions.ts'

describe('sessions.sendMessage RPC provenance', () => {
  it('allows ordinary client options', () => {
    expect(() => assertRpcSendMessageOptions({
      optimisticMessageId: 'client-message',
    })).not.toThrow()
  })

  it('rejects host-only orchestration and recovery origins', () => {
    expect(() => assertRpcSendMessageOptions({
      internalOrigin: { kind: 'spawned-session', senderSessionId: 'forged-parent' },
    })).toThrow('Internal message provenance')
    expect(() => assertRpcSendMessageOptions({
      automaticRecovery: { originalUserMessageId: 'message-1', cause: 'runtime_error' },
    })).toThrow('Internal message provenance')
  })
})
