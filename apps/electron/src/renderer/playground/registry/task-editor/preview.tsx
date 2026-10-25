import * as React from "react";
import { ChevronLeft, ChevronDown, Sparkles, Plus, Check, Hash, Clock3 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { SessionStatusMenu } from "@/components/ui/session-status-menu";
import { mockStatuses, mockStatusesById, mockProjects } from "../../demos/kanban/mock-kanban-data";
import type { Mode, EditorSubtask } from "./fixtures";
import { OPUS, buildYaml, uid, SONNET, slugify, modelName } from "./fixtures";
import { Btn, FieldRow, SelectButton, ModelSelect, SubtaskCard, YamlLine } from "./controls";

// ---------------------------------------------------------------------------
// Task Editor
// ---------------------------------------------------------------------------
export function TaskEditorPreview({ mode: initialMode = 'generate' }: { mode?: Mode }) {
  const [mode, setMode] = React.useState<Mode>(initialMode)
  const [title, setTitle] = React.useState('Migrate auth to new session model')
  const [goal, setGoal] = React.useState(
    "Migrate our auth layer to the new session model. Coordinate the work and route each part to the best-fit model. Don't run anything yet — just prepare the plan and subtasks."
  )
  const [projectId, setProjectId] = React.useState(mockProjects[0]?.id ?? '')
  const [orchModel, setOrchModel] = React.useState(OPUS)
  const [statusId, setStatusId] = React.useState('todo')
  const [subtasks, setSubtasks] = React.useState<EditorSubtask[]>([])
  const [yamlOpen, setYamlOpen] = React.useState(false)

  React.useEffect(() => setMode(initialMode), [initialMode])

  const project = mockProjects.find(p => p.id === projectId)
  const status = mockStatusesById.get(statusId)
  const yaml = React.useMemo(
    () => buildYaml({ title, goal, projectId, orchModel, statusId, subtasks, aiMode: mode === 'generate' }),
    [title, goal, projectId, orchModel, statusId, subtasks, mode]
  )

  const updateSubtask = (id: string, patch: Partial<EditorSubtask>) =>
    setSubtasks(prev => prev.map(s => (s.id === id ? { ...s, ...patch } : s)))
  const removeSubtask = (id: string) =>
    setSubtasks(prev => prev.filter(s => s.id !== id).map(s => (s.dependsOn === id ? { ...s, dependsOn: null } : s)))
  const addSubtask = () =>
    setSubtasks(prev => [
      ...prev,
      { id: uid(), title: '', model: SONNET, dependsOn: prev[prev.length - 1]?.id ?? null },
    ])

  const slug = slugify(title) || 'untitled-task'

  return (
    <div className="flex h-full flex-col gap-3 bg-background p-3 text-foreground">
      {/* Header */}
      <div className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2.5 shadow-minimal">
        <Btn variant="ghost" className="px-2">
          <ChevronLeft className="h-4 w-4" strokeWidth={2} /> Board
        </Btn>
        <span className="text-foreground/25">/</span>
        <span className="text-sm font-semibold">New Task</span>
        {/* Disclaimer demoted to a quiet inline note (was a loud amber pill). */}
        <span className="inline-flex items-center gap-1 text-[11px] text-foreground/40">
          <Clock3 className="h-3 w-3" strokeWidth={2} /> prepares only — nothing runs yet
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Btn
            variant="secondary"
            onClick={() => toast('Draft saved', { description: `workspace/tasks/${slug}.yaml` })}
          >
            Save draft
          </Btn>
          <Btn
            variant="primary"
            onClick={() =>
              title.trim()
                ? toast.success('Task prepared', {
                    description:
                      mode === 'generate'
                        ? `Wrote ${slug}.yaml · created the orchestrator session — it drafts subtasks on first run. Dispatch from the board.`
                        : `Wrote ${slug}.yaml · created parent + ${subtasks.length} pending subtask session(s). Run from the board.`,
                  })
                : toast.error('Add a title first')
            }
          >
            <Sparkles className="h-3.5 w-3.5" strokeWidth={2.5} /> Prepare task
          </Btn>
        </div>
      </div>

      {/* Body: two columns */}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(380px,2fr)_3fr] gap-3">
        {/* Left — task definition */}
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto rounded-xl border border-border bg-card p-4 shadow-minimal">
          <div className="text-[15px] font-bold">Task definition</div>

          {/* mode toggle */}
          <div className="inline-flex w-fit rounded-[9px] bg-foreground/[0.05] p-0.5">
            {(['generate', 'manual'] as Mode[]).map(m => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-[7px] px-3 py-1.5 text-[12.5px] font-semibold transition-colors',
                  mode === m ? 'bg-card text-foreground shadow-minimal' : 'text-foreground/55 hover:text-foreground/80'
                )}
              >
                {m === 'generate' && <Sparkles className="h-3.5 w-3.5" strokeWidth={2.5} />}
                {m === 'generate' ? 'Generate' : 'Manual'}
              </button>
            ))}
          </div>

          {/* title */}
          <div>
            <div className="mb-1.5 text-[12px] font-semibold text-foreground/55">Title</div>
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Name this task…"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[13.5px] font-semibold outline-none focus:border-foreground/25"
            />
          </div>

          {/* goal */}
          <div>
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="text-[12px] font-semibold text-foreground/55">Goal / prompt</span>
              <span className="text-[10.5px] text-foreground/35">orchestrator's first message</span>
            </div>
            <textarea
              value={goal}
              onChange={e => setGoal(e.target.value)}
              rows={4}
              placeholder="Describe the goal…"
              className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-[12.5px] leading-relaxed outline-none focus:border-foreground/25 field-sizing-content max-h-48"
            />
          </div>

          {/* meta selects */}
          <div className="flex flex-col gap-3">
            <FieldRow label="Project">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SelectButton style={{ width: 168 }}>
                    {project ? (
                      <>
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: project.color }} />
                        <span className="truncate">{project.name}</span>
                      </>
                    ) : (
                      <span className="text-foreground/50">No project</span>
                    )}
                  </SelectButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[160px]">
                  <DropdownMenuItem className="text-xs" onSelect={() => setProjectId('')}>
                    No project
                    {!projectId && <Check className="ml-auto h-3.5 w-3.5" strokeWidth={2} />}
                  </DropdownMenuItem>
                  {mockProjects.map(p => (
                    <DropdownMenuItem key={p.id} className="text-xs" onSelect={() => setProjectId(p.id)}>
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: p.color }} />
                      <span className="truncate">{p.name}</span>
                      {projectId === p.id && <Check className="ml-auto h-3.5 w-3.5 shrink-0" strokeWidth={2} />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </FieldRow>

            <FieldRow label="Orchestrator model">
              <ModelSelect value={orchModel} onChange={setOrchModel} />
            </FieldRow>

            <FieldRow label="Initial status">
              <Popover>
                <PopoverTrigger asChild>
                  <SelectButton style={{ width: 168 }}>
                    {status && (
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: status.resolvedColor }} />
                    )}
                    <span className="truncate">{status?.label ?? statusId}</span>
                  </SelectButton>
                </PopoverTrigger>
                <PopoverContent align="end" sideOffset={4} className="w-auto border-0 bg-transparent p-0 shadow-none">
                  <SessionStatusMenu states={mockStatuses} activeState={statusId} onSelect={setStatusId} />
                </PopoverContent>
              </Popover>
            </FieldRow>
          </div>
        </div>

        {/* Right — subtask editor (Manual) or AI hand-off (Generate).
            The editable list is a *Manual-mode* affordance: in Generate mode the
            orchestrator authors the subtasks, so there's nothing to hand-edit. */}
        <div className="flex min-h-0 flex-col rounded-xl border border-border bg-card shadow-minimal">
          {mode === 'manual' ? (
            <>
              <div className="flex shrink-0 items-center gap-2 px-4 pt-4">
                <span className="text-[15px] font-bold">Subtasks</span>
                <span className="grid h-5 min-w-[20px] place-items-center rounded-full bg-foreground/[0.06] px-1.5 text-[11px] font-bold text-foreground/55">
                  {subtasks.length}
                </span>
                <Btn variant="secondary" size="sm" className="ml-auto" onClick={addSubtask}>
                  <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> Add subtask
                </Btn>
              </div>

              <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-4">
                {subtasks.map((st, i) => (
                  <SubtaskCard
                    key={st.id}
                    index={i}
                    subtask={st}
                    earlier={subtasks.slice(0, i)}
                    onChange={patch => updateSubtask(st.id, patch)}
                    onRemove={() => removeSubtask(st.id)}
                  />
                ))}
                {subtasks.length === 0 && (
                  <div className="flex flex-col items-center gap-2 py-6">
                    <button
                      onClick={addSubtask}
                      className="flex w-full items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-border py-2.5 text-[12.5px] font-semibold text-foreground/40 transition-colors hover:border-foreground/30 hover:text-foreground/60"
                    >
                      <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> Add subtask
                    </button>
                    <p className="px-1 text-center text-[12px] text-foreground/40">
                      No subtasks yet — add the first one to define the breakdown.
                    </p>
                  </div>
                )}
              </div>

              <div className="shrink-0 border-t border-border/60 px-4 py-2.5 text-[10.5px] text-foreground/40">
                Reorder by drag · each subtask spawns a child session (pending) · models route per-subtask
              </div>
            </>
          ) : (
            <>
              <div className="flex shrink-0 items-center gap-2 px-4 pt-4">
                <span className="text-[15px] font-bold">Subtasks</span>
                <span className="inline-flex items-center gap-1 rounded-full bg-indigo-500/10 px-2 py-0.5 text-[10.5px] font-semibold text-indigo-500 dark:text-indigo-300">
                  <Sparkles className="h-2.5 w-2.5" strokeWidth={2.5} /> AI
                </span>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="flex min-h-full flex-col items-center justify-center gap-3 px-6 py-8 text-center">
                  <div className="grid h-12 w-12 place-items-center rounded-full bg-indigo-500/10 text-indigo-500 dark:text-indigo-300">
                    <Sparkles className="h-6 w-6" strokeWidth={2} />
                  </div>
                  <div className="text-[14px] font-bold">AI generates the subtasks</div>
                  <p className="max-w-[340px] text-[12.5px] leading-relaxed text-foreground/55">
                    When you prepare this task, the orchestrator ({modelName(orchModel)}) reads your goal and
                    breaks it into subtasks — picking a best-fit model and wiring dependencies for each. You
                    don't define them here.
                  </p>
                  <Btn variant="ghost" size="sm" onClick={() => setMode('manual')}>
                    Or author them by hand →
                  </Btn>
                </div>
              </div>

              <div className="shrink-0 border-t border-border/60 px-4 py-2.5 text-[10.5px] text-foreground/40">
                Drafted on Prepare · each becomes a pending child session · models route per-subtask
              </div>
            </>
          )}
        </div>
      </div>

      {/* Bottom — live YAML (collapsible, to reclaim vertical space) */}
      <div className="rounded-xl border border-border bg-card shadow-minimal">
        <button
          type="button"
          onClick={() => setYamlOpen(o => !o)}
          aria-expanded={yamlOpen}
          className="flex w-full items-center gap-2 rounded-xl px-4 py-2.5 text-left transition-colors hover:bg-foreground/[0.02]"
        >
          <ChevronDown
            className={cn('h-4 w-4 shrink-0 text-foreground/45 transition-transform', yamlOpen ? 'rotate-0' : '-rotate-90')}
            strokeWidth={2}
          />
          <span className="font-mono text-[13px] font-bold">task.yaml</span>
          <span className="inline-flex items-center gap-1 rounded-full bg-foreground/[0.05] px-2 py-0.5 text-[11px] font-medium text-foreground/55">
            <Hash className="h-3 w-3" strokeWidth={2} />
            workspace/tasks/{slug}.yaml
          </span>
          <span className="ml-auto text-[11px] text-foreground/40">
            {yamlOpen ? 'generated · editable · written on Prepare' : 'click to preview'}
          </span>
        </button>
        {yamlOpen && (
          <div className="px-4 pb-4">
            <div className="max-h-[210px] overflow-auto rounded-lg border border-border/60 bg-foreground/[0.025] p-3">
              <div className="font-mono text-[11.5px] leading-[1.55]">
                {yaml.split('\n').map((ln, i) => (
                  <YamlLine key={i} line={ln} />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
