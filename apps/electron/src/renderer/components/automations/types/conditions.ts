import type { AutomationConditionUI } from './contracts.ts';

/** Human-friendly field names for state conditions */
const FIELD_LABELS: Record<string, string> = {
  permissionMode: 'permission mode',
  sessionStatus: 'session status',
  isFlagged: 'flagged',
  labels: 'label',
  sessionName: 'session name',
}

/** Get a readable field name, falling back to the raw field */
function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field
}

/** Produce a short human-readable label for a single leaf condition */
function describeLeaf(c: AutomationConditionUI): string {
  switch (c.condition) {
    case 'time': {
      const parts: string[] = []
      if (c.weekday?.length) parts.push(c.weekday.join(', '))
      if (c.after) parts.push(`after ${c.after}`)
      if (c.before) parts.push(`before ${c.before}`)
      if (c.timezone) parts.push(`(${c.timezone})`)
      return parts.length ? parts.join(' ') : 'any time'
    }
    case 'state': {
      const label = fieldLabel(c.field)
      if (c.from !== undefined || c.to !== undefined) {
        const from = c.from !== undefined ? String(c.from) : 'any'
        const to = c.to !== undefined ? String(c.to) : 'any'
        return `${label} changed from ${from} to ${to}`
      }
      if (c.contains) return `has ${label} "${c.contains}"`
      if (c.not_value !== undefined) {
        if (c.field === 'isFlagged') return c.not_value ? 'not flagged' : 'is flagged'
        return `${label} is not ${String(c.not_value)}`
      }
      if (c.value !== undefined) {
        if (c.field === 'isFlagged') return c.value ? 'is flagged' : 'not flagged'
        return `${label} is ${String(c.value)}`
      }
      return label
    }
    case 'and':
    case 'or':
    case 'not': {
      const sep = c.condition === 'not' ? ' and not ' : ` ${c.condition} `
      return c.conditions.map(describeLeaf).join(sep)
    }
    default:
      return 'unknown condition'
  }
}

/**
 * Flatten a condition tree into displayable rows.
 * Logical conditions are expanded so their children appear as joined text.
 * Returns an array of { label, description } for rendering in Info_Table.
 */
export function flattenConditions(conditions: AutomationConditionUI[]): { label: string; description: string }[] {
  const rows: { label: string; description: string }[] = []
  for (const c of conditions) {
    if (c.condition === 'and' || c.condition === 'or' || c.condition === 'not') {
      // Flatten: join inner descriptions with the operator
      const sep = c.condition === 'not' ? ' and not ' : ` ${c.condition} `
      const inner = c.conditions.map(describeLeaf).join(sep)
      // Use the label of the first child type, or 'Condition' as fallback
      const firstChild = c.conditions[0]
      const label = firstChild
        ? firstChild.condition === 'time' ? 'Time'
          : firstChild.condition === 'state' ? 'State'
          : 'Condition'
        : 'Condition'
      rows.push({ label, description: inner })
    } else {
      const label = c.condition === 'time' ? 'Time' : c.condition === 'state' ? 'State' : 'Condition'
      rows.push({ label, description: describeLeaf(c) })
    }
  }
  return rows
}
