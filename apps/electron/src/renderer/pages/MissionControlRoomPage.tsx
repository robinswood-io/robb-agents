import * as React from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  CirclePause,
  CirclePlay,
  Clock3,
  DollarSign,
  FileCheck2,
  Loader2,
  OctagonX,
  RefreshCw,
  Search,
  ShieldCheck,
  Users,
  Workflow,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  MissionConnectorApprovalRequestDto,
  MissionProofPassportDto,
  MissionProofPassportTrustAnchorDto,
  MissionProofPassportVerificationDto,
  MissionSnapshotDto,
  TaskApprovalRequestDto,
} from '@craft-agent/shared/protocol'
import { Button } from '@/components/ui/button'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'
import { useAppShellContext } from '@/context/AppShellContext'
import { useNavigation } from '@/contexts/NavigationContext'
import { routes } from '@/lib/navigate'
import { cn } from '@/lib/utils'
import {
  filterAndSortMissions,
  getMissionAnalytics,
  getMissionTrustAnchorCopyValue,
  isCurrentMissionPassportRequest,
  MISSION_STATUS_VALUES,
  TERMINAL_MISSION_STATUSES,
  type MissionRisk,
  type MissionRiskFilter,
  type MissionStatusFilter,
  type MissionTrustAnchorCopyFormat,
} from './mission-control-model'
import { MissionDigitalTwinPanel } from './mission-digital-twin-panel'

const PAGE_SIZE = 50

interface MissionControlRoomPageProps {
  selectedMissionId?: string
}

function upsertMission(current: MissionSnapshotDto[], snapshot: MissionSnapshotDto): MissionSnapshotDto[] {
  return [snapshot, ...current.filter((mission) => mission.spec.id !== snapshot.spec.id)]
}

export default function MissionControlRoomPage({ selectedMissionId }: MissionControlRoomPageProps) {
  const { t, i18n } = useTranslation()
  const { activeWorkspaceId } = useAppShellContext()
  const { navigate } = useNavigation()
  const [missions, setMissions] = React.useState<MissionSnapshotDto[]>([])
  const [connectorApprovals, setConnectorApprovals] = React.useState<MissionConnectorApprovalRequestDto[]>([])
  const [taskApprovals, setTaskApprovals] = React.useState<TaskApprovalRequestDto[]>([])
  const [query, setQuery] = React.useState('')
  const [statusFilter, setStatusFilter] = React.useState<MissionStatusFilter>('all')
  const [riskFilter, setRiskFilter] = React.useState<MissionRiskFilter>('all')
  const [projectFilter, setProjectFilter] = React.useState('')
  const [page, setPage] = React.useState(1)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [busyAction, setBusyAction] = React.useState<string | null>(null)
  const [nowMs, setNowMs] = React.useState(() => Date.now())
  const refreshSequence = React.useRef(0)
  const activeWorkspaceRef = React.useRef(activeWorkspaceId)
  const selectedMissionRef = React.useRef<HTMLDivElement>(null)

  activeWorkspaceRef.current = activeWorkspaceId

  React.useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const refresh = React.useCallback(async () => {
    const sequence = ++refreshSequence.current
    if (!activeWorkspaceId) {
      setMissions([])
      setConnectorApprovals([])
      setTaskApprovals([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const [snapshots, pendingConnectorApprovals, pendingTaskApprovals] = await Promise.all([
        window.electronAPI.listMissions(activeWorkspaceId),
        window.electronAPI.listMissionConnectorApprovals(activeWorkspaceId),
        window.electronAPI.listTaskApprovals(activeWorkspaceId),
      ])
      if (sequence !== refreshSequence.current || activeWorkspaceRef.current !== activeWorkspaceId) return
      setMissions(snapshots)
      setConnectorApprovals(pendingConnectorApprovals)
      setTaskApprovals(pendingTaskApprovals)
      setError(null)
    } catch (cause) {
      if (sequence !== refreshSequence.current || activeWorkspaceRef.current !== activeWorkspaceId) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (sequence === refreshSequence.current) setLoading(false)
    }
  }, [activeWorkspaceId])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  React.useEffect(() => {
    if (!activeWorkspaceId) return
    return window.electronAPI.onMissionChanged((workspaceId, snapshot) => {
      if (workspaceId !== activeWorkspaceId) return
      setMissions((current) => upsertMission(current, snapshot))
      void window.electronAPI.listMissionConnectorApprovals(activeWorkspaceId)
        .then((pending) => {
          if (activeWorkspaceRef.current === activeWorkspaceId) setConnectorApprovals(pending)
        })
        .catch(() => {})
    })
  }, [activeWorkspaceId])

  React.useEffect(() => {
    setPage(1)
  }, [query, statusFilter, riskFilter, projectFilter])

  const filtered = React.useMemo(() => filterAndSortMissions(missions, {
    query,
    status: statusFilter,
    risk: riskFilter,
    projectId: projectFilter,
  }, nowMs), [missions, query, statusFilter, riskFilter, projectFilter, nowMs])
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount)
  const visibleMissions = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
  const selectedMission = selectedMissionId
    ? missions.find((mission) => mission.spec.id === selectedMissionId)
    : undefined
  const selectedMissionKey = selectedMission?.spec.id
  const projects = React.useMemo(() => [...new Set(
    missions.map((mission) => mission.spec.projectId).filter((value): value is string => Boolean(value)),
  )].sort(), [missions])

  const portfolio = React.useMemo(() => {
    return missions.reduce((summary, mission) => {
      const analytics = getMissionAnalytics(mission, nowMs)
      if (!TERMINAL_MISSION_STATUSES.has(mission.status)) summary.active += 1
      if (analytics.risk !== 'healthy') summary.attention += 1
      summary.blockers += analytics.blockerCount
      summary.costUsd += analytics.costUsd
      if (analytics.hasTrackedCost) summary.trackedCostMissions += 1
      summary.requiredEvidence += analytics.requiredEvidence
      summary.hashedEvidence += analytics.hashedEvidence
      return summary
    }, { active: 0, attention: 0, blockers: 0, costUsd: 0, trackedCostMissions: 0, requiredEvidence: 0, hashedEvidence: 0 })
  }, [missions, nowMs])

  React.useEffect(() => {
    if (!selectedMissionKey) return
    selectedMissionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [selectedMissionKey])

  const control = React.useCallback(async (
    mission: MissionSnapshotDto,
    action: 'pause' | 'resume' | 'cancel',
  ) => {
    if (!activeWorkspaceId) return
    if (action === 'cancel' && !window.confirm(t('missionControl.cancelConfirm', { title: mission.spec.title }))) return
    setBusyAction(`${action}:${mission.spec.id}`)
    setError(null)
    try {
      const snapshot = action === 'pause'
        ? await window.electronAPI.pauseMission(activeWorkspaceId, {
            missionId: mission.spec.id,
            reason: t('missionControl.pauseReason'),
          })
        : action === 'resume'
          ? await window.electronAPI.resumeMission(activeWorkspaceId, { missionId: mission.spec.id })
          : await window.electronAPI.cancelMission(activeWorkspaceId, {
              missionId: mission.spec.id,
              reason: t('missionControl.cancelReason'),
            })
      if (activeWorkspaceRef.current === activeWorkspaceId) {
        setMissions((current) => upsertMission(current, snapshot))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyAction(null)
    }
  }, [activeWorkspaceId, t])

  const resolveConnectorApproval = React.useCallback(async (
    approval: MissionConnectorApprovalRequestDto,
    decision: 'approved' | 'denied',
  ) => {
    if (!activeWorkspaceId) return
    const actionLabel = decision === 'approved' ? t('tasks.approve') : t('tasks.reject')
    const consent = approval.approvalContext
    if (!window.confirm([
      `${actionLabel} — ${consent.provider} (${consent.connectorId})?`,
      consent.purpose,
      `${consent.method} ${consent.origin}`,
      `${consent.resourceClass} · ${approval.risk} · ${consent.effect}`,
    ].join('\n'))) return
    setBusyAction(`connector-approval:${approval.approvalId}`)
    setError(null)
    try {
      const snapshot = await window.electronAPI.resolveMissionConnectorApproval(activeWorkspaceId, {
        missionId: approval.missionId,
        workItemId: approval.workItemId,
        approvalId: approval.approvalId,
        requestHash: approval.requestHash,
        decision,
      })
      if (activeWorkspaceRef.current !== activeWorkspaceId) return
      setMissions((current) => upsertMission(current, snapshot))
      setConnectorApprovals(await window.electronAPI.listMissionConnectorApprovals(activeWorkspaceId))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyAction(null)
    }
  }, [activeWorkspaceId, t])

  const refreshConnectorApproval = React.useCallback(async (
    approval: MissionConnectorApprovalRequestDto,
  ) => {
    if (!activeWorkspaceId) return
    setBusyAction(`connector-approval:${approval.approvalId}`)
    setError(null)
    try {
      const snapshot = await window.electronAPI.refreshMissionConnectorApproval(activeWorkspaceId, {
        missionId: approval.missionId,
        workItemId: approval.workItemId,
      })
      if (activeWorkspaceRef.current !== activeWorkspaceId) return
      setMissions((current) => upsertMission(current, snapshot))
      setConnectorApprovals(await window.electronAPI.listMissionConnectorApprovals(activeWorkspaceId))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyAction(null)
    }
  }, [activeWorkspaceId])

  const resolveTaskApproval = React.useCallback(async (
    approval: TaskApprovalRequestDto,
    decision: 'approved' | 'rejected',
  ) => {
    if (!activeWorkspaceId) return
    const actionLabel = decision === 'approved' ? t('tasks.approve') : t('tasks.reject')
    if (!window.confirm(`${actionLabel} — ${approval.nodeId}?`)) return
    setBusyAction(`task-approval:${approval.requestId}`)
    setError(null)
    try {
      await window.electronAPI.resolveTaskApproval(activeWorkspaceId, {
        slug: approval.slug,
        runId: approval.runId,
        requestId: approval.requestId,
        decision,
        // The server ignores this legacy field and stamps the authenticated actor.
        actor: 'host-resolved',
      })
      if (activeWorkspaceRef.current !== activeWorkspaceId) return
      setTaskApprovals(await window.electronAPI.listTaskApprovals(activeWorkspaceId))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyAction(null)
    }
  }, [activeWorkspaceId, t])

  const currency = React.useMemo(() => new Intl.NumberFormat(i18n.resolvedLanguage || undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }), [i18n.resolvedLanguage])
  const dateTime = React.useMemo(() => new Intl.DateTimeFormat(i18n.resolvedLanguage || undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }), [i18n.resolvedLanguage])

  return (
    <div className="flex h-full min-w-0 flex-col bg-background">
      <PanelHeader
        title={t('tasks.controlRoom')}
        actions={(
          <PanelHeaderCenterButton
            icon={<RefreshCw className={cn('size-4', loading && 'animate-spin')} />}
            onClick={() => void refresh()}
            tooltip={t('common.refresh')}
            aria-label={t('common.refresh')}
          />
        )}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-4 p-4 @md/panel:p-6">
          <div>
            <p className="max-w-3xl text-sm text-muted-foreground">{t('missionControl.portfolioSubtitle')}</p>
            <p className="mt-1 text-[11px] text-muted-foreground/70">{t('missionControl.freshnessNote')}</p>
          </div>

          {error && (
            <div role="alert" className="rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 @3xl/panel:grid-cols-5">
            <SummaryCard icon={Workflow} label={t('missionControl.activeMissions')} value={portfolio.active} />
            <SummaryCard icon={AlertTriangle} label={t('missionControl.needsAttention')} value={portfolio.attention} tone={portfolio.attention ? 'warning' : 'default'} />
            <SummaryCard icon={OctagonX} label={t('tasks.blockers')} value={portfolio.blockers} tone={portfolio.blockers ? 'danger' : 'default'} />
            <SummaryCard
              icon={DollarSign}
              label={t('tasks.cost')}
              value={portfolio.trackedCostMissions ? currency.format(portfolio.costUsd) : t('tasks.costUntracked')}
              hint={t('missionControl.costCoverage', { tracked: portfolio.trackedCostMissions, total: missions.length })}
            />
            <SummaryCard
              icon={FileCheck2}
              label={t('missionControl.evidenceCoverage')}
              value={portfolio.requiredEvidence === 0 ? '—' : `${portfolio.hashedEvidence}/${portfolio.requiredEvidence}`}
            />
          </div>

          {(connectorApprovals.length > 0 || taskApprovals.length > 0) && (
            <ApprovalInbox
              connectorApprovals={connectorApprovals}
              taskApprovals={taskApprovals}
              missions={missions}
              busyAction={busyAction}
              dateTime={dateTime}
              nowMs={nowMs}
              onResolveConnector={resolveConnectorApproval}
              onRefreshConnector={refreshConnectorApproval}
              onResolveTask={resolveTaskApproval}
            />
          )}

          <div className="grid gap-2 rounded-xl border border-foreground/10 bg-foreground/[0.02] p-3 @xl/panel:grid-cols-[minmax(220px,1fr)_repeat(3,minmax(140px,auto))]">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('missionControl.searchPlaceholder')}
                aria-label={t('missionControl.searchPlaceholder')}
                className="h-9 w-full rounded-md border border-foreground/10 bg-background pl-9 pr-3 text-sm outline-none focus:border-foreground/30"
              />
            </label>
            <FilterSelect value={statusFilter} onChange={(value) => setStatusFilter(value as MissionStatusFilter)} ariaLabel={t('missionControl.statusFilter')}>
              <option value="all">{t('missionControl.allStatuses')}</option>
              <option value="active">{t('missionControl.activeFilter')}</option>
              <option value="terminal">{t('missionControl.terminalFilter')}</option>
              {MISSION_STATUS_VALUES.map((status) => (
                <option key={status} value={status}>{t(`missionControl.status.${status}`)}</option>
              ))}
            </FilterSelect>
            <FilterSelect value={riskFilter} onChange={(value) => setRiskFilter(value as MissionRiskFilter)} ariaLabel={t('missionControl.riskFilter')}>
              <option value="all">{t('missionControl.allRisks')}</option>
              <option value="healthy">{t('missionControl.risk.healthy')}</option>
              <option value="watch">{t('missionControl.risk.watch')}</option>
              <option value="breach">{t('missionControl.risk.breach')}</option>
            </FilterSelect>
            <FilterSelect value={projectFilter} onChange={setProjectFilter} ariaLabel={t('missionControl.projectFilter')}>
              <option value="">{t('missionControl.allProjects')}</option>
              {projects.map((projectId) => <option key={projectId} value={projectId}>{projectId}</option>)}
            </FilterSelect>
          </div>

          {selectedMissionId && (
            <div ref={selectedMissionRef}>
              {selectedMission ? (
                <MissionDetail
                  mission={selectedMission}
                  workspaceId={activeWorkspaceId ?? ''}
                  busyAction={busyAction}
                  currency={currency}
                  dateTime={dateTime}
                  nowMs={nowMs}
                  onControl={control}
                  onReplanned={(snapshot) => setMissions((current) => upsertMission(current, snapshot))}
                  onClose={() => void navigate(routes.view.missions())}
                  onOpenOrigin={selectedMission.spec.originSessionId
                    ? () => void navigate(routes.view.allSessions(selectedMission.spec.originSessionId), { newPanel: true })
                    : undefined}
                />
              ) : !loading && (
                <div role="status" className="rounded-xl border border-foreground/10 p-4 text-sm text-muted-foreground">
                  {t('missionControl.notFound', { id: selectedMissionId })}
                </div>
              )}
            </div>
          )}

          {loading && missions.length === 0 ? (
            <div className="flex min-h-56 items-center justify-center text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" /> {t('common.loading')}
            </div>
          ) : visibleMissions.length === 0 ? (
            <div className="flex min-h-56 flex-col items-center justify-center rounded-xl border border-dashed border-foreground/15 text-center">
              <Workflow className="mb-3 size-7 text-muted-foreground/50" />
              <p className="text-sm font-medium">{t('missionControl.empty')}</p>
              <p className="mt-1 max-w-md text-xs text-muted-foreground">{t('missionControl.emptyHint')}</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-foreground/10">
              <table className="w-full min-w-[980px] border-collapse text-left text-xs">
                <thead className="bg-foreground/[0.035] text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2.5 font-medium">{t('missionControl.mission')}</th>
                    <th className="px-3 py-2.5 font-medium">{t('missionControl.statusFilter')}</th>
                    <th className="px-3 py-2.5 font-medium">{t('tasks.progress')}</th>
                    <th className="px-3 py-2.5 font-medium">{t('missionControl.freshnessTitle')}</th>
                    <th className="px-3 py-2.5 font-medium">{t('tasks.cost')}</th>
                    <th className="px-3 py-2.5 font-medium">{t('tasks.blockers')}</th>
                    <th className="px-3 py-2.5 font-medium">{t('tasks.proof')}</th>
                    <th className="px-3 py-2.5 font-medium">{t('missionControl.responsible')}</th>
                    <th className="px-3 py-2.5 font-medium">{t('missionControl.updated')}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleMissions.map((mission) => (
                    <MissionPortfolioRow
                      key={mission.spec.id}
                      mission={mission}
                      selected={mission.spec.id === selectedMissionId}
                      currency={currency}
                      dateTime={dateTime}
                      nowMs={nowMs}
                      onSelect={() => void navigate(routes.view.missions(mission.spec.id))}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {filtered.length > PAGE_SIZE && (
            <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span>{t('missionControl.page', { current: safePage, total: pageCount, count: filtered.length })}</span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={safePage <= 1} onClick={() => setPage(Math.max(1, safePage - 1))}>
                  {t('overlay.previousItem')}
                </Button>
                <Button variant="outline" size="sm" disabled={safePage >= pageCount} onClick={() => setPage(Math.min(pageCount, safePage + 1))}>
                  {t('overlay.nextItem')}
                </Button>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}

function ApprovalInbox({
  connectorApprovals,
  taskApprovals,
  missions,
  busyAction,
  dateTime,
  nowMs,
  onResolveConnector,
  onRefreshConnector,
  onResolveTask,
}: {
  connectorApprovals: MissionConnectorApprovalRequestDto[]
  taskApprovals: TaskApprovalRequestDto[]
  missions: MissionSnapshotDto[]
  busyAction: string | null
  dateTime: Intl.DateTimeFormat
  nowMs: number
  onResolveConnector: (approval: MissionConnectorApprovalRequestDto, decision: 'approved' | 'denied') => void
  onRefreshConnector: (approval: MissionConnectorApprovalRequestDto) => void
  onResolveTask: (approval: TaskApprovalRequestDto, decision: 'approved' | 'rejected') => void
}) {
  const { t } = useTranslation()
  const missionTitles = new Map(missions.map((mission) => [mission.spec.id, mission.spec.title]))
  return (
    <section className="rounded-xl border border-amber-500/25 bg-amber-500/[0.035] p-3" aria-labelledby="mission-approval-inbox-title">
      <h2 id="mission-approval-inbox-title" className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <ShieldCheck className="size-4 text-amber-600 dark:text-amber-300" />
        {t('tasks.approvalInbox')}
        <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs tabular-nums">
          {connectorApprovals.length + taskApprovals.length}
        </span>
      </h2>
      <div className="grid gap-2 @2xl/panel:grid-cols-2">
        {connectorApprovals.map((approval) => {
          const expired = Date.parse(approval.expiresAt) <= nowMs
          const busy = busyAction === `connector-approval:${approval.approvalId}`
          return (
            <article key={approval.approvalId} className="rounded-lg border border-foreground/10 bg-background p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {missionTitles.get(approval.missionId) ?? approval.missionId}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {approval.approvalContext.provider} · {approval.approvalContext.connectorId}
                  </p>
                  <p className="mt-1 line-clamp-2 text-xs text-foreground/80">
                    {approval.approvalContext.purpose}
                  </p>
                  <p className="mt-1 truncate text-[11px] text-muted-foreground" title={approval.approvalContext.origin}>
                    {approval.operationId} · {approval.approvalContext.method} · {approval.approvalContext.origin}
                  </p>
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {approval.approvalContext.resourceClass} · {approval.risk} · {approval.approvalContext.effect}
                  </p>
                  <p className={cn('mt-1 flex items-center gap-1 text-[11px]', expired ? 'text-destructive' : 'text-muted-foreground')}>
                    <Clock3 className="size-3" /> {dateTime.format(new Date(approval.expiresAt))}
                    <span className="font-mono">· {approval.requestHash.slice(0, 12)}…</span>
                  </p>
                </div>
                <span className="shrink-0 rounded-full border border-foreground/10 px-2 py-0.5 text-[10px]">Connector</span>
              </div>
              <div className="mt-3 flex gap-2">
                {expired ? (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => onRefreshConnector(approval)}>
                    {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />} {t('common.refresh')}
                  </Button>
                ) : (
                  <>
                    <Button size="sm" disabled={busy} onClick={() => onResolveConnector(approval, 'approved')}>
                      {busy ? <Loader2 className="animate-spin" /> : <CheckCircle2 />} {t('tasks.approve')}
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => onResolveConnector(approval, 'denied')}>
                      <X /> {t('tasks.reject')}
                    </Button>
                  </>
                )}
              </div>
            </article>
          )
        })}
        {taskApprovals.map((approval) => {
          const busy = busyAction === `task-approval:${approval.requestId}`
          return (
            <article key={approval.requestId} className="rounded-lg border border-foreground/10 bg-background p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{approval.missionId} · {approval.nodeId}</p>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{approval.reason}</p>
                </div>
                <span className="shrink-0 rounded-full border border-foreground/10 px-2 py-0.5 text-[10px]">Conductor · {approval.impact}</span>
              </div>
              <div className="mt-3 flex gap-2">
                <Button size="sm" disabled={busy} onClick={() => onResolveTask(approval, 'approved')}>
                  {busy ? <Loader2 className="animate-spin" /> : <CheckCircle2 />} {t('tasks.approve')}
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => onResolveTask(approval, 'rejected')}>
                  <X /> {t('tasks.reject')}
                </Button>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}

function FilterSelect({
  value,
  onChange,
  ariaLabel,
  children,
}: {
  value: string
  onChange: (value: string) => void
  ariaLabel: string
  children: React.ReactNode
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-label={ariaLabel}
      className="h-9 rounded-md border border-foreground/10 bg-background px-3 text-sm outline-none focus:border-foreground/30"
    >
      {children}
    </select>
  )
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  hint,
  tone = 'default',
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: React.ReactNode
  hint?: string
  tone?: 'default' | 'warning' | 'danger'
}) {
  return (
    <div className={cn(
      'rounded-xl border px-3 py-3',
      tone === 'danger' ? 'border-red-500/20 bg-red-500/[0.04]'
        : tone === 'warning' ? 'border-amber-500/20 bg-amber-500/[0.04]'
          : 'border-foreground/10 bg-foreground/[0.02]',
    )}>
      <div className="flex items-center gap-2 text-muted-foreground"><Icon className="size-3.5" /><span className="text-xs">{label}</span></div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  )
}

function MissionPortfolioRow({
  mission,
  selected,
  currency,
  dateTime,
  nowMs,
  onSelect,
}: {
  mission: MissionSnapshotDto
  selected: boolean
  currency: Intl.NumberFormat
  dateTime: Intl.DateTimeFormat
  nowMs: number
  onSelect: () => void
}) {
  const { t } = useTranslation()
  const analytics = getMissionAnalytics(mission, nowMs)
  const worker = mission.spec.agentProfiles.find((profile) => profile.id === mission.spec.defaultWorkerProfileId)
  return (
    <tr
      tabIndex={0}
      role="link"
      aria-current={selected ? 'page' : undefined}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        'cursor-pointer border-t border-foreground/[0.07] outline-none transition-colors hover:bg-foreground/[0.025] focus-visible:bg-foreground/[0.04]',
        selected && 'bg-foreground/[0.045]',
      )}
    >
      <td className="max-w-[300px] px-3 py-3">
        <p className="truncate text-sm font-medium">{mission.spec.title}</p>
        <p className="mt-0.5 truncate text-muted-foreground">{mission.spec.projectId ?? mission.spec.id}</p>
      </td>
      <td className="px-3 py-3"><StatusBadge status={mission.status} /></td>
      <td className="px-3 py-3 tabular-nums">{analytics.acceptedWorkItems}/{analytics.totalWorkItems}<span className="ml-1 text-muted-foreground">· {analytics.activeWorkItems} {t('missionControl.activeShort', { count: analytics.activeWorkItems })}</span></td>
      <td className="px-3 py-3"><SignalBadge signal={analytics.freshness === 'settled' ? 'healthy' : analytics.freshness} labelKey={`missionControl.freshness.${analytics.freshness}`} /></td>
      <td className="px-3 py-3 tabular-nums">{analytics.hasTrackedCost ? currency.format(analytics.costUsd) : t('tasks.costUntracked')}</td>
      <td className="px-3 py-3 tabular-nums">{analytics.blockerCount || '—'}</td>
      <td className="px-3 py-3 tabular-nums">{analytics.requiredEvidence ? `${analytics.hashedEvidence}/${analytics.requiredEvidence}` : '—'}</td>
      <td className="max-w-[180px] px-3 py-3"><span className="block truncate">{worker?.specialty ?? t('common.unknown')}</span></td>
      <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">{dateTime.format(new Date(mission.updatedAt))}</td>
    </tr>
  )
}

function StatusBadge({ status }: { status: MissionSnapshotDto['status'] }) {
  const { t } = useTranslation()
  const terminal = TERMINAL_MISSION_STATUSES.has(status)
  return (
    <span className={cn(
      'inline-flex rounded-full border px-2 py-0.5 font-medium',
      status === 'failed' || status === 'blocked' ? 'border-red-500/25 bg-red-500/5 text-red-600 dark:text-red-300'
        : status === 'waiting-approval' || status === 'correcting' ? 'border-amber-500/25 bg-amber-500/5 text-amber-700 dark:text-amber-300'
          : status === 'completed' ? 'border-emerald-500/25 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300'
            : terminal ? 'border-foreground/10 text-muted-foreground' : 'border-blue-500/20 bg-blue-500/5 text-blue-700 dark:text-blue-300',
    )}>{t(`missionControl.status.${status}`)}</span>
  )
}

function SignalBadge({ signal, labelKey }: { signal: MissionRisk; labelKey: string }) {
  const { t } = useTranslation()
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium',
      signal === 'breach' ? 'border-red-500/25 bg-red-500/5 text-red-600 dark:text-red-300'
        : signal === 'watch' ? 'border-amber-500/25 bg-amber-500/5 text-amber-700 dark:text-amber-300'
          : 'border-emerald-500/20 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300',
    )}>
      {signal === 'breach' ? <AlertTriangle className="size-3" /> : <CheckCircle2 className="size-3" />}
      {t(labelKey)}
    </span>
  )
}

function MissionDetail({
  mission,
  workspaceId,
  busyAction,
  currency,
  dateTime,
  nowMs,
  onControl,
  onReplanned,
  onClose,
  onOpenOrigin,
}: {
  mission: MissionSnapshotDto
  workspaceId: string
  busyAction: string | null
  currency: Intl.NumberFormat
  dateTime: Intl.DateTimeFormat
  nowMs: number
  onControl: (mission: MissionSnapshotDto, action: 'pause' | 'resume' | 'cancel') => void
  onReplanned: (snapshot: MissionSnapshotDto) => void
  onClose: () => void
  onOpenOrigin?: () => void
}) {
  const { t } = useTranslation()
  const [passport, setPassport] = React.useState<MissionProofPassportDto | null>(null)
  const [passportLoading, setPassportLoading] = React.useState(false)
  const [verification, setVerification] = React.useState<MissionProofPassportVerificationDto | null>(null)
  const [passportError, setPassportError] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState(false)
  const [trustAnchor, setTrustAnchor] = React.useState<MissionProofPassportTrustAnchorDto | null>(null)
  const [trustAnchorLoading, setTrustAnchorLoading] = React.useState(false)
  const [trustAnchorError, setTrustAnchorError] = React.useState<string | null>(null)
  const [copiedTrustAnchor, setCopiedTrustAnchor] = React.useState<MissionTrustAnchorCopyFormat | null>(null)
  const passportVerificationSequence = React.useRef(0)
  const passportRequestIdentityRef = React.useRef({
    workspaceId,
    missionId: mission.spec.id,
    revision: mission.revision,
  })
  passportRequestIdentityRef.current = {
    workspaceId,
    missionId: mission.spec.id,
    revision: mission.revision,
  }
  const analytics = getMissionAnalytics(mission, nowMs)
  const profiles = new Map(mission.spec.agentProfiles.map((profile) => [profile.id, profile]))
  const isBusy = busyAction?.endsWith(`:${mission.spec.id}`) ?? false

  React.useEffect(() => {
    let stale = false
    setPassport(null)
    setVerification(null)
    setPassportError(null)
    setCopied(false)
    setPassportLoading(false)
    if (!workspaceId || mission.status !== 'completed') return
    setPassportLoading(true)
    window.electronAPI.getMissionProofPassport(workspaceId, mission.spec.id)
      .then((result) => { if (!stale) setPassport(result) })
      .catch((cause) => { if (!stale) setPassportError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { if (!stale) setPassportLoading(false) })
    return () => { stale = true }
  }, [workspaceId, mission.spec.id, mission.revision, mission.status])

  React.useEffect(() => {
    let stale = false
    setTrustAnchor(null)
    setTrustAnchorError(null)
    setCopiedTrustAnchor(null)
    if (!workspaceId || mission.status !== 'completed') return
    setTrustAnchorLoading(true)
    window.electronAPI.getMissionProofPassportTrustAnchor(workspaceId)
      .then((result) => { if (!stale) setTrustAnchor(result) })
      .catch((cause) => { if (!stale) setTrustAnchorError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { if (!stale) setTrustAnchorLoading(false) })
    return () => { stale = true }
  }, [workspaceId, mission.status])

  React.useEffect(() => {
    passportVerificationSequence.current += 1
  }, [workspaceId, mission.spec.id, mission.revision])

  React.useEffect(() => () => {
    passportVerificationSequence.current += 1
  }, [])

  const verifyPassport = React.useCallback(async () => {
    if (!workspaceId) return
    const sequence = ++passportVerificationSequence.current
    const requestIdentity = {
      workspaceId,
      missionId: mission.spec.id,
      revision: mission.revision,
    }
    const requestIsCurrent = () => isCurrentMissionPassportRequest(
      requestIdentity,
      passportRequestIdentityRef.current,
      sequence,
      passportVerificationSequence.current,
    )
    setPassportLoading(true)
    setPassportError(null)
    try {
      const result = await window.electronAPI.verifyMissionProofPassport(workspaceId, mission.spec.id)
      if (requestIsCurrent()) setVerification(result)
    } catch (cause) {
      if (requestIsCurrent()) {
        setPassportError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (requestIsCurrent()) setPassportLoading(false)
    }
  }, [mission.revision, mission.spec.id, workspaceId])

  const copyPassport = React.useCallback(async () => {
    if (!passport) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(passport, null, 2))
      setCopied(true)
      setPassportError(null)
    } catch (cause) {
      setPassportError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [passport])

  const copyTrustAnchor = React.useCallback(async (format: MissionTrustAnchorCopyFormat) => {
    if (!trustAnchor) return
    try {
      await navigator.clipboard.writeText(getMissionTrustAnchorCopyValue(trustAnchor, format))
      setCopiedTrustAnchor(format)
      setTrustAnchorError(null)
    } catch (cause) {
      setTrustAnchorError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [trustAnchor])

  return (
    <section className="rounded-xl border border-foreground/15 bg-foreground/[0.018]" aria-labelledby={`mission-${mission.spec.id}-title`}>
      <div className="flex items-start justify-between gap-4 border-b border-foreground/10 p-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={`mission-${mission.spec.id}-title`} className="text-lg font-semibold">{mission.spec.title}</h2>
            <StatusBadge status={mission.status} />
            <SignalBadge signal={analytics.risk} labelKey={`missionControl.risk.${analytics.risk}`} />
          </div>
          <p className="mt-1 max-w-4xl text-sm text-muted-foreground">{mission.spec.objective}</p>
          <p className="mt-1 text-[11px] text-muted-foreground/70">{mission.spec.id} · {dateTime.format(new Date(mission.updatedAt))}</p>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label={t('common.close')}><X /></Button>
      </div>

      <div className="space-y-5 p-4">
        <div className="grid grid-cols-2 gap-2 @3xl/panel:grid-cols-5">
          <SummaryCard icon={Workflow} label={t('tasks.progress')} value={`${analytics.acceptedWorkItems}/${analytics.totalWorkItems}`} />
          <SummaryCard icon={Clock3} label={t('missionControl.freshnessTitle')} value={<SignalBadge signal={analytics.freshness === 'settled' ? 'healthy' : analytics.freshness} labelKey={`missionControl.freshness.${analytics.freshness}`} />} />
          <SummaryCard icon={DollarSign} label={t('tasks.cost')} value={analytics.hasTrackedCost ? currency.format(analytics.costUsd) : t('tasks.costUntracked')} />
          <SummaryCard icon={FileCheck2} label={t('tasks.proof')} value={analytics.requiredEvidence ? `${analytics.hashedEvidence}/${analytics.requiredEvidence}` : '—'} />
          <SummaryCard icon={Users} label={t('missionControl.responsibilities')} value={mission.spec.agentProfiles.length} />
        </div>

        <div className="flex flex-wrap gap-2">
          {!TERMINAL_MISSION_STATUSES.has(mission.status) && (
            mission.status === 'paused' ? (
              <Button size="sm" disabled={isBusy} onClick={() => onControl(mission, 'resume')}>
                {isBusy ? <Loader2 className="animate-spin" /> : <CirclePlay />} {t('tasks.resumeMission')}
              </Button>
            ) : (
              <Button size="sm" variant="secondary" disabled={isBusy} onClick={() => onControl(mission, 'pause')}>
                {isBusy ? <Loader2 className="animate-spin" /> : <CirclePause />} {t('tasks.pauseMission')}
              </Button>
            )
          )}
          {!TERMINAL_MISSION_STATUSES.has(mission.status) && (
            <Button size="sm" variant="outline" className="text-destructive" disabled={isBusy} onClick={() => onControl(mission, 'cancel')}>
              <OctagonX /> {t('common.cancel')}
            </Button>
          )}
          {onOpenOrigin && <Button size="sm" variant="outline" onClick={onOpenOrigin}>{t('missionControl.openOrigin')}</Button>}
        </div>

        <MissionDigitalTwinPanel
          workspaceId={workspaceId}
          mission={mission}
          onReplanned={onReplanned}
        />

        <div className="grid gap-4 @3xl/panel:grid-cols-2">
          <DetailCard title={t('tasks.blockers')} icon={AlertTriangle}>
            {analytics.blockerReasons.length ? (
              <ul className="space-y-2 text-sm">
                {analytics.blockerReasons.map((reason) => <li key={reason} className="rounded-md bg-red-500/[0.04] px-2.5 py-2 text-red-700 dark:text-red-300">{reason}</li>)}
              </ul>
            ) : <p className="text-sm text-muted-foreground">{t('missionControl.noBlockers')}</p>}
          </DetailCard>
          <DetailCard title={t('missionControl.responsibilities')} icon={Users}>
            <div className="grid gap-2 sm:grid-cols-2">
              {mission.spec.agentProfiles.map((profile) => {
                const assigned = Object.values(mission.workItems).filter((item) =>
                  (item.agentProfileId ?? item.definition.agentProfileId) === profile.id).length
                return (
                  <div key={profile.id} className="rounded-md border border-foreground/10 px-2.5 py-2">
                    <p className="text-xs font-medium">{t(`missionControl.role.${profile.role}`)} · {profile.specialty}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{t('missionControl.assignedWork', { count: assigned })}</p>
                  </div>
                )
              })}
            </div>
          </DetailCard>
        </div>

        <DetailCard title={t('missionControl.workItems')} icon={Workflow}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead className="text-muted-foreground"><tr><th className="pb-2 font-medium">{t('missionControl.workItem')}</th><th className="pb-2 font-medium">{t('missionControl.statusFilter')}</th><th className="pb-2 font-medium">{t('missionControl.responsible')}</th><th className="pb-2 font-medium">{t('tasks.proof')}</th><th className="pb-2 font-medium">{t('tasks.cost')}</th></tr></thead>
              <tbody>
                {Object.values(mission.workItems).map((item) => {
                  const profile = profiles.get(item.agentProfileId ?? item.definition.agentProfileId ?? mission.spec.defaultWorkerProfileId)
                  const submitted = new Set((item.submission?.evidence ?? []).filter((evidence) => evidence.sha256).map((evidence) => evidence.requirementId))
                  const itemCost = item.attemptTelemetry.reduce((total, attempt) => total + (attempt.tokenUsage?.costUsd ?? 0), 0)
                  return (
                    <tr key={item.definition.id} className="border-t border-foreground/[0.07]">
                      <td className="max-w-[360px] py-2.5 pr-4"><span className="block truncate font-medium">{item.definition.title}</span><span className="text-muted-foreground">{t(`missionControl.itemKind.${item.definition.kind}`)}</span></td>
                      <td className="py-2.5 pr-4">{t(`missionControl.itemStatus.${item.status}`)}</td>
                      <td className="max-w-[180px] py-2.5 pr-4"><span className="block truncate">{profile?.specialty ?? t('common.unknown')}</span></td>
                      <td className="py-2.5 pr-4 tabular-nums">{item.definition.requiredEvidence.length ? `${submitted.size}/${item.definition.requiredEvidence.length}` : '—'}</td>
                      <td className="py-2.5 tabular-nums">{itemCost ? currency.format(itemCost) : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </DetailCard>

        <DetailCard title={t('missionControl.passportTitle')} icon={ShieldCheck}>
          <div className="space-y-4">
            {passportLoading && !passport ? (
              <p className="flex items-center text-sm text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" />{t('common.loading')}</p>
            ) : passportError ? (
              <p role="alert" className="text-sm text-destructive">{passportError}</p>
            ) : passport ? (
              <div className="space-y-3">
                <div className="grid gap-2 text-xs sm:grid-cols-3">
                  <PassportField label={t('missionControl.passportId')} value={passport.passportId} />
                  <PassportField label={t('missionControl.issuedAt')} value={dateTime.format(new Date(passport.issuedAt))} />
                  <PassportField label={t('tasks.proof')} value={`${passport.evidence.length} · SHA-256`} />
                </div>
                {verification && (
                  <p className={cn('flex items-center gap-1.5 text-sm', verification.valid ? 'text-emerald-600 dark:text-emerald-300' : 'text-destructive')}>
                    {verification.valid ? <ShieldCheck className="size-4" /> : <AlertTriangle className="size-4" />}
                    {verification.valid ? t('missionControl.passportValid') : t('missionControl.passportInvalid', { reason: verification.reason })}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={passportLoading} onClick={() => void verifyPassport()}>
                    {passportLoading ? <Loader2 className="animate-spin" /> : <ShieldCheck />} {t('missionControl.verifyPassport')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void copyPassport()}>{copied ? t('common.copied') : t('common.copyJson')}</Button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{mission.status === 'completed' ? t('missionControl.noPassport') : t('missionControl.passportPending')}</p>
            )}

            {mission.status === 'completed' && (
              <div className="space-y-2 border-t border-foreground/10 pt-3">
                <p className="text-xs font-medium">{t('missionControl.trustAnchorTitle')}</p>
                {trustAnchorLoading && !trustAnchor ? (
                  <p className="flex items-center text-xs text-muted-foreground"><Loader2 className="mr-2 size-3.5 animate-spin" />{t('common.loading')}</p>
                ) : trustAnchorError ? (
                  <p role="alert" className="text-xs text-destructive">{trustAnchorError}</p>
                ) : trustAnchor ? (
                  <>
                    <PassportField label={t('missionControl.trustAnchorFingerprint')} value={trustAnchor.fingerprintSha256} />
                    <p className="text-[11px] text-muted-foreground">{t('missionControl.trustAnchorDescription')}</p>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" onClick={() => void copyTrustAnchor('pem')}>
                        {copiedTrustAnchor === 'pem' ? t('common.copied') : t('missionControl.copyTrustAnchorPem')}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => void copyTrustAnchor('spki')}>
                        {copiedTrustAnchor === 'spki' ? t('common.copied') : t('missionControl.copyTrustAnchorSpki')}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => void copyTrustAnchor('fingerprint')}>
                        {copiedTrustAnchor === 'fingerprint' ? t('common.copied') : t('missionControl.copyTrustAnchorFingerprint')}
                      </Button>
                    </div>
                  </>
                ) : null}
              </div>
            )}
          </div>
        </DetailCard>
      </div>
    </section>
  )
}

function DetailCard({
  title,
  icon: Icon,
  children,
}: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
}) {
  return (
    <section className="rounded-lg border border-foreground/10 bg-background p-3">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Icon className="size-4 text-muted-foreground" />{title}</h3>
      {children}
    </section>
  )
}

function PassportField({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md bg-foreground/[0.035] px-2.5 py-2"><span className="block text-muted-foreground">{label}</span><span className="mt-0.5 block truncate font-mono">{value}</span></div>
}

export const missionControlRoomInternals = {
  PAGE_SIZE,
  upsertMission,
  getMissionAnalytics,
  filterAndSortMissions,
}
