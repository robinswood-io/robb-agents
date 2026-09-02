import { describe, expect, it } from 'bun:test'
import type { WorkspaceStatusConfig } from '@craft-agent/shared/statuses'
import {
  resolveLifecycleStartStatus,
  resolveLifecycleTerminalStatus,
} from './session-status-lifecycle'

const config: WorkspaceStatusConfig = {
  version: 1,
  defaultStatusId: 'todo',
  statuses: [
    { id: 'todo', label: 'À faire', category: 'open', isFixed: true, isDefault: true, order: 0 },
    { id: 'in-progress', label: 'En cours', category: 'open', isFixed: false, isDefault: false, order: 1 },
    { id: 'blocked', label: 'Bloqué', category: 'open', isFixed: false, isDefault: false, order: 2 },
    { id: 'needs-review', label: 'À valider', category: 'open', isFixed: false, isDefault: false, order: 3 },
    { id: 'done', label: 'Terminé', category: 'closed', isFixed: true, isDefault: false, order: 4 },
  ],
}

describe('automatic session status lifecycle', () => {
  it('moves an unassigned or default task to in-progress', () => {
    expect(resolveLifecycleStartStatus(config, undefined)).toBe('in-progress')
    expect(resolveLifecycleStartStatus(config, 'todo')).toBe('in-progress')
  })

  it('never reopens a user-closed task or replaces a custom workflow status', () => {
    expect(resolveLifecycleStartStatus(config, 'done')).toBeUndefined()
    const custom = {
      ...config,
      statuses: [...config.statuses, {
        id: 'legal-review', label: 'Legal review', category: 'open' as const,
        isFixed: false, isDefault: false, order: 5,
      }],
    }
    expect(resolveLifecycleStartStatus(custom, 'legal-review')).toBeUndefined()
  })

  it('hands successful work to review and exhausted failures to blocked', () => {
    expect(resolveLifecycleTerminalStatus(config, 'complete')).toBe('needs-review')
    expect(resolveLifecycleTerminalStatus(config, 'error')).toBe('blocked')
    expect(resolveLifecycleTerminalStatus(config, 'timeout')).toBe('blocked')
    expect(resolveLifecycleTerminalStatus(config, 'interrupted')).toBeUndefined()
  })

  it('falls back to an existing open status when custom states are absent', () => {
    const minimal: WorkspaceStatusConfig = {
      version: 1,
      defaultStatusId: 'todo',
      statuses: [
        { id: 'todo', label: 'Todo', category: 'open', isFixed: true, isDefault: true, order: 0 },
        { id: 'done', label: 'Done', category: 'closed', isFixed: true, isDefault: false, order: 1 },
      ],
    }
    expect(resolveLifecycleStartStatus(minimal, undefined)).toBe('todo')
    expect(resolveLifecycleTerminalStatus(minimal, 'complete')).toBe('todo')
  })
})
