import { useState } from "react";
import { Flag, Zap, Search } from "lucide-react";
import { EntityRow } from "@/components/ui/entity-row";
import { EntityList } from "@/components/ui/entity-list";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { useEntityListInteractions } from "@/hooks/useEntityListInteractions";
import { formatRelativeTime, MockMenuItems, MockAvatar, TypeBadge, StatusBadge } from "./primitives";
import type { AnyMockEntity } from "./fixtures";
import { interactiveItems, SOURCE_TYPE_CONFIG, SOURCE_STATUS_CONFIG } from "./fixtures";

interface InteractiveEntityListPreviewProps {
  enableSearch?: boolean
  enableMultiSelect?: boolean
  enableKeyboard?: boolean
}

export function InteractiveEntityListPreview({
  enableSearch = true,
  enableMultiSelect = true,
  enableKeyboard = true,
}: InteractiveEntityListPreviewProps) {
  const [query, setQuery] = useState('')
  const [activatedItem, setActivatedItem] = useState<string | null>(null)

  const { items, listProps, getRowProps, searchInputProps, keyboard, selection } = useEntityListInteractions({
    items: interactiveItems,
    getId: (item) => item.id,
    keyboard: enableKeyboard ? {
      onActivate: (item) => {
        setActivatedItem(item.name)
        setTimeout(() => setActivatedItem(null), 1500)
      },
      virtualFocus: enableSearch && query.length > 0,
    } : undefined,
    multiSelect: enableMultiSelect,
    search: enableSearch ? {
      query,
      fn: (item, q) => item.name.toLowerCase().includes(q.toLowerCase()),
    } : undefined,
  })

  const renderEntityRow = (item: AnyMockEntity, index: number, isFirst: boolean) => {
    const rowProps = getRowProps(item, index)

    switch (item.kind) {
      case 'session': {
        return (
          <EntityRow
            {...rowProps}
            icon={
              <div className="w-4 h-4 flex items-center justify-center [&>svg]:w-full [&>svg]:h-full" style={{ color: item.status.color }}>
                {item.status.icon}
              </div>
            }
            title={item.name}
            badges={
              <>
                {item.hasUnread && <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded bg-accent text-white">New</span>}
                {item.isFlagged && (
                  <span className="shrink-0 h-[18px] w-[18px] flex items-center justify-center rounded bg-foreground/5">
                    <Flag className="h-[10px] w-[10px] text-info fill-info" />
                  </span>
                )}
              </>
            }
            trailing={item.lastMessageAt ? <span className="text-[11px] text-foreground/40">{formatRelativeTime(item.lastMessageAt)}</span> : undefined}
            showSeparator={!isFirst}
            menuContent={<MockMenuItems />}
          />
        )
      }
      case 'source': {
        const typeConfig = SOURCE_TYPE_CONFIG[item.type]
        const statusConfig = SOURCE_STATUS_CONFIG[item.status]
        return (
          <EntityRow
            {...rowProps}
            icon={<MockAvatar icon={item.icon} color="text-muted-foreground" label={item.name} />}
            title={item.name}
            badges={
              <>
                {typeConfig && <TypeBadge label={typeConfig.label} colorClass={typeConfig.colorClass} />}
                {statusConfig && <StatusBadge label={statusConfig.label} colorClass={statusConfig.colorClass} />}
                <span className="truncate">{item.tagline}</span>
              </>
            }
            showSeparator={!isFirst}
            menuContent={<MockMenuItems />}
          />
        )
      }
      case 'skill': {
        return (
          <EntityRow
            {...rowProps}
            icon={
              item.emoji ? (
                <div className="w-5 h-5 rounded-[4px] ring-1 ring-border/30 shrink-0 flex items-center justify-center bg-muted text-sm leading-none">
                  {item.emoji}
                </div>
              ) : (
                <MockAvatar icon={Zap} color="text-muted-foreground" label={item.name} />
              )
            }
            title={item.name}
            badges={<span className="truncate">{item.description}</span>}
            showSeparator={!isFirst}
            menuContent={<MockMenuItems />}
          />
        )
      }
    }
  }

  return (
    <div className="w-[340px] flex flex-col gap-3">
      {/* Status bar */}
      <div className="flex items-center gap-2 text-xs text-foreground/50 px-1">
        <span>{items.length} items</span>
        {selection.isMultiSelectActive && (
          <>
            <span className="text-foreground/20">|</span>
            <span className="text-accent">{selection.selectedIds.size} selected</span>
            <button
              className="text-accent hover:underline cursor-pointer"
              onClick={selection.clear}
            >
              Clear
            </button>
          </>
        )}
        {activatedItem && (
          <>
            <span className="text-foreground/20">|</span>
            <span className="text-success animate-in fade-in">Activated: {activatedItem}</span>
          </>
        )}
      </div>

      {/* List */}
      <div className="h-[520px] flex flex-col border border-border rounded-lg overflow-hidden bg-background">
        <EntityList
          {...listProps}
          items={items}
          getKey={(item) => item.id}
          header={enableSearch ? (
            <div className="px-3 py-2 border-b border-border">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-foreground/40" />
                <input
                  className="w-full h-8 pl-8 pr-3 text-sm bg-foreground/3 rounded-md border border-transparent focus:border-border focus:outline-none placeholder:text-foreground/30"
                  placeholder="Search entities..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  {...searchInputProps}
                />
              </div>
            </div>
          ) : undefined}
          emptyState={
            <Empty className="flex-1">
              <EmptyHeader>
                <EmptyMedia variant="icon"><Search /></EmptyMedia>
                <EmptyTitle>No results</EmptyTitle>
                <EmptyDescription>Try a different search term.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          }
          renderItem={renderEntityRow}
        />
      </div>

      {/* Instructions */}
      <div className="text-[11px] text-foreground/40 space-y-0.5 px-1">
        {enableKeyboard && <div>Arrow keys to navigate, Enter to activate</div>}
        {enableMultiSelect && <div>Cmd+Click to toggle, Shift+Click to range select</div>}
        {enableSearch && <div>Type in the search box to filter</div>}
      </div>
    </div>
  )
}
