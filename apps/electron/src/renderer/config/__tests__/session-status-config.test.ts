import { describe, it, expect } from 'bun:test'
import {
  getStateIconStyle,
  getStatusIconStyle,
  resolveLabelDisplayName,
  resolveStatusDisplayLabel,
  type SessionStatus,
} from '../session-status-config'

function makeStatus(overrides: Partial<SessionStatus>): SessionStatus {
  return {
    id: 'todo',
    label: 'Todo',
    resolvedColor: 'var(--foreground)',
    icon: '●',
    iconColorable: true,
    ...overrides,
  }
}

const t = (key: string, options: { defaultValue: string }) => {
  const translations: Record<string, string> = {
    'status.todo': 'À faire',
    'label.default.development': 'Développement',
  }
  return translations[key] ?? options.defaultValue
}

describe('session-status-config icon style helpers', () => {
  it('getStatusIconStyle returns color style for colorable icons', () => {
    const status = makeStatus({ iconColorable: true, resolvedColor: 'var(--accent)' })

    expect(getStatusIconStyle(status)).toEqual({ color: 'var(--accent)' })
  })

  it('getStatusIconStyle returns undefined for non-colorable icons (emoji/images)', () => {
    const status = makeStatus({ icon: '✅', iconColorable: false, resolvedColor: 'var(--foreground)' })

    expect(getStatusIconStyle(status)).toBeUndefined()
  })

  it('getStateIconStyle resolves by id and applies same colorability rule', () => {
    const states: SessionStatus[] = [
      makeStatus({ id: 'todo', icon: '✅', iconColorable: false, resolvedColor: 'var(--foreground)' }),
      makeStatus({ id: 'in-progress', iconColorable: true, resolvedColor: 'var(--success)' }),
    ]

    expect(getStateIconStyle('todo', states)).toBeUndefined()
    expect(getStateIconStyle('in-progress', states)).toEqual({ color: 'var(--success)' })
    expect(getStateIconStyle('missing', states)).toBeUndefined()
  })
})

describe('session-status-config i18n display helpers', () => {
  it('translates built-in default statuses only when they were not renamed', () => {
    expect(resolveStatusDisplayLabel({ id: 'todo', label: 'Todo' }, t)).toBe('À faire')
    expect(resolveStatusDisplayLabel({ id: 'todo', label: 'À traiter client' }, t)).toBe('À traiter client')
    expect(resolveStatusDisplayLabel({ id: 'client-review', label: 'Client Review' }, t)).toBe('Client Review')
  })

  it('translates built-in default labels only when they were not renamed', () => {
    expect(resolveLabelDisplayName({ id: 'development', name: 'Development' }, t)).toBe('Développement')
    expect(resolveLabelDisplayName({ id: 'development', name: 'Dev client' }, t)).toBe('Dev client')
    expect(resolveLabelDisplayName({ id: 'client', name: 'Client' }, t)).toBe('Client')
  })
})
