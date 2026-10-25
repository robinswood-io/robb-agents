import { Flag, Zap, DatabaseZap } from "lucide-react";
import { Spinner } from "@craft-agent/ui";
import { EntityRow } from "@/components/ui/entity-row";
import { EntityList } from "@/components/ui/entity-list";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { formatRelativeTime, MockMenuItems, MockAvatar, TypeBadge, StatusBadge } from "./primitives";
import { sampleSessions, sampleSources, SOURCE_TYPE_CONFIG, SOURCE_STATUS_CONFIG, sampleSkills } from "./fixtures";

// ============================================================================
// Preview: Session Rows via EntityRow
// ============================================================================

interface SessionEntityListPreviewProps {
  selectedIndex?: number
  showMultiSelect?: boolean
}

export function SessionEntityListPreview({
  selectedIndex = 0,
  showMultiSelect = false,
}: SessionEntityListPreviewProps) {
  return (
    <div className="w-[320px] h-[480px] flex flex-col border border-border rounded-lg overflow-hidden bg-background">
      <EntityList
        items={sampleSessions}
        getKey={(s) => s.id}
        renderItem={(session, index, isFirst) => {
          const isSelected = index === selectedIndex
          return (
            <EntityRow
              icon={
                <div
                  className="w-4 h-4 flex items-center justify-center [&>svg]:w-full [&>svg]:h-full"
                  style={{ color: session._status.color }}
                >
                  {session._status.icon}
                </div>
              }
              title={session.name || 'Untitled'}
              badges={
                <>
                  {session.isProcessing && (
                    <Spinner className="text-[8px] text-foreground shrink-0" />
                  )}
                  {!session.isProcessing && session.hasUnread && (
                    <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded bg-accent text-white">
                      New
                    </span>
                  )}
                  <div
                    className="flex-1 flex items-center gap-1 min-w-0 overflow-x-auto scrollbar-hide pr-4"
                    style={{ maskImage: 'linear-gradient(to right, black calc(100% - 16px), transparent 100%)', WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 16px), transparent 100%)' }}
                  >
                    {session.isFlagged && (
                      <span className="shrink-0 h-[18px] w-[18px] flex items-center justify-center rounded bg-foreground/5">
                        <Flag className="h-[10px] w-[10px] text-info fill-info" />
                      </span>
                    )}
                    {session.labels?.map((label, i) => (
                      <span
                        key={i}
                        className="shrink-0 h-[18px] max-w-[120px] px-1.5 text-[10px] font-medium rounded flex items-center whitespace-nowrap"
                        style={{
                          backgroundColor: 'rgba(var(--foreground-rgb), 0.05)',
                          color: 'rgba(var(--foreground-rgb), 0.8)',
                        }}
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                </>
              }
              trailing={
                session.lastMessageAt ? (
                  <span className="shrink-0 text-[11px] text-foreground/40 whitespace-nowrap">
                    {formatRelativeTime(session.lastMessageAt)}
                  </span>
                ) : undefined
              }
              isSelected={isSelected}
              isInMultiSelect={showMultiSelect && (index === 0 || index === 1)}
              showSeparator={!isFirst}
              menuContent={<MockMenuItems />}
              dataAttributes={{ 'data-session-id': session.id }}
            />
          )
        }}
      />
    </div>
  )
}

// ============================================================================
// Preview: Source Rows via EntityRow
// ============================================================================

interface SourceEntityListPreviewProps {
  selectedIndex?: number
  typeFilter?: string
}

export function SourceEntityListPreview({
  selectedIndex = -1,
  typeFilter = 'all',
}: SourceEntityListPreviewProps) {
  const filtered = typeFilter === 'all'
    ? sampleSources
    : sampleSources.filter(s => s.type === typeFilter)

  return (
    <div className="w-[320px] h-[480px] flex flex-col border border-border rounded-lg overflow-hidden bg-background">
      <EntityList
        items={filtered}
        getKey={(s) => s.id}
        emptyState={
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon"><DatabaseZap /></EmptyMedia>
              <EmptyTitle>No sources configured</EmptyTitle>
              <EmptyDescription>Sources connect your agent to external data.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        }
        renderItem={(source, index, isFirst) => {
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
              isSelected={index === selectedIndex}
              showSeparator={!isFirst}
              menuContent={<MockMenuItems />}
            />
          )
        }}
      />
    </div>
  )
}

// ============================================================================
// Preview: Skill Rows via EntityRow
// ============================================================================

interface SkillEntityListPreviewProps {
  selectedIndex?: number
}

export function SkillEntityListPreview({
  selectedIndex = -1,
}: SkillEntityListPreviewProps) {
  return (
    <div className="w-[320px] h-[480px] flex flex-col border border-border rounded-lg overflow-hidden bg-background">
      <EntityList
        items={sampleSkills}
        getKey={(s) => s.id}
        emptyState={
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon"><Zap /></EmptyMedia>
              <EmptyTitle>No skills configured</EmptyTitle>
              <EmptyDescription>Skills teach your agent specialized behaviors.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        }
        renderItem={(skill, index, isFirst) => (
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
            isSelected={index === selectedIndex}
            showSeparator={!isFirst}
            menuContent={<MockMenuItems />}
          />
        )}
      />
    </div>
  )
}
