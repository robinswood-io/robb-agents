import * as React from 'react';
import { ChevronLeft, Sparkles, Plus, Check, ExternalLink, RefreshCw, Archive } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Spinner, LoadingIndicator } from '@craft-agent/ui';

import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import type { KanbanModelProviderGroup } from './types';
import { DEFAULT_REPAIR_ATTEMPTS, MAX_REPAIR_ATTEMPTS_CAP, type EditorSubtask, type TaskPermissionMode } from './task-spec-form';

import type { LoadedSource, LoadedSkill } from '../../../../shared/types';
import { type Mode, type Tab, Btn, SelectButton, ModelSelect, FieldRow } from "./task-editor-primitives";
import { SourcesField, SkillsField, FolderField } from "./task-editor-resources";
import { SubtaskCard } from "./task-editor-subtask";
import { ResultsPanel } from "./task-editor-results";

interface TaskEditorContentProps {
  onClose: () => void
  t: import("i18next").TFunction<"translation", undefined>
  isEdit: boolean
  setTab: React.Dispatch<React.SetStateAction<Tab>>
  tab: Tab
  onOpenSession: (() => void) | undefined
  busy: boolean
  editSlug: string | undefined
  archiveTask: () => Promise<void>
  submit: (run: boolean) => Promise<void>
  loadResults: () => void
  resultsLoading: boolean
  results: import("@craft-agent/shared/protocol").TaskResultsDto | null
  controlMission: (action: "pause" | "resume" | "stop") => Promise<void>
  resolveMissionApproval: (requestId: string, decision: "approved" | "rejected") => Promise<void>
  repairMissionNode: (nodeId: string) => Promise<void>
  setMode: React.Dispatch<React.SetStateAction<Mode>>
  mode: Mode
  title: string
  setTitle: React.Dispatch<React.SetStateAction<string>>
  description: string
  setDescription: React.Dispatch<React.SetStateAction<string>>
  goal: string
  setGoal: React.Dispatch<React.SetStateAction<string>>
  acceptanceCriteria: string
  setAcceptanceCriteria: React.Dispatch<React.SetStateAction<string>>
  project: import("@craft-agent/shared/projects").LoadedProject | undefined
  boundProjectId: string
  setProjectId: React.Dispatch<React.SetStateAction<string>>
  projectId: string
  projects: import("@craft-agent/shared/projects").LoadedProject[]
  orchModel: string
  setOrchModel: React.Dispatch<React.SetStateAction<string>>
  setOrchConnection: React.Dispatch<React.SetStateAction<string | undefined>>
  modelToConnection: Map<string, string>
  groups: KanbanModelProviderGroup[]
  permissionMode: TaskPermissionMode
  setPermissionMode: React.Dispatch<React.SetStateAction<TaskPermissionMode>>
  enabledSources: LoadedSource[]
  sourceSlugs: string[]
  setSourceSlugs: React.Dispatch<React.SetStateAction<string[]>>
  workspaceSkills: LoadedSkill[]
  skillSlugs: string[]
  setSkillSlugs: React.Dispatch<React.SetStateAction<string[]>>
  workspaceId: string
  cwd: string
  setCwd: React.Dispatch<React.SetStateAction<string>>
  maxRepairs: string
  setMaxRepairs: React.Dispatch<React.SetStateAction<string>>
  subtasks: EditorSubtask[]
  addSubtask: () => void
  fallbackModel: string
  updateSubtask: (id: string, patch: Partial<EditorSubtask>) => void
  removeSubtask: (id: string) => void
  generatePlan: () => Promise<void>
}

export function TaskEditorContent({
  onClose,
  t,
  isEdit,
  setTab,
  tab,
  onOpenSession,
  busy,
  editSlug,
  archiveTask,
  submit,
  loadResults,
  resultsLoading,
  results,
  controlMission,
  resolveMissionApproval,
  repairMissionNode,
  setMode,
  mode,
  title,
  setTitle,
  description,
  setDescription,
  goal,
  setGoal,
  acceptanceCriteria,
  setAcceptanceCriteria,
  project,
  boundProjectId,
  setProjectId,
  projectId,
  projects,
  orchModel,
  setOrchModel,
  setOrchConnection,
  modelToConnection,
  groups,
  permissionMode,
  setPermissionMode,
  enabledSources,
  sourceSlugs,
  setSourceSlugs,
  workspaceSkills,
  skillSlugs,
  setSkillSlugs,
  workspaceId,
  cwd,
  setCwd,
  maxRepairs,
  setMaxRepairs,
  subtasks,
  addSubtask,
  fallbackModel,
  updateSubtask,
  removeSubtask,
  generatePlan,
}: TaskEditorContentProps) {

  return (
    <div className="flex h-full flex-col gap-3 bg-background p-3 text-foreground">
      {/* Header */}
      <div className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2.5 shadow-minimal">
        <Btn variant="ghost" className="px-2" onClick={onClose}>
          <ChevronLeft className="h-4 w-4" strokeWidth={2} /> {t('kanban.board')}
        </Btn>
        <span className="text-foreground/25">/</span>
        <span className="text-sm font-semibold">{isEdit ? t('tasks.editTask') : t('kanban.newTask')}</span>

        {/* Definition / Results tabs — edit mode only (results need a backing task to read). */}
        {isEdit && (
          <div className="ml-3 inline-flex rounded-[9px] bg-foreground/[0.05] p-0.5">
            {(['definition', 'results'] as Tab[]).map((tb) => (
              <button
                key={tb}
                onClick={() => setTab(tb)}
                className={cn(
                  'rounded-[7px] px-3 py-1 text-[12.5px] font-semibold transition-colors',
                  tab === tb ? 'bg-card text-foreground shadow-minimal' : 'text-foreground/55 hover:text-foreground/80',
                )}
              >
                {tb === 'definition' ? t('tasks.tabDefinition') : t('tasks.tabResults')}
              </button>
            ))}
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          {isEdit && onOpenSession && (
            <Btn variant="secondary" onClick={onOpenSession} disabled={busy}>
              <ExternalLink className="h-3.5 w-3.5" strokeWidth={2} /> {t('tasks.openSession')}
            </Btn>
          )}
          {isEdit && editSlug && (
            <Btn variant="ghost" onClick={archiveTask} disabled={busy} title={t('tasks.archiveTask')}>
              <Archive className="h-3.5 w-3.5" strokeWidth={2} /> {t('tasks.archiveTask')}
            </Btn>
          )}
          {tab === 'definition' && (
            <>
              <Btn variant="secondary" onClick={onClose} disabled={busy}>
                {t('common.cancel')}
              </Btn>
              <Btn variant="secondary" onClick={() => submit(false)} disabled={busy}>
                {isEdit ? t('common.save') : t('common.create')}
              </Btn>
              <Btn variant="primary" onClick={() => submit(true)} disabled={busy}>
                {busy ? <Spinner /> : <Sparkles className="h-3.5 w-3.5" strokeWidth={2.5} />}
                {busy ? t('tasks.starting') : isEdit ? t('tasks.saveAndRun') : t('tasks.createAndRun')}
              </Btn>
            </>
          )}
          {tab === 'results' && (
            <Btn variant="secondary" onClick={loadResults} disabled={resultsLoading}>
              {resultsLoading ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" strokeWidth={2} />} {t('common.refresh')}
            </Btn>
          )}
        </div>
      </div>

      {tab === 'results' ? (
        <ResultsPanel
          results={results}
          loading={resultsLoading}
          onControl={controlMission}
          onResolveApproval={resolveMissionApproval}
          onRepairNode={repairMissionNode}
        />
      ) : (
      /* Body */
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(360px,2fr)_3fr] gap-3">
        {/* Left — definition */}
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto rounded-xl border border-border bg-card p-4 shadow-minimal">
          <div className="text-[15px] font-bold">{t('tasks.definition')}</div>

          <div className="inline-flex w-fit rounded-[9px] bg-foreground/[0.05] p-0.5">
            {(['manual', 'generate'] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-[7px] px-3 py-1.5 text-[12.5px] font-semibold transition-colors',
                  mode === m ? 'bg-card text-foreground shadow-minimal' : 'text-foreground/55 hover:text-foreground/80',
                )}
              >
                {m === 'generate' && <Sparkles className="h-3.5 w-3.5" strokeWidth={2.5} />}
                {m === 'generate' ? t('tasks.modeGenerate') : t('tasks.modeManual')}
              </button>
            ))}
          </div>

          <div>
            <div className="mb-1.5 text-[12px] font-semibold text-foreground/55">{t('tasks.title')}</div>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('tasks.titlePlaceholder')}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[13.5px] font-semibold outline-none focus:border-foreground/25"
            />
          </div>

          <div>
            <div className="mb-1.5 text-[12px] font-semibold text-foreground/55">{t('common.description')}</div>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder={t('common.description')}
              className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-[12.5px] leading-relaxed outline-none focus:border-foreground/25 field-sizing-content max-h-36"
            />
          </div>

          <div>
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="text-[12px] font-semibold text-foreground/55">{t('tasks.goal')}</span>
              <span className="text-[10.5px] text-foreground/35">{t('tasks.goalHint')}</span>
            </div>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={4}
              placeholder={t('tasks.goalPlaceholder')}
              className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-[12.5px] leading-relaxed outline-none focus:border-foreground/25 field-sizing-content max-h-48"
            />
          </div>

          <div>
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="text-[12px] font-semibold text-foreground/55">{t('tasks.acceptanceCriteria')}</span>
              <span className="text-[10.5px] text-foreground/35">{t('tasks.acceptanceCriteriaHint')}</span>
            </div>
            <textarea
              value={acceptanceCriteria}
              onChange={(e) => setAcceptanceCriteria(e.target.value)}
              rows={3}
              placeholder={t('tasks.acceptanceCriteriaPlaceholder')}
              className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-[12.5px] leading-relaxed outline-none focus:border-foreground/25 field-sizing-content max-h-48"
            />
          </div>

          <div className="flex flex-col gap-3">
            <FieldRow label={t('tasks.project')}>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SelectButton style={{ width: 168 }}>
                    <span className="truncate">{project ? project.config.name : t('tasks.noProject')}</span>
                  </SelectButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[160px]">
                  {/* "No Project" clears the binding — only offered when NOT already bound. The backend
                      never unbinds on save, and buildSpec floors a blank pick to the existing project,
                      so showing it for a bound task would be a no-op that implies clearing works. */}
                  {!boundProjectId && (
                    <DropdownMenuItem className="text-xs" onSelect={() => setProjectId('')}>
                      {t('tasks.noProject')}
                      {!projectId && <Check className="ml-auto h-3.5 w-3.5" strokeWidth={2} />}
                    </DropdownMenuItem>
                  )}
                  {projects.map((p) => (
                    <DropdownMenuItem key={p.config.id} className="text-xs" onSelect={() => setProjectId(p.config.id)}>
                      <span className="truncate">{p.config.name}</span>
                      {projectId === p.config.id && <Check className="ml-auto h-3.5 w-3.5 shrink-0" strokeWidth={2} />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </FieldRow>

            <FieldRow label={t('tasks.orchestratorModel')}>
              <ModelSelect
                value={orchModel}
                onChange={(m) => {
                  // Keep the connection in step with the model: an unchanged model preserves the loaded
                  // (possibly custom) connection; changing it re-routes to the new model's connection.
                  setOrchModel(m)
                  setOrchConnection(modelToConnection.get(m))
                }}
                groups={groups}
              />
            </FieldRow>

            <FieldRow label={t('tasks.permissionMode')}>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SelectButton style={{ width: 168 }}>
                    <span className="truncate">{t(`mode.${permissionMode}`)}</span>
                  </SelectButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[160px]">
                  {(['allow-all', 'ask', 'safe'] as const).map((m) => (
                    <DropdownMenuItem key={m} className="text-xs" onSelect={() => setPermissionMode(m)}>
                      <span className="truncate">{t(`mode.${m}`)}</span>
                      {permissionMode === m && <Check className="ml-auto h-3.5 w-3.5 shrink-0" strokeWidth={2} />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </FieldRow>

            {enabledSources.length > 0 && (
              <FieldRow label={t('tasks.sources')}>
                <SourcesField
                  sources={enabledSources}
                  values={sourceSlugs}
                  onChange={setSourceSlugs}
                  title={t('tasks.sourcesHint')}
                />
              </FieldRow>
            )}

            {workspaceSkills.length > 0 && (
              <FieldRow label={t('tasks.skills')}>
                <SkillsField
                  skills={workspaceSkills}
                  values={skillSlugs}
                  onChange={setSkillSlugs}
                  workspaceId={workspaceId}
                  title={t('tasks.skillsHint')}
                />
              </FieldRow>
            )}

            <FieldRow label={t('tasks.workingDirectory')}>
              <FolderField cwd={cwd} onChange={setCwd} workspaceId={workspaceId} />
            </FieldRow>

            <FieldRow label={t('tasks.maxRepairs')}>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={MAX_REPAIR_ATTEMPTS_CAP}
                value={maxRepairs}
                onChange={(e) => setMaxRepairs(e.target.value)}
                placeholder={String(DEFAULT_REPAIR_ATTEMPTS)}
                title={t('tasks.maxRepairsHint')}
                className="h-8 w-[88px] rounded-lg border border-border bg-background px-2.5 text-right text-[12.5px] tabular-nums outline-none focus:border-foreground/25 placeholder:text-foreground/30"
              />
            </FieldRow>
          </div>
        </div>

        {/* Right — subtasks (Manual) / scaffold (Generate) */}
        <div className="flex min-h-0 flex-col rounded-xl border border-border bg-card shadow-minimal">
          {mode === 'manual' ? (
            <>
              <div className="flex shrink-0 items-center gap-2 px-4 pt-4">
                <span className="text-[15px] font-bold">{t('kanban.subtasks')}</span>
                <span className="grid h-5 min-w-[20px] place-items-center rounded-full bg-foreground/[0.06] px-1.5 text-[11px] font-bold text-foreground/55">
                  {subtasks.length}
                </span>
                <Btn variant="secondary" className="ml-auto h-7 px-2.5 text-[12px]" onClick={addSubtask}>
                  <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> {t('kanban.addSubtask')}
                </Btn>
              </div>

              <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-4">
                {subtasks.map((st, i) => (
                  <SubtaskCard
                    key={st.uid}
                    index={i}
                    subtask={st}
                    allSubtasks={subtasks}
                    groups={groups}
                    fallbackModel={orchModel || fallbackModel}
                    modelToConnection={modelToConnection}
                    onChange={(patch) => updateSubtask(st.uid, patch)}
                    onRemove={() => removeSubtask(st.uid)}
                  />
                ))}
                {subtasks.length === 0 && (
                  <button
                    onClick={addSubtask}
                    className="flex w-full items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-border py-2.5 text-[12.5px] font-semibold text-foreground/40 transition-colors hover:border-foreground/30 hover:text-foreground/60"
                  >
                    <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> {t('tasks.addFirstSubtask')}
                  </button>
                )}
              </div>

              <div className="shrink-0 border-t border-border/60 px-4 py-2.5 text-[10.5px] text-foreground/40">
                {t('tasks.subtaskFooter')}
              </div>
            </>
          ) : busy ? (
            <div className="flex min-h-full flex-col gap-3 p-4">
              <div className="flex items-center gap-2 text-[13px] font-semibold text-foreground/70">
                <LoadingIndicator label={t('tasks.generatingTitle')} showElapsed />
              </div>
              <p className="text-[12px] leading-relaxed text-foreground/50">{t('tasks.generatingBody')}</p>
              {/* Skeleton subtask cards: the long author wait reads as "drafting nodes", not frozen. */}
              {[0, 1, 2].map((i) => (
                <div key={i} className="animate-pulse rounded-[10px] border border-border/70 bg-foreground/[0.015] p-3">
                  <div className="flex items-start gap-2">
                    <div className="mt-0.5 h-6 w-6 shrink-0 rounded-full bg-foreground/[0.06]" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="h-3.5 w-1/2 rounded bg-foreground/[0.06]" />
                      <div className="h-8 w-full rounded bg-foreground/[0.04]" />
                      <div className="flex gap-1.5">
                        <div className="h-7 w-[128px] rounded-lg bg-foreground/[0.05]" />
                        <div className="h-7 w-[144px] rounded-lg bg-foreground/[0.05]" />
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex min-h-full flex-col items-center justify-center gap-3 px-6 py-8 text-center">
              <div className="grid h-12 w-12 place-items-center rounded-full bg-indigo-500/10 text-indigo-500 dark:text-indigo-300">
                <Sparkles className="h-6 w-6" strokeWidth={2} />
              </div>
              <div className="text-[14px] font-bold">{t('tasks.generatePlan')}</div>
              <p className="max-w-[360px] text-[12.5px] leading-relaxed text-foreground/55">{t('tasks.generateBody')}</p>
              <Btn variant="primary" onClick={generatePlan} disabled={busy}>
                <Sparkles className="h-3.5 w-3.5" strokeWidth={2.5} /> {t('tasks.generatePlan')}
              </Btn>
              <span className="text-[11px] text-foreground/40">{t('tasks.generateHint')}</span>
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  )
}
