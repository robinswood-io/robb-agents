/**
 * Playground registry for EntityRow and EntityList primitives.
 *
 * Demonstrates all three entity types (Sessions, Sources, Skills)
 * composed through the same EntityRow/EntityList building blocks.
 */
import * as React from "react";
import { Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { EntityRow } from "@/components/ui/entity-row";
import { useMenuComponents } from "@/components/ui/menu-context";

// ============================================================================
// Mock Icons (simple colored squares to avoid IPC-dependent avatars)
// ============================================================================

export function MockAvatar({ icon: Icon, color, label }: { icon: React.ComponentType<{ className?: string }>; color: string; label: string }) {
  return (
    <div
      className="w-5 h-5 rounded-[4px] ring-1 ring-border/30 shrink-0 flex items-center justify-center bg-muted"
      title={label}
    >
      <Icon className={cn("w-3 h-3", color)} />
    </div>
  )
}

// ============================================================================
// Badge Primitives
// ============================================================================

export function TypeBadge({ label, colorClass }: { label: string; colorClass: string }) {
  return (
    <span className={cn("shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded", colorClass)}>
      {label}
    </span>
  )
}

export function StatusBadge({ label, colorClass }: { label: string; colorClass: string }) {
  return (
    <span className={cn("shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded cursor-default", colorClass)}>
      {label}
    </span>
  )
}

// ============================================================================
// Relative Time Formatter
// ============================================================================

export function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

// ============================================================================
// Mock Menu Content (minimal, just for visual)
// ============================================================================

export function MockMenuItems() {
  const { MenuItem, Separator } = useMenuComponents()
  return (
    <>
      <MenuItem onClick={() => console.log('[Playground] Open in New Window')}>Open in New Window</MenuItem>
      <MenuItem onClick={() => console.log('[Playground] Show in Finder')}>Show in Finder</MenuItem>
      <Separator />
      <MenuItem variant="destructive" onClick={() => console.log('[Playground] Delete')}>Delete</MenuItem>
    </>
  )
}

// ============================================================================
// Preview: EntityRow with all slots
// ============================================================================

interface EntityRowPreviewProps {
  title?: string | undefined
  subtitle?: string | undefined
  showIcon?: boolean | undefined
  showBadges?: boolean | undefined
  showTrailing?: boolean | undefined
  showMenu?: boolean | undefined
  isSelected?: boolean | undefined
  isInMultiSelect?: boolean | undefined
  showSeparator?: boolean | undefined
}

export function EntityRowPreview({
  title = 'Sample Entity',
  subtitle = 'A short description',
  showIcon = true,
  showBadges = true,
  showTrailing = false,
  showMenu = true,
  isSelected = false,
  isInMultiSelect = false,
  showSeparator = false,
}: EntityRowPreviewProps) {
  return (
    <div className="w-[320px] border border-border rounded-lg overflow-hidden bg-background py-2">
      <EntityRow
        icon={showIcon ? <MockAvatar icon={Zap} color="text-accent" label="Entity" /> : undefined}
        title={title}
        badges={showBadges ? (
          <>
            <TypeBadge label="MCP" colorClass="bg-accent/10 text-accent" />
            <span className="truncate">{subtitle}</span>
          </>
        ) : subtitle ? <span className="truncate text-xs text-foreground/70">{subtitle}</span> : undefined}
        trailing={showTrailing ? <span className="text-[11px] text-foreground/40">3m</span> : undefined}
        isSelected={isSelected}
        isInMultiSelect={isInMultiSelect}
        showSeparator={showSeparator}
        menuContent={showMenu ? <MockMenuItems /> : undefined}
      />
    </div>
  )
}
