import * as React from 'react'
import { CheckCircle2, CirclePause, CirclePlay, Loader2, OctagonX, Workflow } from 'lucide-react'
import type { MissionPlanResult, MissionSnapshotDto } from '@craft-agent/shared/protocol'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'

interface MissionControlPopoverProps {
  workspaceId: string
  sessionId: string
  cwd?: string
  projectId?: string
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

function upsertMission(current: MissionSnapshotDto[], snapshot: MissionSnapshotDto): MissionSnapshotDto[] {
  const next = current.filter((mission) => mission.spec.id !== snapshot.spec.id)
  next.push(snapshot)
  return next.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

export function MissionControlPopover({ workspaceId, sessionId, cwd, projectId }: MissionControlPopoverProps) {
  const [open, setOpen] = React.useState(false)
  const [goal, setGoal] = React.useState('')
  const [missions, setMissions] = React.useState<MissionSnapshotDto[]>([])
  const [plan, setPlan] = React.useState<MissionPlanResult | null>(null)
  const [plannerSessionId, setPlannerSessionId] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<'loading' | 'planning' | 'starting' | string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const refresh = React.useCallback(async () => {
    setBusy((value) => value ?? 'loading')
    try {
      const all = await window.electronAPI.listMissions(workspaceId)
      setMissions(all.filter((mission) => mission.spec.originSessionId === sessionId))
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy((value) => value === 'loading' ? null : value)
    }
  }, [sessionId, workspaceId])

  React.useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  React.useEffect(() => {
    const offChanged = window.electronAPI.onMissionChanged((changedWorkspaceId, snapshot) => {
      if (changedWorkspaceId !== workspaceId || snapshot.spec.originSessionId !== sessionId) return
      setMissions((current) => upsertMission(current, snapshot))
    })
    const offPlanned = window.electronAPI.onMissionPlanned((changedWorkspaceId, result) => {
      if (changedWorkspaceId !== workspaceId) return
      if (result.spec?.originSessionId !== sessionId && result.plannerSessionId !== plannerSessionId) return
      setPlan(result)
      setBusy(null)
      if (result.status === 'failed') setError(result.error ?? 'La planification a échoué.')
      else if (result.status === 'invalid') setError('Le plan proposé ne respecte pas le contrat Mission V2.')
      else setError(null)
    })
    return () => {
      offChanged()
      offPlanned()
    }
  }, [plannerSessionId, sessionId, workspaceId])

  const createPlan = React.useCallback(async () => {
    const requestGoal = goal.trim()
    if (!requestGoal) return
    setBusy('planning')
    setError(null)
    setPlan(null)
    try {
      const ack = await window.electronAPI.planMission(workspaceId, {
        goal: requestGoal,
        originSessionId: sessionId,
        ...(cwd ? { cwd } : {}),
        ...(projectId ? { projectId } : {}),
      })
      setPlannerSessionId(ack.plannerSessionId)
    } catch (cause) {
      setBusy(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [cwd, goal, projectId, sessionId, workspaceId])

  const startPlan = React.useCallback(async () => {
    if (plan?.status !== 'planned' || !plan.spec) return
    setBusy('starting')
    setError(null)
    try {
      const snapshot = await window.electronAPI.startMission(workspaceId, { spec: plan.spec })
      setMissions((current) => upsertMission(current, snapshot))
      setPlan(null)
      setPlannerSessionId(null)
      setGoal('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }, [plan, workspaceId])

  const control = React.useCallback(async (
    mission: MissionSnapshotDto,
    action: 'pause' | 'resume' | 'cancel',
  ) => {
    if (action === 'cancel' && !window.confirm(`Annuler définitivement « ${mission.spec.title} » ?`)) return
    setBusy(`${action}:${mission.spec.id}`)
    setError(null)
    try {
      const snapshot = action === 'pause'
        ? await window.electronAPI.pauseMission(workspaceId, {
            missionId: mission.spec.id, reason: 'Pause demandée depuis le chat d’origine',
          })
        : action === 'resume'
          ? await window.electronAPI.resumeMission(workspaceId, { missionId: mission.spec.id })
          : await window.electronAPI.cancelMission(workspaceId, {
              missionId: mission.spec.id, reason: 'Annulation demandée depuis le chat d’origine',
            })
      setMissions((current) => upsertMission(current, snapshot))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }, [workspaceId])

  const activeCount = missions.filter((mission) => !TERMINAL.has(mission.status)).length

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <span className="relative inline-flex">
          <PanelHeaderCenterButton
            icon={<Workflow className="h-4 w-4" />}
            tooltip="Missions autonomes"
            aria-label="Missions autonomes"
          />
          {activeCount > 0 && (
            <span className="pointer-events-none absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-foreground text-[9px] font-semibold text-background">
              {activeCount}
            </span>
          )}
        </span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[420px] max-w-[calc(100vw-24px)] p-0">
        <div className="border-b border-foreground/10 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold">Missions autonomes</p>
              <p className="text-xs text-muted-foreground">Planification, spécialistes, contrôles et corrections.</p>
            </div>
            {busy === 'loading' && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          </div>
        </div>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto p-4">
          {error && (
            <div className="rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
              {plan?.issues?.length ? (
                <ul className="mt-1 list-disc pl-4">
                  {plan.issues.slice(0, 4).map((issue) => <li key={`${issue.path}:${issue.message}`}>{issue.path}: {issue.message}</li>)}
                </ul>
              ) : null}
            </div>
          )}

          <section className="space-y-2">
            <label className="text-xs font-medium" htmlFor={`mission-goal-${sessionId}`}>Nouvelle mission depuis ce chat</label>
            <textarea
              id={`mission-goal-${sessionId}`}
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="Décrivez le résultat attendu et les contraintes…"
              className="min-h-20 w-full resize-y rounded-md border border-foreground/15 bg-background px-3 py-2 text-sm outline-none focus:border-foreground/35"
              disabled={busy === 'planning' || busy === 'starting'}
            />
            <Button size="sm" className="w-full" onClick={createPlan} disabled={!goal.trim() || busy === 'planning' || busy === 'starting'}>
              {busy === 'planning' ? <Loader2 className="animate-spin" /> : <Workflow />}
              {busy === 'planning' ? 'Planification en cours…' : 'Préparer le plan contrôlé'}
            </Button>
          </section>

          {plan?.status === 'planned' && plan.spec && (
            <section className="space-y-3 rounded-lg border border-foreground/15 bg-foreground/[0.025] p-3">
              <div>
                <p className="text-sm font-semibold">{plan.spec.title}</p>
                <p className="mt-1 text-xs text-muted-foreground">{plan.spec.objective}</p>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                <Metric value={plan.spec.workItems.filter((item) => item.kind === 'objective').length} label="objectifs" />
                <Metric value={plan.spec.workItems.filter((item) => item.kind !== 'objective').length} label="tâches" />
                <Metric value={plan.spec.workItems.filter((item) => item.effect === 'workspace-write').length} label="écritures" />
              </div>
              {plan.spec.workItems.some((item) => item.effect === 'workspace-write') && (
                <p className="rounded-md border border-amber-500/25 bg-amber-500/5 px-2.5 py-2 text-xs text-amber-600 dark:text-amber-300">
                  Ce plan modifie le workspace. Les chemins d’écriture déclarés restent confinés et les agents demanderont confirmation.
                </p>
              )}
              <div className="space-y-1">
                {plan.spec.workItems.filter((item) => item.kind === 'objective').map((objective) => (
                  <div key={objective.id} className="rounded-md bg-background px-2.5 py-2 text-xs">
                    <span className="font-medium">{objective.title}</span>
                    <span className="ml-2 text-muted-foreground">
                      {plan.spec!.workItems.filter((item) => item.objectiveId === objective.id).length} tâche(s)
                    </span>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="flex-1" onClick={() => setPlan(null)}>Replanifier</Button>
                <Button size="sm" className="flex-1" onClick={startPlan} disabled={busy === 'starting'}>
                  {busy === 'starting' ? <Loader2 className="animate-spin" /> : <CirclePlay />}
                  Lancer
                </Button>
              </div>
            </section>
          )}

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium">Missions de ce chat</p>
              <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => void refresh()}>Actualiser</button>
            </div>
            {missions.length === 0 ? (
              <p className="rounded-md border border-dashed border-foreground/15 px-3 py-4 text-center text-xs text-muted-foreground">Aucune mission.</p>
            ) : missions.map((mission) => (
              <MissionRow key={mission.spec.id} mission={mission} busy={busy} onControl={control} />
            ))}
          </section>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function Metric({ value, label }: { value: number; label: string }) {
  return <div className="rounded-md bg-background px-2 py-1.5"><strong className="block text-sm">{value}</strong><span className="text-muted-foreground">{label}</span></div>
}

function MissionRow({
  mission,
  busy,
  onControl,
}: {
  mission: MissionSnapshotDto
  busy: string | null
  onControl: (mission: MissionSnapshotDto, action: 'pause' | 'resume' | 'cancel') => void
}) {
  const items = Object.values(mission.workItems)
  const done = items.filter((item) => item.status === 'accepted' || item.status === 'submitted').length
  const running = items.filter((item) => item.status === 'reserved' || item.status === 'running').length
  const isBusy = busy?.endsWith(`:${mission.spec.id}`) ?? false
  return (
    <div className="space-y-2 rounded-lg border border-foreground/10 px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{mission.spec.title}</p>
          <p className="text-xs text-muted-foreground">{mission.status} · {done}/{items.length} validés · {running} actif(s)</p>
        </div>
        {mission.status === 'completed' && <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />}
      </div>
      {!TERMINAL.has(mission.status) && (
        <div className="flex gap-1.5">
          {mission.status === 'paused' ? (
            <Button variant="secondary" size="sm" className="h-7 flex-1" disabled={isBusy} onClick={() => onControl(mission, 'resume')}>
              <CirclePlay /> Reprendre
            </Button>
          ) : (
            <Button variant="secondary" size="sm" className="h-7 flex-1" disabled={isBusy} onClick={() => onControl(mission, 'pause')}>
              <CirclePause /> Pause
            </Button>
          )}
          <Button variant="outline" size="sm" className="h-7 flex-1 text-destructive" disabled={isBusy} onClick={() => onControl(mission, 'cancel')}>
            <OctagonX /> Annuler
          </Button>
        </div>
      )}
    </div>
  )
}

export const missionControlInternals = { upsertMission }
