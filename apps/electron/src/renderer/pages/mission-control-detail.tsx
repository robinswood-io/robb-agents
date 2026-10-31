import * as React from 'react';
import { AlertTriangle, CheckCircle2, CirclePause, CirclePlay, Clock3, DollarSign, FileCheck2, Loader2, OctagonX, ShieldCheck, Users, Workflow, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MissionProofPassportDto, MissionProofPassportTrustAnchorDto, MissionProofPassportVerificationDto, MissionSnapshotDto } from '@craft-agent/shared/protocol';
import { Button } from '@/components/ui/button';





import { cn } from '@/lib/utils';
import { getMissionAnalytics, getMissionTrustAnchorCopyValue, isCurrentMissionPassportRequest, TERMINAL_MISSION_STATUSES, type MissionRisk, type MissionTrustAnchorCopyFormat } from "./mission-control-model";
import { MissionDigitalTwinPanel } from "./mission-digital-twin-panel";


export function SummaryCard({
  icon: Icon,
  label,
  value,
  hint,
  tone = 'default',
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: React.ReactNode
  hint?: string | undefined
  tone?: 'default' | 'warning' | 'danger' | undefined
}) {
  return (
    <div className={cn(
      'rounded-xl border px-3 py-3',
      tone === 'danger' ? 'border-destructive/20 bg-destructive/[0.04]'
        : tone === 'warning' ? 'border-info/20 bg-info/[0.04]'
          : 'border-foreground/10 bg-foreground/[0.02]',
    )}>
      <div className="flex items-center gap-2 text-muted-foreground"><Icon className="size-3.5" /><span className="text-xs">{label}</span></div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  )
}


export function StatusBadge({ status }: { status: MissionSnapshotDto['status'] }) {
  const { t } = useTranslation()
  const terminal = TERMINAL_MISSION_STATUSES.has(status)
  return (
    <span className={cn(
      'inline-flex rounded-full border px-2 py-0.5 font-medium',
      status === 'failed' || status === 'blocked' ? 'border-destructive/25 bg-destructive/5 text-destructive'
        : status === 'waiting-approval' || status === 'correcting' ? 'border-info/25 bg-info/5 text-info'
          : status === 'completed' ? 'border-success/25 bg-success/5 text-success'
            : terminal ? 'border-foreground/10 text-muted-foreground' : 'border-accent/20 bg-accent/5 text-accent',
    )}>{t(`missionControl.status.${status}`)}</span>
  )
}


export function SignalBadge({ signal, labelKey }: { signal: MissionRisk; labelKey: string }) {
  const { t } = useTranslation()
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium',
      signal === 'breach' ? 'border-destructive/25 bg-destructive/5 text-destructive'
        : signal === 'watch' ? 'border-info/25 bg-info/5 text-info'
          : 'border-success/20 bg-success/5 text-success',
    )}>
      {signal === 'breach' ? <AlertTriangle className="size-3" /> : <CheckCircle2 className="size-3" />}
      {t(labelKey)}
    </span>
  )
}


export function MissionDetail({
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
  onOpenOrigin?: (() => void) | undefined
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
      .catch((cause: unknown) => { if (!stale) setPassportError(cause instanceof Error ? cause.message : String(cause)) })
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
      .catch((cause: unknown) => { if (!stale) setTrustAnchorError(cause instanceof Error ? cause.message : String(cause)) })
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
                {analytics.blockerReasons.map((reason) => <li key={reason} className="rounded-md bg-destructive/[0.04] px-2.5 py-2 text-destructive">{reason}</li>)}
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
                  <p className={cn('flex items-center gap-1.5 text-sm', verification.valid ? 'text-success' : 'text-destructive')}>
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


export function DetailCard({
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


export function PassportField({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md bg-foreground/[0.035] px-2.5 py-2"><span className="block text-muted-foreground">{label}</span><span className="mt-0.5 block truncate font-mono">{value}</span></div>
}
