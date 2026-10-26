import * as React from 'react';
import { AlertTriangle, DollarSign, FileCheck2, Loader2, OctagonX, RefreshCw, Search, Workflow } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { PanelHeader } from '@/components/app-shell/PanelHeader';
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton';
import { useAppShellContext } from '@/context/AppShellContext';
import { useNavigation } from '@/contexts/NavigationContext';
import { routes } from '@/lib/navigate';
import { cn } from '@/lib/utils';
import { filterAndSortMissions, getMissionAnalytics, MISSION_STATUS_VALUES, TERMINAL_MISSION_STATUSES, type MissionRiskFilter, type MissionStatusFilter } from './mission-control-model';
import "./mission-digital-twin-panel";

import { ApprovalInbox, FilterSelect, MissionPortfolioRow } from "./mission-control-portfolio";
import { SummaryCard, MissionDetail } from "./mission-control-detail";



import type { MissionConnectorApprovalRequestDto, MissionSnapshotDto, TaskApprovalRequestDto } from '@craft-agent/shared/protocol';










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

export const missionControlRoomInternals = {
  PAGE_SIZE,
  upsertMission,
  getMissionAnalytics,
  filterAndSortMissions,
}
