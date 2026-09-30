import { describe, expect, it } from 'bun:test'
import type { CredentialRequest, PermissionRequest } from '../../../shared/types'
import {
  bindCredentialResponse,
  permissionResponseIdentity,
  structuredInputIdentity,
} from '../../components/app-shell/input/structured/types'
import { removePendingRequest, upsertPendingRequest } from '../pending-request-queue'

function permission(
  requestId: string,
  toolUseId: string,
  command = requestId,
): PermissionRequest {
  return {
    sessionId: 'session-a',
    requestId,
    toolUseId,
    toolName: 'Bash',
    description: `Approve ${command}`,
    command,
  }
}

function credential(requestId: string, sourceName = requestId): CredentialRequest {
  return {
    type: 'credential',
    mode: 'bearer',
    sessionId: 'session-a',
    requestId,
    sourceSlug: `source-${requestId}`,
    sourceName,
  }
}

describe('pending request queue identity', () => {
  it('upserts a replayed permission by requestId while preserving distinct FIFO requests', () => {
    const old = permission('request-old', 'tool-old', 'first label')
    const replay = permission('request-old', 'tool-old', 'refreshed label')
    const current = permission('request-new', 'tool-new', 'ssh read-only')

    let pending = new Map<string, PermissionRequest[]>()
    pending = upsertPendingRequest(pending, old.sessionId, old)
    pending = upsertPendingRequest(pending, replay.sessionId, replay)
    pending = upsertPendingRequest(pending, current.sessionId, current)

    expect(pending.get(old.sessionId)).toEqual([replay, current])
  })

  it('removes the answered id only and cannot dequeue a newer request after a stale click', () => {
    const old = permission('request-old', 'tool-old')
    const current = permission('request-new', 'tool-new')
    // Start with the exact corrupt shape produced by the old append-only reducer.
    let pending = new Map([[old.sessionId, [old, { ...old }, current]]])

    pending = removePendingRequest(pending, old.sessionId, old.requestId)
    expect(pending.get(old.sessionId)).toEqual([current])

    const afterStaleClick = removePendingRequest(pending, old.sessionId, old.requestId)
    expect(afterStaleClick).toBe(pending)
    expect(afterStaleClick.get(old.sessionId)).toEqual([current])
  })

  it('binds the mounted card and response to session, request and tool identities', () => {
    const old = permission('request-old', 'tool-old')
    const current = permission('request-new', 'tool-new')

    expect(permissionResponseIdentity(old)).toEqual({
      sessionId: old.sessionId,
      requestId: old.requestId,
      toolUseId: old.toolUseId,
    })
    expect(structuredInputIdentity({ type: 'permission', data: old }))
      .not.toBe(structuredInputIdentity({ type: 'permission', data: current }))
    expect(structuredInputIdentity({
      type: 'admin_approval',
      request: current,
      data: { appName: 'Fixture', reason: 'Fixture', command: 'fixture' },
    })).toContain(`${current.requestId}:${current.toolUseId}`)
  })

  it('deduplicates replayed credential cards while retaining the next distinct request', () => {
    const old = credential('credential-old', 'Old label')
    const replay = credential('credential-old', 'Refreshed label')
    const current = credential('credential-new', 'Current source')

    let pending = new Map<string, CredentialRequest[]>()
    pending = upsertPendingRequest(pending, old.sessionId, old)
    pending = upsertPendingRequest(pending, replay.sessionId, replay)
    pending = upsertPendingRequest(pending, current.sessionId, current)

    expect(pending.get(old.sessionId)).toEqual([replay, current])
    expect(structuredInputIdentity({ type: 'credential', data: replay }))
      .not.toBe(structuredInputIdentity({ type: 'credential', data: current }))
  })

  it('keeps a newer credential card when an old card responds or responds twice', () => {
    const old = credential('credential-old')
    const current = credential('credential-new')
    const oldResponse = bindCredentialResponse(old, {
      type: 'credential',
      value: 'fixture-value',
      cancelled: false,
    })
    let pending = new Map([[old.sessionId, [old, { ...old }, current]]])

    pending = removePendingRequest(pending, oldResponse.request.sessionId, oldResponse.request.requestId)
    expect(pending.get(old.sessionId)).toEqual([current])
    pending = removePendingRequest(pending, oldResponse.request.sessionId, oldResponse.request.requestId)
    expect(pending.get(old.sessionId)).toEqual([current])
    expect(oldResponse).toMatchObject({
      request: { sessionId: old.sessionId, requestId: old.requestId },
      type: 'credential',
      value: 'fixture-value',
      cancelled: false,
    })
  })
})
