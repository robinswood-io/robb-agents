import { describe, expect, it } from 'bun:test'
import type { RemoteDeviceInfo } from '@craft-agent/shared/config/server-config'
import {
  getActiveRemoteDevices,
  hasNewActiveRemoteDevice,
  isActiveRemoteDevice,
} from '../remote-devices'

const NOW = Date.parse('2026-08-19T12:00:00.000Z')

function device(overrides: Partial<RemoteDeviceInfo> = {}): RemoteDeviceInfo {
  return {
    id: 'device-1',
    name: 'iPhone',
    allowedWorkspaceIds: ['workspace-1'],
    pairedAt: '2026-08-19T10:00:00.000Z',
    expiresAt: '2026-08-26T10:00:00.000Z',
    ...overrides,
  }
}

describe('remote device management', () => {
  it('keeps every active device and sorts the newest pairing first', () => {
    const devices = getActiveRemoteDevices([
      device({ id: 'device-1', pairedAt: '2026-08-19T09:00:00.000Z' }),
      device({ id: 'device-2', pairedAt: '2026-08-19T11:00:00.000Z' }),
      device({ id: 'expired', expiresAt: '2026-08-19T11:59:59.000Z' }),
      device({ id: 'revoked', revokedAt: '2026-08-19T11:30:00.000Z' }),
    ], NOW)

    expect(devices.map(({ id }) => id)).toEqual(['device-2', 'device-1'])
  })

  it('treats revoked and expired grants as inactive', () => {
    expect(isActiveRemoteDevice(device(), NOW)).toBe(true)
    expect(isActiveRemoteDevice(device({ revokedAt: '2026-08-19T11:00:00.000Z' }), NOW)).toBe(false)
    expect(isActiveRemoteDevice(device({ expiresAt: '2026-08-19T12:00:00.000Z' }), NOW)).toBe(false)
  })

  it('detects a newly paired active device without confusing an old grant', () => {
    const knownIds = new Set(['device-1'])

    expect(hasNewActiveRemoteDevice([
      device({ id: 'device-1' }),
      device({ id: 'device-2', name: 'Tablet' }),
    ], knownIds, NOW)).toBe(true)
    expect(hasNewActiveRemoteDevice([
      device({ id: 'device-1' }),
      device({ id: 'expired', expiresAt: '2026-08-19T11:00:00.000Z' }),
    ], knownIds, NOW)).toBe(false)
  })
})
