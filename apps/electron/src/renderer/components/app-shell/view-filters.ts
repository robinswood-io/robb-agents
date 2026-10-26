import type { ChatGroupingMode } from './SessionList'

export type FilterMode = 'include' | 'exclude'
export type FilterEntry = Record<string, FilterMode>
export type ViewFiltersMap = Record<string, {
  statuses: FilterEntry
  labels: FilterEntry
  projects?: FilterEntry
  groupingMode?: ChatGroupingMode
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readFilter(value: unknown): FilterEntry {
  const entries: Array<[string, FilterMode]> = []
  if (Array.isArray(value)) {
    for (const id of value) {
      if (typeof id === 'string') entries.push([id, 'include'])
    }
  } else if (isRecord(value)) {
    for (const [id, mode] of Object.entries(value)) {
      if (mode === 'include' || mode === 'exclude') entries.push([id, mode])
    }
  }
  return Object.fromEntries(entries)
}

/** Read both persisted filter formats without trusting the shape of local JSON. */
export function decodeViewFilters(value: unknown, oldStatuses: unknown = [], oldLabels: unknown = []): ViewFiltersMap {
  const saved: ViewFiltersMap = {}
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (!isRecord(entry)) continue
      const filters: ViewFiltersMap[string] = {
        statuses: readFilter(entry.statuses),
        labels: readFilter(entry.labels),
      }
      if (isRecord(entry.projects)) filters.projects = readFilter(entry.projects)
      const grouping = entry.groupingMode
      if (grouping === 'date' || grouping === 'status' || grouping === 'unread' || grouping === 'project') {
        filters.groupingMode = grouping
      }
      Object.defineProperty(saved, key, { value: filters, enumerable: true, writable: true, configurable: true })
    }
  }
  if (!saved.allSessions) {
    const statuses = readFilter(oldStatuses)
    const labels = readFilter(oldLabels)
    if (Object.keys(statuses).length || Object.keys(labels).length) saved.allSessions = { statuses, labels }
  }
  return saved
}
