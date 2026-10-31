import * as React from 'react';
import niceTicks from 'nice-ticks';
import { isJsonObject, isUnknownArray, omitUndefined } from '@craft-agent/shared/utils/json';

import { cn } from "../../lib/utils";









// ── Types ────────────────────────────────────────────────────────────────────

export interface ColumnDef {
  key: string
  label: string
  type?: 'text' | 'number' | 'currency' | 'percent' | 'boolean' | 'date' | 'badge' | 'formula'
  align?: 'left' | 'center' | 'right'
}


export interface DatatableData {
  title?: string | undefined
  filename?: string | undefined
  sheetName?: string | undefined
  columns: ColumnDef[]
  rows: Record<string, unknown>[]
}


export interface DatatableSpec extends Pick<DatatableData, 'title' | 'filename' | 'sheetName'> {
  src?: string
  columns?: ColumnDef[]
  rows?: Record<string, unknown>[]
}

const COLUMN_TYPES = ['text', 'number', 'currency', 'percent', 'boolean', 'date', 'badge', 'formula'] as const;
const COLUMN_ALIGNMENTS = ['left', 'center', 'right'] as const;

function readColumns(value: unknown): ColumnDef[] | null {
  if (!isUnknownArray(value)) return null;
  const columns: ColumnDef[] = [];
  for (const entry of value) {
    if (!isJsonObject(entry) || typeof entry['key'] !== 'string') return null;
    columns.push(omitUndefined<ColumnDef>({
      key: entry['key'],
      label: typeof entry['label'] === 'string' ? entry['label'] : entry['key'],
      type: COLUMN_TYPES.find(type => type === entry['type']),
      align: COLUMN_ALIGNMENTS.find(align => align === entry['align']),
    }));
  }
  return columns;
}

function readRows(value: unknown): Record<string, unknown>[] | null {
  return isUnknownArray(value) && value.every(isJsonObject) ? value : null;
}

function readMetadata(value: Record<string, unknown>): Pick<DatatableData, 'title' | 'filename' | 'sheetName'> {
  return omitUndefined({
    title: typeof value['title'] === 'string' ? value['title'] : undefined,
    filename: typeof value['filename'] === 'string' ? value['filename'] : undefined,
    sheetName: typeof value['sheetName'] === 'string' ? value['sheetName'] : undefined,
  });
}

/** Validate the existing inline/file-backed table format before rendering it. */
export function parseDatatableSpec(code: string): DatatableSpec | null {
  const raw: unknown = JSON.parse(code);
  if (!isJsonObject(raw)) return null;
  const src = typeof raw['src'] === 'string' ? raw['src'] : undefined;
  const columns = raw['columns'] === undefined ? undefined : readColumns(raw['columns']);
  const rows = raw['rows'] === undefined ? undefined : readRows(raw['rows']);
  if (columns === null || rows === null || (!src && (!columns || !rows))) return null;
  return omitUndefined<DatatableSpec>({ ...readMetadata(raw), src, columns, rows });
}

/** File payloads contain a rows array, optionally with columns and display metadata. */
export function parseTabularFile(code: string): DatatableData | null {
  const raw: unknown = JSON.parse(code);
  const record: Record<string, unknown> = isJsonObject(raw) ? raw : { rows: raw };
  const columns = readColumns(record['columns'] ?? []);
  const rows = readRows(record['rows']);
  if (!columns || !rows) return null;
  return omitUndefined<DatatableData>({ ...readMetadata(record), columns, rows });
}


export type SortDir = 'asc' | 'desc' | null


// ── Cell formatting ──────────────────────────────────────────────────────────

export function formatCell(value: unknown, type?: ColumnDef['type']): React.ReactNode {
  if (value === null || value === undefined) return <span className="text-muted-foreground/40">—</span>
  switch (type) {
    case 'currency': {
      const num = typeof value === 'number' ? value : Number(value)
      if (isNaN(num)) return String(value)
      return <span className="tabular-nums">{num.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>
    }
    case 'percent': {
      const pct = typeof value === 'number' ? value : Number(value)
      if (isNaN(pct)) return String(value)
      const formatted = (pct * 100).toFixed(1) + '%'
      const positive = pct > 0
      return <span className={cn('tabular-nums', positive && 'text-success', pct < 0 && 'text-destructive')}>{positive ? '+' : ''}{formatted}</span>
    }
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value)
      if (isNaN(n)) return String(value)
      return <span className="tabular-nums">{n.toLocaleString()}</span>
    }
    case 'boolean':
      return value ? <span className="text-success">Yes</span> : <span className="text-muted-foreground">No</span>
    case 'badge': {
      const s = String(value).toLowerCase()
      const color = s === 'active' || s === 'passing' || s === 'success' || s === 'done'
        ? 'bg-success/10 text-success'
        : s === 'revoked' || s === 'failed' || s === 'error'
        ? 'bg-destructive/10 text-destructive'
        : 'bg-muted text-muted-foreground'
      return <span className={cn('inline-block px-1.5 py-0.5 rounded text-[11px] font-medium', color)}>{String(value)}</span>
    }
    default:
      return String(value)
  }
}


export function colAlign(type?: ColumnDef['type'], explicit?: string): string {
  if (explicit) return `text-${explicit}`
  if (type === 'number' || type === 'currency' || type === 'percent') return 'text-right'
  return 'text-left'
}


// ── Sort icon ────────────────────────────────────────────────────────────────

export function SortIcon({ dir }: { dir: SortDir }) {
  return (
    <svg className={cn('w-3 h-3 shrink-0', dir ? 'opacity-60' : 'opacity-20')} viewBox="0 0 16 16" fill="currentColor">
      {dir === 'asc' ? (
        <path d="M8 3l4 5H4l4-5z" />
      ) : dir === 'desc' ? (
        <path d="M8 13l4-5H4l4 5z" />
      ) : (
        <>
          <path d="M8 3l3 4H5l3-4z" />
          <path d="M8 13l3-4H5l3 4z" />
        </>
      )}
    </svg>
  )
}


// ── Grouping granularity ─────────────────────────────────────────────────

export interface GranularityOption {
  label: string
  value: string
}


export const DATE_GRANULARITIES: GranularityOption[] = [
  { label: 'Hour', value: 'hour' },
  { label: 'Day', value: 'day' },
  { label: 'Month', value: 'month' },
  { label: 'Year', value: 'year' },
]


export function formatCompact(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1e9) return (n / 1e9).toFixed(abs >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B'
  if (abs >= 1e6) return (n / 1e6).toFixed(abs >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M'
  if (abs >= 1e3) return (n / 1e3).toFixed(abs >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K'
  if (abs >= 1) return String(Math.round(n))
  if (abs >= 0.01) return n.toFixed(2)
  return String(n)
}


export function computeNumericGranularities(values: number[], type: 'number' | 'currency' | 'percent'): GranularityOption[] {
  if (values.length < 2) return []
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (min === max) return []

  const tickCounts = [3, 5, 8, 15]
  const seen = new Set<number>()
  const options: GranularityOption[] = [{ label: 'Exact', value: 'exact' }]

  for (const count of tickCounts) {
    const ticks = niceTicks(min, max, count)
    if (ticks.length < 2) continue
    const step = Math.abs(ticks[1]! - ticks[0]!)
    if (step <= 0 || seen.has(step)) continue
    seen.add(step)

    let label: string
    if (type === 'percent') {
      label = formatCompact(step * 100) + '%'
    } else if (type === 'currency') {
      label = '$' + formatCompact(step)
    } else {
      label = formatCompact(step)
    }
    options.push({ label, value: String(step) })
  }

  return options.length > 1 ? options : []
}


export function computeDateGranularities(values: number[]): GranularityOption[] {
  if (values.length < 2) return DATE_GRANULARITIES
  const min = Math.min(...values)
  const max = Math.max(...values)
  const spanMs = max - min
  const DAY = 86400_000
  const MONTH = 30 * DAY
  const YEAR = 365 * DAY

  const opts: GranularityOption[] = []
  if (spanMs < 2 * YEAR) opts.push({ label: 'Hour', value: 'hour' })
  if (spanMs >= 2 * DAY || spanMs < 2 * YEAR) opts.push({ label: 'Day', value: 'day' })
  if (spanMs >= 2 * MONTH) opts.push({ label: 'Month', value: 'month' })
  if (spanMs >= 2 * YEAR) opts.push({ label: 'Year', value: 'year' })
  return opts.length ? opts : DATE_GRANULARITIES
}


export function computeGranularityOptions(data: DatatableData): Map<string, GranularityOption[]> {
  const result = new Map<string, GranularityOption[]>()
  for (const col of data.columns) {
    if (col.type === 'date') {
      const timestamps = data.rows
        .map((r) => new Date(r[col.key] as string | number).getTime())
        .filter((t) => !isNaN(t))
      result.set(col.key, computeDateGranularities(timestamps))
    } else if (col.type === 'number' || col.type === 'currency' || col.type === 'percent') {
      const nums = data.rows
        .map((r) => typeof r[col.key] === 'number' ? r[col.key] as number : Number(r[col.key]))
        .filter((n) => !isNaN(n))
      const opts = computeNumericGranularities(nums, col.type)
      if (opts.length > 0) result.set(col.key, opts)
    }
    // text, badge, boolean → no entry → no sub-menu
  }
  return result
}


export function bucketValue(value: unknown, type: ColumnDef['type'], granularity: string): string {
  if (value === null || value === undefined) return '—'

  if (type === 'date') {
    const d = new Date(value as string | number)
    if (isNaN(d.getTime())) return String(value)
    switch (granularity) {
      case 'hour': return d.toLocaleDateString() + ' ' + d.getHours() + ':00'
      case 'day': return d.toLocaleDateString()
      case 'month': return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' })
      case 'year': return String(d.getFullYear())
    }
  }

  if (type === 'number' || type === 'currency' || type === 'percent') {
    const n = typeof value === 'number' ? value : Number(value)
    if (isNaN(n)) return String(value)
    if (granularity === 'exact') {
      if (type === 'currency') return '$' + n.toLocaleString()
      if (type === 'percent') return (n * 100).toFixed(1) + '%'
      return n.toLocaleString()
    }
    const size = parseFloat(granularity)
    if (!size) return String(n)
    const lo = Math.floor(n / size) * size
    const hi = lo + size
    if (type === 'percent') return `${(lo * 100).toFixed(0)}%–${(hi * 100).toFixed(0)}%`
    if (type === 'currency') return `$${formatCompact(lo)}–$${formatCompact(hi)}`
    return `${formatCompact(lo)}–${formatCompact(hi)}`
  }

  return String(value)
}


export function defaultGranularity(type: ColumnDef['type'], options: GranularityOption[]): string {
  if (!options.length) return 'exact'
  if (type === 'date') return options.find((o) => o.value === 'day')?.value ?? options[0]!.value
  // For numeric: pick the second option (first non-Exact) if available
  return options.length > 1 ? options[1]!.value : options[0]!.value
}


// ── Error boundary ───────────────────────────────────────────────────────────

export class DatatableErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { hasError: boolean }
> {
  override state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  override componentDidCatch(error: Error) {
    console.warn('[MarkdownDatatableBlock] Render failed, falling back to CodeBlock:', error)
  }
  override render() {
    if (this.state.hasError) return this.props.fallback
    return this.props.children
  }
}


// ── Main component ───────────────────────────────────────────────────────────

export interface MarkdownDatatableBlockProps {
  code: string
  className?: string | undefined
}
