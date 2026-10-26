
import { Trash2, X } from 'lucide-react';

import { useTranslation } from 'react-i18next';

import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import type { KanbanModelProviderGroup } from './types';
import { canDependOn, type EditorSubtask } from './task-spec-form';

import { SelectButton, ModelSelect } from "./task-editor-primitives";

export function SubtaskCard({
  index,
  subtask,
  allSubtasks,
  groups,
  fallbackModel,
  modelToConnection,
  onChange,
  onRemove,
}: {
  index: number
  subtask: EditorSubtask
  /** Every row, so dependency chips resolve titles (incl. forward edges) and add-candidates can be cycle-filtered. */
  allSubtasks: EditorSubtask[]
  groups: KanbanModelProviderGroup[]
  /** Effective model shown when the node has no explicit one (it inherits the orchestrator default). */
  fallbackModel: string
  /** model id → connection slug, so picking a model pins the connection that serves it. */
  modelToConnection: Map<string, string>
  onChange: (patch: Partial<EditorSubtask>) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const titleByUid = new Map(allSubtasks.map((s) => [s.uid, s.title]))
  const depTitle = (depUid: string) => titleByUid.get(depUid) || t('tasks.untitledSubtask')
  const addDep = (depUid: string) => onChange({ dependsOn: [...subtask.dependsOn, depUid] })
  const removeDep = (depUid: string) => onChange({ dependsOn: subtask.dependsOn.filter((d) => d !== depUid) })
  // Candidates exclude self, already-selected, and any edge that would close a cycle.
  const candidates = allSubtasks.filter(
    (s) => !subtask.dependsOn.includes(s.uid) && canDependOn(allSubtasks, subtask.uid, s.uid),
  )
  return (
    <div className="group rounded-[10px] border border-border/70 bg-foreground/[0.015] p-3">
      <div className="flex items-start gap-2">
        <div className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-indigo-500/10 text-[12px] font-bold text-indigo-500 dark:text-indigo-300">
          {index + 1}
        </div>
        <div className="min-w-0 flex-1">
          <input
            value={subtask.title}
            onChange={(e) => onChange({ title: e.target.value })}
            placeholder={t('tasks.subtaskTitlePlaceholder')}
            className="w-full bg-transparent text-[13.5px] font-semibold text-foreground outline-none placeholder:text-foreground/30"
          />
          <textarea
            value={subtask.prompt}
            onChange={(e) => onChange({ prompt: e.target.value })}
            rows={2}
            placeholder={t('tasks.promptPlaceholder')}
            className="mt-1.5 w-full resize-none rounded-md border border-border/60 bg-background px-2 py-1.5 text-[12px] leading-relaxed outline-none focus:border-foreground/25 field-sizing-content max-h-40"
          />
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <ModelSelect
              value={subtask.model ?? fallbackModel}
              onChange={(id) => onChange({ model: id, llmConnection: modelToConnection.get(id) })}
              groups={groups}
              width={128}
              size="sm"
            />
            {subtask.dependsOn.map((depUid) => (
              <span
                key={depUid}
                className="inline-flex h-7 max-w-[168px] items-center gap-1 rounded-lg border border-border bg-foreground/[0.03] pl-2 pr-1 text-[11.5px] font-medium text-foreground/70"
              >
                <span className="truncate">{t('tasks.dependsOnLabel', { title: depTitle(depUid) })}</span>
                <button
                  type="button"
                  onClick={() => removeDep(depUid)}
                  aria-label={t('tasks.removeDependency')}
                  className="grid h-4 w-4 shrink-0 place-items-center rounded text-foreground/40 hover:bg-foreground/10 hover:text-red-500"
                >
                  <X className="h-3 w-3" strokeWidth={2.5} />
                </button>
              </span>
            ))}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SelectButton size="sm" style={{ width: 144 }}>
                  <span className="truncate text-foreground/70">
                    {subtask.dependsOn.length === 0 ? t('tasks.noDependencies') : t('tasks.addDependency')}
                  </span>
                </SelectButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-w-[240px]">
                {candidates.map((c) => (
                  <DropdownMenuItem key={c.uid} className="text-xs" onSelect={() => addDep(c.uid)}>
                    <span className="truncate">{c.title || t('tasks.untitledSubtask')}</span>
                  </DropdownMenuItem>
                ))}
                {candidates.length === 0 && (
                  <div className="px-2 py-1.5 text-[11px] text-foreground/40">{t('tasks.noAvailableSubtasks')}</div>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label={t('tasks.removeSubtask')}
          className="grid h-6 w-6 shrink-0 place-items-center rounded text-foreground/40 opacity-0 transition-all hover:bg-foreground/10 hover:text-red-500 group-hover:opacity-100"
        >
          <Trash2 className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>
    </div>
  )
}
