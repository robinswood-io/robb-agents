import { parseDatatableSpec, parseTabularFile } from './datatable-values'
/**
 * MarkdownDatatableBlock - Interactive data table for markdown ```datatable code blocks
 *
 * Renders structured JSON as a sortable table with fullscreen expand.
 * No TanStack dependency — uses native HTML table + React state for lightweight
 * portability across Electron and the web viewer.
 *
 * Expected JSON shape (inline):
 * {
 *   "title": "Sales by Region",
 *   "columns": [{ "key": "region", "label": "Region", "type": "text" }],
 *   "rows": [{ "region": "North America" }]
 * }
 *
 * File-backed shape (src field):
 * {
 *   "src": "data/transactions.json",
 *   "title": "Transactions",
 *   "columns": [{ "key": "id", "label": "ID", "type": "text" }]
 * }
 *
 * When `src` is present, rows are loaded from the file via PlatformContext.onReadFile.
 * The file can contain full {title, columns, rows} or just a rows array [...].
 * Inline title/columns take precedence over file values.
 *
 * Falls back to CodeBlock if JSON parsing fails.
 */

import * as React from 'react';
import "nice-ticks";
import { ArrowUpDown, Check, ChevronRight, Group, ListFilter, Maximize2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { CodeBlock } from './CodeBlock';
import { DataTableOverlay } from '../overlay/DataTableOverlay';
import { useScrollFade } from './useScrollFade';
import { TableExportDropdown } from './TableExportDropdown';
import { usePlatform } from '../../context/PlatformContext';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuSub, StyledDropdownMenuContent, StyledDropdownMenuItem, StyledDropdownMenuSeparator, StyledDropdownMenuSubTrigger, StyledDropdownMenuSubContent } from '../ui/StyledDropdown';
import { useTranslation } from 'react-i18next';

import { type DatatableData, type DatatableSpec, type SortDir, formatCell, colAlign, SortIcon, type GranularityOption, computeGranularityOptions, bucketValue, DatatableErrorBoundary, type MarkdownDatatableBlockProps } from "./datatable-values";
export { type MarkdownDatatableBlockProps } from "./datatable-values";












export function MarkdownDatatableBlock({ code, className }: MarkdownDatatableBlockProps) {
  const { t } = useTranslation()
  const { onReadFile } = usePlatform()

  // Parse the inline JSON spec (may have src field for file-backed data)
  const spec = React.useMemo<DatatableSpec | null>(() => {
    try { return parseDatatableSpec(code) } catch { return null }
  }, [code])

  // Load file data when src is present
  const [fileData, setFileData] = React.useState<DatatableData | null>(null)
  const [fileError, setFileError] = React.useState<string | null>(null)
  const [fileLoading, setFileLoading] = React.useState(false)

  React.useEffect(() => {
    if (!spec?.src || !onReadFile) return
    setFileLoading(true)
    setFileError(null)
    onReadFile(spec.src)
      .then((content) => {
        try {
          const parsed = parseTabularFile(content)
          if (parsed) setFileData(parsed)
          else setFileError('File does not contain valid datatable data')
        } catch {
          setFileError('Failed to parse data file as JSON')
        }
      })
      .catch((err: unknown) => {
        setFileError(err instanceof Error ? err.message : 'Failed to read data file')
      })
      .finally(() => setFileLoading(false))
  }, [spec?.src, onReadFile])

  // Merge: inline spec takes precedence, file provides rows
  const parsed = React.useMemo<DatatableData | null>(() => {
    if (!spec) return null
    if (spec.src) {
      if (!fileData) return null // Still loading or error
      return {
        title: spec.title ?? fileData.title,
        columns: (spec.columns && spec.columns.length > 0) ? spec.columns : fileData.columns,
        rows: fileData.rows,
      }
    }
    // Inline data - must have columns and rows
    if (!Array.isArray(spec.columns) || !Array.isArray(spec.rows)) return null
    return { title: spec.title, columns: spec.columns, rows: spec.rows }
  }, [spec, fileData])

  const [{ key: sortKey, direction: sortDir }, setSort] = React.useState<{
    key: string | null
    direction: SortDir
  }>({ key: null, direction: null })
  const [isFullscreen, setIsFullscreen] = React.useState(false)
  const [groupKey, setGroupKey] = React.useState<string | null>(null)
  const [groupGranularity, setGroupGranularity] = React.useState<string>('exact')
  const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(new Set())
  const { scrollRef, maskImage } = useScrollFade()

  const handleSort = React.useCallback((key: string) => {
    setSort((prev) => ({
      key,
      direction: prev.key !== key ? 'asc'
        : prev.direction === 'asc' ? 'desc' : prev.direction === 'desc' ? null : 'asc',
    }))
  }, [])

  const processedRows = React.useMemo(() => {
    if (!parsed) return []
    let rows = [...parsed.rows]
    // Sort
    if (sortKey && sortDir) {
      rows.sort((a, b) => {
        const av = a[sortKey]
        const bv = b[sortKey]
        if (av === bv) return 0
        if (av === null || av === undefined) return 1
        if (bv === null || bv === undefined) return -1
        const cmp = typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv))
        return sortDir === 'asc' ? cmp : -cmp
      })
    }
    return rows
  }, [parsed, sortKey, sortDir])

  const granularityOptions = React.useMemo(() => {
    if (!parsed) return new Map<string, GranularityOption[]>()
    return computeGranularityOptions(parsed)
  }, [parsed])

  const groupedData = React.useMemo(() => {
    if (!groupKey || !parsed) return null
    const col = parsed.columns.find((c) => c.key === groupKey)
    const hasGranularity = granularityOptions.has(groupKey)
    const groups: { value: string; rows: Record<string, unknown>[] }[] = []
    const map = new Map<string, Record<string, unknown>[]>()
    for (const row of processedRows) {
      const val = hasGranularity
        ? bucketValue(row[groupKey], col?.type, groupGranularity)
        : String(row[groupKey] ?? '—')
      if (!map.has(val)) { map.set(val, []); groups.push({ value: val, rows: map.get(val)! }) }
      map.get(val)!.push(row)
    }
    return groups
  }, [processedRows, groupKey, groupGranularity, parsed, granularityOptions])

  const toggleCollapsed = React.useCallback((value: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }, [])

  const hasActiveControls = (sortKey !== null && sortDir !== null) || groupKey !== null

  const clearControls = React.useCallback(() => {
    setSort({ key: null, direction: null })
    setGroupKey(null)
    setGroupGranularity('exact')
    setCollapsedGroups(new Set())
  }, [])

  // Loading state for file-backed datatable
  if (spec?.src && fileLoading) {
    return (
      <div className={cn('rounded-[8px] overflow-hidden border bg-muted/10', className)}>
        <div className="px-3 py-2 bg-muted/50 border-b">
          <span className="text-[12px] text-muted-foreground font-medium">{spec.title || t('datatable.defaultTitle')}</span>
        </div>
        <div className="py-8 text-center text-muted-foreground text-[13px]">{t('datatable.loadingData')}</div>
      </div>
    )
  }

  // Error state for file-backed datatable
  if (spec?.src && fileError) {
    return (
      <div className={cn('rounded-[8px] overflow-hidden border bg-muted/10', className)}>
        <div className="px-3 py-2 bg-muted/50 border-b">
          <span className="text-[12px] text-muted-foreground font-medium">{spec.title || t('datatable.defaultTitle')}</span>
        </div>
        <div className="py-6 text-center text-destructive/70 text-[13px]">{fileError}</div>
      </div>
    )
  }

  if (!parsed) {
    return <CodeBlock code={code} language="json" mode="full" className={className} />
  }

  const fallback = <CodeBlock code={code} language="json" mode="full" className={className} />

  const groupColumnLabel = groupKey ? parsed.columns.find((c) => c.key === groupKey)?.label ?? groupKey : ''

  const renderRows = (rows: Record<string, unknown>[]) =>
    rows.map((row, i) => (
      <tr key={i} className="border-b border-foreground/[0.03] last:border-0 hover:bg-foreground/[0.015] transition-colors">
        {parsed.columns.map((col) => (
          <td key={col.key} className={cn('py-2 px-3 whitespace-nowrap', colAlign(col.type, col.align))}>
            {formatCell(row[col.key], col.type)}
          </td>
        ))}
      </tr>
    ))

  const tableContent = (maxHeight?: boolean, scrollable?: boolean) => (
    <div
      ref={scrollable ? scrollRef : undefined}
      className={cn(maxHeight && 'max-h-[400px]', 'overflow-y-auto')}
      style={scrollable ? {
        overflowX: 'auto',
        maskImage,
        WebkitMaskImage: maskImage,
      } : { overflowX: 'auto' }}
    >
      <table className="w-max min-w-full text-[13px]">
        <thead>
          <tr className="border-b border-foreground/[0.06] bg-foreground/[0.02]">
            {parsed.columns.map((col) => (
              <th
                key={col.key}
                className={cn('py-2 px-3 text-[12px] cursor-pointer select-none whitespace-nowrap', colAlign(col.type, col.align))}
                onClick={() => handleSort(col.key)}
              >
                <span className="inline-flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground transition-colors">
                  {col.label}
                  <SortIcon dir={sortKey === col.key ? sortDir : null} />
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groupedData ? groupedData.map((group) => (
            <React.Fragment key={group.value}>
              <tr
                className="cursor-pointer select-none"
                onClick={() => toggleCollapsed(group.value)}
              >
                <td colSpan={parsed.columns.length} className="py-2 px-3 bg-foreground/[0.03] border-b border-foreground/[0.06]">
                  <span className="inline-flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
                    <ChevronRight className={cn('w-3 h-3 transition-transform', !collapsedGroups.has(group.value) && 'rotate-90')} />
                    {groupColumnLabel}: {group.value}
                    <span className="text-muted-foreground/50">({group.rows.length})</span>
                  </span>
                </td>
              </tr>
              {!collapsedGroups.has(group.value) && renderRows(group.rows)}
            </React.Fragment>
          )) : processedRows.length ? renderRows(processedRows) : (
            <tr>
              <td colSpan={parsed.columns.length} className="py-6 text-center text-muted-foreground text-[13px]">
                No rows
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )

  const renderControlsDropdown = (alwaysVisible?: boolean) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            'p-1 rounded-[6px] transition-all select-none',
            'bg-background shadow-minimal',
            'data-[state=open]:opacity-100',
            hasActiveControls
              ? 'opacity-100 bg-accent/5 text-accent shadow-tinted'
              : alwaysVisible
                ? 'opacity-70 hover:opacity-100 transition-opacity'
                : 'opacity-0 group-hover:opacity-100 text-muted-foreground/50 hover:text-foreground',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100',
          )}
          title={t('table.tableControls')}
        >
          <ListFilter className="w-3.5 h-3.5" />
        </button>
      </DropdownMenuTrigger>
      <StyledDropdownMenuContent sideOffset={6} align="end" className="min-w-36" style={{ zIndex: 'var(--z-floating-menu, 400)' }}>
        {/* Sort sub-menu */}
        <DropdownMenuSub>
          <StyledDropdownMenuSubTrigger>
            <ArrowUpDown />
            <span className="flex-1">{t('table.sortBy')}</span>
            {sortKey && sortDir && <Check className="w-3 h-3 text-accent" />}
          </StyledDropdownMenuSubTrigger>
          <StyledDropdownMenuSubContent style={{ zIndex: 'calc(var(--z-floating-menu, 400) + 1)' }}>
            {parsed.columns.map((col) => {
              const isActive = sortKey === col.key && sortDir !== null
              return (
                <StyledDropdownMenuItem
                  key={`sort-${col.key}`}
                  onSelect={(e) => { e.preventDefault(); handleSort(col.key) }}
                >
                  <span className={cn('flex-1', isActive && 'text-accent font-medium')}>{col.label}</span>
                  {isActive && <SortIcon dir={sortDir} />}
                </StyledDropdownMenuItem>
              )
            })}
          </StyledDropdownMenuSubContent>
        </DropdownMenuSub>
        {/* Group sub-menu */}
        <DropdownMenuSub>
          <StyledDropdownMenuSubTrigger>
            <Group />
            <span className="flex-1">{t('table.groupBy')}</span>
            {groupKey && <Check className="w-3 h-3 text-accent" />}
          </StyledDropdownMenuSubTrigger>
          <StyledDropdownMenuSubContent style={{ zIndex: 'calc(var(--z-floating-menu, 400) + 1)' }}>
            {parsed.columns.map((col) => {
              const isActive = groupKey === col.key
              const opts = granularityOptions.get(col.key)

              // Typed column with granularity options → nested sub-menu
              if (opts && opts.length > 0) {
                return (
                  <DropdownMenuSub key={`group-${col.key}`}>
                    <StyledDropdownMenuSubTrigger>
                      <span className={cn('flex-1', isActive && 'text-accent font-medium')}>{col.label}</span>
                      {isActive && <Check className="w-3 h-3 text-accent" />}
                    </StyledDropdownMenuSubTrigger>
                    <StyledDropdownMenuSubContent style={{ zIndex: 'calc(var(--z-floating-menu, 400) + 2)' }}>
                      {opts.map((opt) => {
                        const optActive = isActive && groupGranularity === opt.value
                        return (
                          <StyledDropdownMenuItem
                            key={opt.value}
                            onSelect={(e) => {
                              e.preventDefault()
                              if (isActive && groupGranularity === opt.value) {
                                setGroupKey(null)
                              } else {
                                setGroupKey(col.key)
                                setGroupGranularity(opt.value)
                              }
                              setCollapsedGroups(new Set())
                            }}
                          >
                            <span className={cn('flex-1', optActive && 'text-accent font-medium')}>{opt.label}</span>
                            {optActive && <Check className="w-3.5 h-3.5 text-accent" />}
                          </StyledDropdownMenuItem>
                        )
                      })}
                    </StyledDropdownMenuSubContent>
                  </DropdownMenuSub>
                )
              }

              // Plain column (text, badge, boolean) → direct click
              return (
                <StyledDropdownMenuItem
                  key={`group-${col.key}`}
                  onSelect={(e) => {
                    e.preventDefault()
                    if (isActive) {
                      setGroupKey(null)
                    } else {
                      setGroupKey(col.key)
                      setGroupGranularity('exact')
                    }
                    setCollapsedGroups(new Set())
                  }}
                >
                  <span className={cn('flex-1', isActive && 'text-accent font-medium')}>{col.label}</span>
                  {isActive && <Check className="w-3.5 h-3.5 text-accent" />}
                </StyledDropdownMenuItem>
              )
            })}
          </StyledDropdownMenuSubContent>
        </DropdownMenuSub>
        {/* Clear */}
        {hasActiveControls && (
          <>
            <StyledDropdownMenuSeparator />
            <StyledDropdownMenuItem onSelect={clearControls}>
              <span className="text-accent">{t('common.clearAll')}</span>
            </StyledDropdownMenuItem>
          </>
        )}
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <DatatableErrorBoundary fallback={fallback}>
      <div className={cn('relative group rounded-[8px] overflow-hidden border bg-muted/10', className)}>
        {/* Control button */}
        <div className="absolute top-[7px] right-10 z-10">
          {renderControlsDropdown()}
        </div>

        {/* Expand button */}
        <button
          onClick={() => setIsFullscreen(true)}
          className={cn(
            "absolute top-[7px] right-2 p-1 rounded-[6px] transition-all z-10 select-none",
            "bg-background shadow-minimal",
            hasActiveControls ? "opacity-100" : "opacity-0 group-hover:opacity-100",
            "text-muted-foreground/50 hover:text-foreground",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100"
          )}
          title={t('common.viewFullscreen')}
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>

        {/* Header */}
        <div className="px-3 py-2 bg-muted/50 border-b">
          <span className="text-[12px] text-muted-foreground font-medium">
            {parsed.title || t('datatable.defaultTitle')}
          </span>
        </div>

        {/* Table with max height and scroll fade */}
        {tableContent(true, true)}
      </div>

      {/* Fullscreen overlay */}
      <DataTableOverlay
        isOpen={isFullscreen}
        onClose={() => setIsFullscreen(false)}
        title={parsed.title || t('datatable.defaultTitle')}
        subtitle={t('datatable.rowCount', { count: parsed.rows.length })}
        headerActions={
          <div className="flex items-center gap-1.5">
            {renderControlsDropdown(true)}
            <TableExportDropdown columns={parsed.columns} rows={parsed.rows} filename={parsed.title || t('datatable.defaultTitle')} />
          </div>
        }
      >
        <div className="px-6">
          <div className="bg-background shadow-minimal rounded-[12px] overflow-hidden">
            {tableContent(false)}
          </div>
        </div>
      </DataTableOverlay>
    </DatatableErrorBoundary>
  )
}
