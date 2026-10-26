import { describe, expect, it } from 'bun:test'
import { decodeViewFilters, type ViewFiltersMap } from '../view-filters'

describe('persisted view filters', () => {
  it('preserves current filters, project choices and grouping', () => {
    const saved = { allSessions: { statuses: { done: 'exclude' }, labels: { finance: 'include' }, projects: { local: 'exclude' }, groupingMode: 'project' } } satisfies ViewFiltersMap
    expect(decodeViewFilters(saved, ['legacy'], ['old-label'])).toEqual(saved)
  })

  it('migrates every legacy view in a mixed version profile', () => {
    expect(decodeViewFilters({
      allSessions: { statuses: { done: 'exclude' }, labels: {} },
      flagged: { statuses: ['todo'], labels: ['qa'] },
    })).toEqual({
      allSessions: { statuses: { done: 'exclude' }, labels: {} },
      flagged: { statuses: { todo: 'include' }, labels: { qa: 'include' } },
    })
  })

  it('recovers legacy global filters when no all-sessions entry exists', () => {
    expect(decodeViewFilters({}, ['todo'], ['qa'])).toEqual({
      allSessions: { statuses: { todo: 'include' }, labels: { qa: 'include' } },
    })
  })

  it('survives incomplete or damaged persisted values', () => {
    expect(decodeViewFilters({ flagged: { statuses: ['todo', 4, null], labels: null }, broken: null })).toEqual({
      flagged: { statuses: { todo: 'include' }, labels: {} },
    })
    expect(decodeViewFilters(null, null, 42)).toEqual({})
  })

  it('keeps arbitrary filter identifiers as data properties', () => {
    const saved = decodeViewFilters(JSON.parse('{"__proto__":{"statuses":["__proto__"],"labels":[]}}'))
    expect(Object.hasOwn(saved, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(saved)).toBe(Object.prototype)
    expect(Object.hasOwn(saved['__proto__']!.statuses, '__proto__')).toBe(true)
  })
})
