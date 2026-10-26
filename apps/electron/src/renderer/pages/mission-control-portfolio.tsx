import { StatusBadge, SignalBadge } from "./mission-control-detail";
import * as React from 'react';
import { CheckCircle2, Clock3, Loader2, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MissionConnectorApprovalRequestDto, MissionSnapshotDto, TaskApprovalRequestDto } from '@craft-agent/shared/protocol';
import { Button } from '@/components/ui/button';





import { cn } from '@/lib/utils';
import { getMissionAnalytics } from "./mission-control-model";


export function ApprovalInbox({
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
    <section className="rounded-xl border border-info/25 bg-info/[0.035] p-3" aria-labelledby="mission-approval-inbox-title">
      <h2 id="mission-approval-inbox-title" className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <ShieldCheck className="size-4 text-info" />
        {t('tasks.approvalInbox')}
        <span className="rounded-full bg-info/10 px-2 py-0.5 text-xs tabular-nums">
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


export function FilterSelect({
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


export function MissionPortfolioRow({
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
