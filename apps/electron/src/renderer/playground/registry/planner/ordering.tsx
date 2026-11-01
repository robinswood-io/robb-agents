import { CalendarDays } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PlannerHeading, PlannerTask, SyncState } from "./models";
import { syncMeta } from "./fixtures";

export function buildFlatOrder(projectHeadings: PlannerHeading[], tasks: PlannerTask[]): string[] {
  const rows: string[] = []

  projectHeadings.forEach((heading) => {
    rows.push(`heading:${heading.id}`)
    tasks
      .filter(task => task.headingId === heading.id)
      .forEach(task => rows.push(`task:${task.id}`))
  })

  return rows
}

export function parseHeadingIdFromKey(rowKey: string): string | null {
  return rowKey.startsWith('heading:') ? rowKey.slice('heading:'.length) : null
}

export function parseTaskIdFromKey(rowKey: string): string | null {
  return rowKey.startsWith('task:') ? rowKey.slice('task:'.length) : null
}

export function uniqueOrdered(values: string[]): string[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    if (seen.has(value)) return false
    seen.add(value)
    return true
  })
}

export function PlannerSyncStatePalette() {
  return (
    <div className="w-[820px] rounded-[14px] border border-border bg-background p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <CalendarDays className="h-4 w-4 text-foreground/60" />
        Sync States (task_session_links_local)
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        {(Object.keys(syncMeta) as SyncState[]).map((state) => {
          const meta = syncMeta[state]
          const Icon = meta.icon
          return (
            <div key={state} className="rounded-[10px] border border-border/60 bg-foreground/[0.015] p-3">
              <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
                <Icon className={cn('h-4 w-4', meta.cls.split(' ')[0])} />
                {meta.label}
              </div>
              <div className="text-xs text-foreground/60">
                Snapshot card always visible; live session resolution is optional enhancement.
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
