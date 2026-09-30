import { describe, expect, it } from 'bun:test'
import { getPermissionModeReconciliationTarget } from './permission-mode-reconciliation'

describe('permission-mode reconciliation target', () => {
  it('selects only the active session from a large cold catalogue', () => {
    const sessions = Array.from({ length: 2_185 }, (_, index) => ({ id: `session-${index}` }))

    expect(getPermissionModeReconciliationTarget(sessions, 'session-2184')).toBe('session-2184')
  })

  it('does not reconcile the catalogue when no valid session is selected', () => {
    const sessions = [{ id: 'session-1' }, { id: 'session-2' }]

    expect(getPermissionModeReconciliationTarget(sessions, null)).toBeNull()
    expect(getPermissionModeReconciliationTarget(sessions, 'missing')).toBeNull()
  })
})
