import * as React from "react";
import { CalendarDays, CheckCircle2, Circle, History, MoreHorizontal, Link2, ListTodo } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MetadataBadge } from "@/components/ui/metadata-badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DropdownMenu, DropdownMenuTrigger, StyledDropdownMenuContent, StyledDropdownMenuItem } from "@/components/ui/styled-dropdown";
import { TiptapMarkdownEditor } from "@craft-agent/ui";
import { cn } from "@/lib/utils";
import { getResizeGradientStyle } from "@/hooks/useResizeGradient";
import { PANEL_GAP, PANEL_SASH_HALF_HIT_WIDTH, PANEL_SASH_HIT_WIDTH, PANEL_SASH_LINE_WIDTH } from "@/components/app-shell/panel-constants";
import type { PlannerProject, PlannerRow, PlannerHeading, PlannerTask, TaskSessionLinkLocal, PlannerTaskEvent } from "./models";
import { projects, stateStyles, stateLabels, snapshots, syncMeta } from "./fixtures";

interface PlannerBoardViewProps {
  sidebarWidth: number
  setActiveProjectId: React.Dispatch<React.SetStateAction<string>>
  project: PlannerProject
  navigatorWidth: number
  quickAdd: string
  setQuickAdd: React.Dispatch<React.SetStateAction<string>>
  addTask: () => void
  setSelectedTaskId: React.Dispatch<React.SetStateAction<string>>
  flatListRef: React.RefObject<HTMLDivElement | null>
  flatRows: PlannerRow[]
  projectHeadings: PlannerHeading[]
  rowRefs: React.RefObject<Map<string, HTMLDivElement>>
  tasksState: PlannerTask[]
  isDraggingRef: React.RefObject<boolean>
  selectedTaskId: string
  selectedTask: PlannerTask | undefined
  updateTaskTitle: (taskId: string, title: string) => void
  selectedHeading: PlannerHeading | null | undefined
  selectedLinks: TaskSessionLinkLocal[]
  updateTaskNotes: (taskId: string, notes: string) => void
  selectedEvents: PlannerTaskEvent[]
  sidebarHandleRef: React.RefObject<HTMLDivElement | null>
  setIsResizing: React.Dispatch<React.SetStateAction<'sidebar' | 'navigator' | null>>
  setSidebarHandleY: React.Dispatch<React.SetStateAction<number | null>>
  isResizing: 'sidebar' | 'navigator' | null
  sidebarHandleY: number | null
  navigatorHandleRef: React.RefObject<HTMLDivElement | null>
  setNavigatorHandleY: React.Dispatch<React.SetStateAction<number | null>>
  navigatorHandleY: number | null
}

export function renderPlannerBoard({
  sidebarWidth,
  setActiveProjectId,
  project,
  navigatorWidth,
  quickAdd,
  setQuickAdd,
  addTask,
  setSelectedTaskId,
  flatListRef,
  flatRows,
  projectHeadings,
  rowRefs,
  tasksState,
  isDraggingRef,
  selectedTaskId,
  selectedTask,
  updateTaskTitle,
  selectedHeading,
  selectedLinks,
  updateTaskNotes,
  selectedEvents,
  sidebarHandleRef,
  setIsResizing,
  setSidebarHandleY,
  isResizing,
  sidebarHandleY,
  navigatorHandleRef,
  setNavigatorHandleY,
  navigatorHandleY,
}: PlannerBoardViewProps) {
  return (
    <div className="w-full h-full flex relative" style={{ gap: 6, padding: 4 }}>
      <aside
        className="p-3 shrink-0 overflow-hidden"
        style={{ width: sidebarWidth }}
      >
          <div className="mb-3 flex items-center gap-2 px-2 py-1">
            <ListTodo className="h-4 w-4 text-foreground/60" />
            <span className="text-sm font-semibold">Planner</span>
          </div>

          <div className="space-y-1">
            {projects.map(p => (
              <button
                key={p.id}
                onClick={() => setActiveProjectId(p.id)}
                className={cn(
                  'w-full rounded-[10px] px-2.5 py-2 text-left transition-colors',
                  p.id === project.id
                    ? 'bg-foreground/10 text-foreground'
                    : 'text-foreground/65 hover:bg-foreground/5 hover:text-foreground'
                )}
              >
                <div className="text-sm font-medium">{p.name}</div>
                <div className="mt-0.5 text-[11px] text-foreground/45">{p.installationHint}</div>
              </button>
            ))}
          </div>
      </aside>

      <section
        className="bg-background shadow-middle rounded-[10px] overflow-hidden shrink-0 flex flex-col"
        style={{ width: navigatorWidth }}
      >
          <div className="border-b border-border/60 px-5 py-3">
            <h3 className="mb-2 text-base font-semibold">{project.name}</h3>
            <div className="flex gap-2">
              <Input
                value={quickAdd}
                onChange={(e) => setQuickAdd(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addTask()
                }}
                placeholder="Quick add task…"
                className="h-8 text-sm"
              />
              <Button size="sm" className="h-8" onClick={addTask}>Add</Button>
            </div>
          </div>

          <ScrollArea
            className="flex-1"
            onPointerDown={(e) => {
              const target = e.target as HTMLElement
              if (target.closest('[data-row-key]')) return
              setSelectedTaskId('')
            }}
          >
            <div
              className="px-5 py-4 min-h-full flex flex-col"
            >
              <div
                ref={flatListRef}
                className="flex flex-col gap-1.5 rounded-[10px] p-1"
              >
                {flatRows.map((row, index) => {
                  if (row.kind === 'heading') {
                    const heading = projectHeadings.find(h => h.id === row.headingId)
                    if (!heading) return null

                    return (
                      <div
                        key={row.key}
                        data-row-key={row.key}
                        ref={(el) => {
                          if (el) rowRefs.current.set(row.key, el)
                          else rowRefs.current.delete(row.key)
                        }}
                        className={cn(
                          'w-full select-none',
                          index === 0 ? 'pt-1' : 'pt-3'
                        )}
                      >
                        <div className="flex items-center justify-between gap-2 border-b border-border/70 pb-1.5 px-1">
                          <div className="text-[13px] font-semibold text-foreground">
                            {heading.title}
                          </div>
                          <DropdownMenu modal={false}>
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                data-no-dnd="true"
                                onPointerDown={(e) => e.stopPropagation()}
                                onClick={(e) => e.stopPropagation()}
                                className="h-6 w-6 inline-flex items-center justify-center rounded-[6px] hover:bg-foreground/5 data-[state=open]:bg-foreground/5"
                                aria-label={`Open ${heading.title} menu`}
                              >
                                <MoreHorizontal className="h-4 w-4 text-foreground/45" />
                              </button>
                            </DropdownMenuTrigger>
                            <StyledDropdownMenuContent align="end" minWidth="min-w-44">
                              <StyledDropdownMenuItem onClick={(e) => e.preventDefault()}>
                                <span className="flex-1">Rename section</span>
                              </StyledDropdownMenuItem>
                              <StyledDropdownMenuItem onClick={(e) => e.preventDefault()}>
                                <span className="flex-1">Add task below</span>
                              </StyledDropdownMenuItem>
                              <StyledDropdownMenuItem onClick={(e) => e.preventDefault()}>
                                <span className="flex-1">Delete section</span>
                              </StyledDropdownMenuItem>
                            </StyledDropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>
                    )
                  }

                  const task = tasksState.find(t => t.id === row.taskId)
                  if (!task) return null

                  return (
                    <div
                      key={row.key}
                      data-row-key={row.key}
                      ref={(el) => {
                        if (el) rowRefs.current.set(row.key, el)
                        else rowRefs.current.delete(row.key)
                      }}
                      onClick={() => { if (!isDraggingRef.current) setSelectedTaskId(task.id) }}
                      className={cn(
                        'planner-sortable-item w-full rounded-[8px] px-3 py-2 text-left select-none',
                        selectedTaskId === task.id
                          ? 'planner-sortable-item--selected bg-background'
                          : 'bg-background shadow-none'
                      )}
                    >
                      <div className="flex items-center gap-2">
                        {task.state === 'done' ? (
                          <CheckCircle2 className={cn('h-4 w-4', stateStyles[task.state])} />
                        ) : (
                          <Circle className={cn('h-4 w-4', stateStyles[task.state])} />
                        )}
                        <span className={cn('min-w-0 flex-1 truncate text-sm', task.state === 'done' && 'line-through text-foreground/45')}>
                          {task.title}
                        </span>
                        <span className="text-[11px] text-foreground/45">{task.due}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="flex-1 min-h-12" aria-hidden="true" />
            </div>
          </ScrollArea>
      </section>

      <aside className="bg-foreground-2 shadow-middle rounded-[10px] overflow-hidden flex-1 min-w-0 flex flex-col">
          {!selectedTask ? (
            <div className="p-5 text-sm text-foreground/50">Select a task to inspect details.</div>
          ) : (
            <ScrollArea className="flex-1">
              <div className="w-full max-w-[720px] mx-auto px-6 pt-8 pb-5">
                {/* Editable title */}
                <div
                  key={selectedTask.id + '-title'}
                  contentEditable
                  suppressContentEditableWarning
                  onBlur={(e) => updateTaskTitle(selectedTask.id, e.currentTarget.textContent ?? '')}
                  className="text-xl font-bold leading-snug outline-none mb-5"
                >
                  {selectedTask.title}
                </div>

                {/* Metadata badges under title */}
                <div className="flex items-center gap-2 flex-wrap mb-5">
                  <MetadataBadge
                    interactive={false}
                    icon={selectedTask.state === 'done'
                      ? <CheckCircle2 className={cn('h-3.5 w-3.5', stateStyles[selectedTask.state])} />
                      : <Circle className={cn('h-3.5 w-3.5', stateStyles[selectedTask.state])} />}
                    label={stateLabels[selectedTask.state]}
                  />

                  <MetadataBadge
                    interactive={false}
                    icon={<CalendarDays className="h-3.5 w-3.5 text-foreground/55" />}
                    label="Due"
                    value={selectedTask.due}
                  />

                  {selectedHeading && (
                    <MetadataBadge
                      interactive={false}
                      label="Section"
                      value={selectedHeading.title}
                    />
                  )}

                  <MetadataBadge
                    interactive={false}
                    icon={<Link2 className="h-3.5 w-3.5 text-foreground/55" />}
                    label="Sessions"
                    value={String(selectedLinks.length)}
                  />
                </div>

                {/* Editable notes */}
                <TiptapMarkdownEditor
                  key={selectedTask.id + '-notes'}
                  content={selectedTask.notes}
                  onUpdate={(md) => updateTaskNotes(selectedTask.id, md)}
                  placeholder="Add notes..."
                  className="text-sm leading-relaxed text-foreground/75"
                />

                {/* Separator */}
                <div className="border-t border-border/60 mt-5 mb-1" />

                {/* Attached Sessions */}
                <div className="mb-1 text-sm font-semibold">Attached Sessions</div>
                <div className="space-y-2 mt-3">
                  {selectedLinks.length === 0 ? (
                    <div className="text-xs text-foreground/40">No sessions linked.</div>
                  ) : (
                    selectedLinks.map(link => {
                      const snap = snapshots.find(s => s.id === link.snapshotId)
                      if (!snap) return null
                      const meta = syncMeta[link.syncState]
                      const Icon = meta.icon
                      return (
                        <div key={link.id} className="rounded-lg border border-border/60 p-2.5 bg-foreground/[0.01]">
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <div className="min-w-0 flex items-center gap-1.5">
                              <Link2 className="h-3.5 w-3.5 text-foreground/45" />
                              <span className="truncate text-xs font-medium">{snap.title}</span>
                            </div>
                            <span className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px]', meta.cls)}>
                              <Icon className="h-3 w-3" />
                              {meta.label}
                            </span>
                          </div>
                          <p className="text-[11px] text-foreground/60 leading-relaxed">{snap.summary}</p>
                          <div className="mt-1 text-[10px] text-foreground/45">Updated {snap.lastUpdated}</div>
                        </div>
                      )
                    })
                  )}
                </div>

                {/* Separator */}
                <div className="border-t border-border/60 my-5" />

                {/* Activity */}
                <div className="mb-3 text-sm font-semibold">Activity</div>
                <div className="space-y-3">
                  {selectedEvents.map(ev => (
                    <div key={ev.id} className="flex items-start gap-2.5">
                      <div className="mt-0.5 h-5 w-5 rounded-full bg-foreground/8 flex items-center justify-center shrink-0">
                        <History className="h-3 w-3 text-foreground/45" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs text-foreground/75">{ev.payloadSummary}</div>
                        <div className="mt-0.5 text-[11px] text-foreground/40">
                          {ev.actor} · {ev.at}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </ScrollArea>
          )}
      </aside>

      {/* Sidebar resize handle (absolute) */}
      <div
        ref={sidebarHandleRef}
        onMouseDown={(e) => { e.preventDefault(); setIsResizing('sidebar') }}
        onMouseMove={(e) => {
          if (sidebarHandleRef.current) {
            const rect = sidebarHandleRef.current.getBoundingClientRect()
            setSidebarHandleY(e.clientY - rect.top)
          }
        }}
        onMouseLeave={() => { if (isResizing !== 'sidebar') setSidebarHandleY(null) }}
        className="absolute top-0 h-full cursor-col-resize z-10 flex justify-center"
        style={{
          width: PANEL_SASH_HIT_WIDTH,
          left: sidebarWidth + (PANEL_GAP / 2) - PANEL_SASH_HALF_HIT_WIDTH,
        }}
      >
        <div
          className="h-full"
          style={{
            width: PANEL_SASH_LINE_WIDTH,
            ...getResizeGradientStyle(sidebarHandleY, sidebarHandleRef.current?.clientHeight ?? null),
          }}
        />
      </div>

      {/* Navigator resize handle (absolute) */}
      <div
        ref={navigatorHandleRef}
        onMouseDown={(e) => { e.preventDefault(); setIsResizing('navigator') }}
        onMouseMove={(e) => {
          if (navigatorHandleRef.current) {
            const rect = navigatorHandleRef.current.getBoundingClientRect()
            setNavigatorHandleY(e.clientY - rect.top)
          }
        }}
        onMouseLeave={() => { if (isResizing !== 'navigator') setNavigatorHandleY(null) }}
        className="absolute top-0 h-full cursor-col-resize z-10 flex justify-center"
        style={{
          width: PANEL_SASH_HIT_WIDTH,
          left: sidebarWidth + PANEL_GAP + navigatorWidth + (PANEL_GAP / 2) - PANEL_SASH_HALF_HIT_WIDTH,
        }}
      >
        <div
          className="h-full"
          style={{
            width: PANEL_SASH_LINE_WIDTH,
            ...getResizeGradientStyle(navigatorHandleY, navigatorHandleRef.current?.clientHeight ?? null),
          }}
        />
      </div>
    </div>
  )
}
