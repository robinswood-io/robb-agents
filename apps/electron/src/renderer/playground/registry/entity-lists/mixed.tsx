import { Flag, Zap, DatabaseZap } from "lucide-react";
import { EntityRow } from "@/components/ui/entity-row";
import { EntityList } from "@/components/ui/entity-list";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { formatRelativeTime, MockMenuItems, MockAvatar, TypeBadge, StatusBadge } from "./primitives";
import type { MockSource, MockSkill } from "./fixtures";
import { sampleSessions, sampleSources, sampleSkills, SOURCE_TYPE_CONFIG, SOURCE_STATUS_CONFIG } from "./fixtures";

// ============================================================================
// Preview: Mixed Entity List (all three types grouped)
// ============================================================================

interface MixedEntityListPreviewProps {
  showGroups?: boolean | undefined
  selectedIndex?: number | undefined
  showEmpty?: boolean | undefined
}

type MixedEntity =
  | { kind: 'session'; data: typeof sampleSessions[0] }
  | { kind: 'source'; data: MockSource }
  | { kind: 'skill'; data: MockSkill }

export function MixedEntityListPreview({
  showGroups = true,
  selectedIndex = -1,
  showEmpty = false,
}: MixedEntityListPreviewProps) {
  if (showEmpty) {
    return (
      <div className="w-[320px] h-[480px] flex flex-col border border-border rounded-lg overflow-hidden bg-background">
        <EntityList
          items={[]}
          getKey={() => ''}
          renderItem={() => null}
          emptyState={
            <Empty className="flex-1">
              <EmptyHeader>
                <EmptyMedia variant="icon"><DatabaseZap /></EmptyMedia>
                <EmptyTitle>Nothing here yet</EmptyTitle>
                <EmptyDescription>Add sessions, sources, or skills to get started.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          }
        />
      </div>
    )
  }

  // Build flat or grouped items
  const allItems: MixedEntity[] = [
    ...sampleSessions.slice(0, 2).map(s => ({ kind: 'session' as const, data: s })),
    ...sampleSources.slice(0, 2).map(s => ({ kind: 'source' as const, data: s })),
    ...sampleSkills.slice(0, 2).map(s => ({ kind: 'skill' as const, data: s })),
  ]

  const getKey = (item: MixedEntity) => `${item.kind}-${item.data.id}`

  let flatIndex = -1
  const renderItem = (item: MixedEntity, _index: number, isFirst: boolean) => {
    flatIndex++
    const currentFlatIndex = flatIndex
    switch (item.kind) {
      case 'session': {
        const session = item.data
        return (
          <EntityRow
            icon={
              <div className="w-4 h-4 flex items-center justify-center [&>svg]:w-full [&>svg]:h-full" style={{ color: session._status.color }}>
                {session._status.icon}
              </div>
            }
            title={session.name || 'Untitled'}
            badges={
              <>
                {session.hasUnread && <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded bg-accent text-white">New</span>}
                {session.isFlagged && (
                  <span className="shrink-0 h-[18px] w-[18px] flex items-center justify-center rounded bg-foreground/5">
                    <Flag className="h-[10px] w-[10px] text-info fill-info" />
                  </span>
                )}
              </>
            }
            trailing={session.lastMessageAt ? <span className="text-[11px] text-foreground/40">{formatRelativeTime(session.lastMessageAt)}</span> : undefined}
            isSelected={currentFlatIndex === selectedIndex}
            showSeparator={!isFirst}
            menuContent={<MockMenuItems />}
          />
        )
      }
      case 'source': {
        const source = item.data
        const typeConfig = SOURCE_TYPE_CONFIG[source.type]
        const statusConfig = SOURCE_STATUS_CONFIG[source.status]
        return (
          <EntityRow
            icon={<MockAvatar icon={source.icon} color="text-muted-foreground" label={source.name} />}
            title={source.name}
            badges={
              <>
                {typeConfig && <TypeBadge label={typeConfig.label} colorClass={typeConfig.colorClass} />}
                {statusConfig && <StatusBadge label={statusConfig.label} colorClass={statusConfig.colorClass} />}
                <span className="truncate">{source.tagline}</span>
              </>
            }
            isSelected={currentFlatIndex === selectedIndex}
            showSeparator={!isFirst}
            menuContent={<MockMenuItems />}
          />
        )
      }
      case 'skill': {
        const skill = item.data
        return (
          <EntityRow
            icon={
              skill.icon ? (
                <div className="w-5 h-5 rounded-[4px] ring-1 ring-border/30 shrink-0 flex items-center justify-center bg-muted text-sm leading-none">
                  {skill.icon}
                </div>
              ) : (
                <MockAvatar icon={Zap} color="text-muted-foreground" label={skill.name} />
              )
            }
            title={skill.name}
            badges={<span className="truncate">{skill.description}</span>}
            isSelected={currentFlatIndex === selectedIndex}
            showSeparator={!isFirst}
            menuContent={<MockMenuItems />}
          />
        )
      }
    }
  }

  if (showGroups) {
    const groups = [
      { key: 'sessions', label: 'Sessions', items: allItems.filter(i => i.kind === 'session') },
      { key: 'sources', label: 'Sources', items: allItems.filter(i => i.kind === 'source') },
      { key: 'skills', label: 'Skills', items: allItems.filter(i => i.kind === 'skill') },
    ]

    // Reset flatIndex for grouped rendering
    flatIndex = -1

    return (
      <div className="w-[320px] h-[480px] flex flex-col border border-border rounded-lg overflow-hidden bg-background">
        <EntityList
          groups={groups}
          getKey={getKey}
          renderItem={renderItem}
        />
      </div>
    )
  }

  flatIndex = -1
  return (
    <div className="w-[320px] h-[480px] flex flex-col border border-border rounded-lg overflow-hidden bg-background">
      <EntityList
        items={allItems}
        getKey={getKey}
        renderItem={renderItem}
      />
    </div>
  )
}
