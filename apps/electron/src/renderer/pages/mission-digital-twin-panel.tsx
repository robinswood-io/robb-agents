import * as React from 'react'
import { AlertTriangle, CheckCircle2, GitCompareArrows, Loader2, ShieldQuestion } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { MissionWorkItem } from '@craft-agent/shared/missions'
import type {
  MissionPreflightResult,
  MissionReplanPreviewDto,
  MissionSnapshotDto,
} from '@craft-agent/shared/protocol'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { TERMINAL_MISSION_STATUSES } from './mission-control-model'

interface MissionDigitalTwinPanelProps {
  workspaceId: string
  mission: MissionSnapshotDto
  onReplanned: (snapshot: MissionSnapshotDto) => void
}

interface MissionPanelRequestIdentity {
  workspaceId: string
  missionId: string
  revision: number
}

function requestIdentity(
  workspaceId: string,
  mission: MissionSnapshotDto,
): MissionPanelRequestIdentity {
  return { workspaceId, missionId: mission.spec.id, revision: mission.revision }
}

function requestIdentityMatches(
  left: MissionPanelRequestIdentity,
  right: MissionPanelRequestIdentity,
): boolean {
  return left.workspaceId === right.workspaceId
    && left.missionId === right.missionId
    && left.revision === right.revision
}

function missionCanReplan(mission: MissionSnapshotDto): boolean {
  if (TERMINAL_MISSION_STATUSES.has(mission.status)) return false
  return !Object.values(mission.workItems).some((item) =>
    item.status === 'reserved' || item.status === 'running')
}

function assertPreflightContract(
  result: MissionPreflightResult,
  expected: MissionPanelRequestIdentity,
): MissionPreflightResult {
  if (result.missionId !== expected.missionId
    || result.mode !== 'dry-run'
    || result.mutationMode !== 'forbidden') {
    throw new Error('Mission preflight response does not match the requested dry-run')
  }
  return result
}

function assertPreviewContract(
  result: MissionReplanPreviewDto,
  expected: MissionPanelRequestIdentity,
): MissionReplanPreviewDto {
  if (result.missionId !== expected.missionId || result.baseRevision !== expected.revision) {
    throw new Error('Mission replan preview is stale')
  }
  return result
}

function previewMatchesMission(
  preview: MissionReplanPreviewDto | null,
  previewedText: string | null,
  workItemsText: string,
  identity: MissionPanelRequestIdentity,
): preview is MissionReplanPreviewDto {
  return preview !== null
    && preview.missionId === identity.missionId
    && preview.baseRevision === identity.revision
    && previewedText === workItemsText
}

function parseProposedWorkItems(value: string): MissionWorkItem[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Invalid JSON')
  }
  if (!Array.isArray(parsed) || parsed.length < 2) {
    throw new Error('A Mission plan requires at least two work items')
  }
  const knownKinds = new Set([
    'objective',
    'task',
    'subtask',
    'integration',
    'correction',
    'objective-review',
    'final-review',
  ])
  const ids = new Set<string>()
  for (const [index, item] of parsed.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Work item ${index + 1} must be an object`)
    }
    const candidate = item as Record<string, unknown>
    if (typeof candidate.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(candidate.id)) {
      throw new Error(`Work item ${index + 1} has an invalid id`)
    }
    if (ids.has(candidate.id)) throw new Error(`Duplicate work item id "${candidate.id}"`)
    ids.add(candidate.id)
    if (typeof candidate.title !== 'string' || candidate.title.trim().length === 0) {
      throw new Error(`Work item "${candidate.id}" requires a title`)
    }
    if (typeof candidate.kind !== 'string' || !knownKinds.has(candidate.kind)) {
      throw new Error(`Work item "${candidate.id}" has an invalid kind`)
    }
    if (candidate.effect === 'external-mutation' && (
      !candidate.connectorInvocation
      || typeof candidate.connectorInvocation !== 'object'
      || Array.isArray(candidate.connectorInvocation)
    )) {
      throw new Error('External mutation work requires a structured brokered connector invocation')
    }
  }
  // The renderer only rejects obvious editing mistakes. The host remains
  // authoritative: previewMissionReplan applies MissionSpecSchema, graph,
  // lease, recovery, policy and revision checks before any journal write.
  return parsed as MissionWorkItem[]
}

function previewHasChanges(preview: MissionReplanPreviewDto): boolean {
  return preview.addedWorkItemIds.length > 0
    || preview.removedWorkItemIds.length > 0
    || preview.changedWorkItemIds.length > 0
}

export function MissionDigitalTwinPanel({
  workspaceId,
  mission,
  onReplanned,
}: MissionDigitalTwinPanelProps) {
  const { t } = useTranslation()
  const serializedWorkItems = JSON.stringify(mission.spec.workItems, null, 2)
  const [preflight, setPreflight] = React.useState<MissionPreflightResult | null>(null)
  const [preflightLoading, setPreflightLoading] = React.useState(false)
  const [editorOpen, setEditorOpen] = React.useState(false)
  const [workItemsText, setWorkItemsText] = React.useState(() => serializedWorkItems)
  const [reason, setReason] = React.useState('')
  const [preview, setPreview] = React.useState<MissionReplanPreviewDto | null>(null)
  const [previewedText, setPreviewedText] = React.useState<string | null>(null)
  const [replanLoading, setReplanLoading] = React.useState<'preview' | 'apply' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const preflightSequence = React.useRef(0)
  const replanSequence = React.useRef(0)
  const currentRequestIdentity = React.useRef(requestIdentity(workspaceId, mission))
  currentRequestIdentity.current = requestIdentity(workspaceId, mission)
  const canReplan = missionCanReplan(mission)
  const editorId = `mission-${mission.spec.id}-replan-editor`

  React.useEffect(() => {
    preflightSequence.current += 1
    replanSequence.current += 1
    setPreflight(null)
    setPreflightLoading(false)
    setEditorOpen(false)
    setWorkItemsText(serializedWorkItems)
    setReason('')
    setPreview(null)
    setPreviewedText(null)
    setReplanLoading(null)
    setError(null)
  }, [mission.spec.id, mission.revision, mission.status, serializedWorkItems, workspaceId])

  React.useEffect(() => () => {
    preflightSequence.current += 1
    replanSequence.current += 1
  }, [])

  const runPreflight = React.useCallback(async () => {
    if (!workspaceId) return
    const requestedIdentity = requestIdentity(workspaceId, mission)
    const sequence = ++preflightSequence.current
    setPreflightLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.preflightMission(workspaceId, {
        missionId: mission.spec.id,
      })
      if (sequence !== preflightSequence.current
        || !requestIdentityMatches(currentRequestIdentity.current, requestedIdentity)) return
      setPreflight(assertPreflightContract(result, requestedIdentity))
    } catch (cause) {
      if (sequence !== preflightSequence.current
        || !requestIdentityMatches(currentRequestIdentity.current, requestedIdentity)) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (sequence === preflightSequence.current
        && requestIdentityMatches(currentRequestIdentity.current, requestedIdentity)) {
        setPreflightLoading(false)
      }
    }
  }, [mission, workspaceId])

  const previewReplan = React.useCallback(async () => {
    if (!workspaceId) return
    const requestedIdentity = requestIdentity(workspaceId, mission)
    const requestedText = workItemsText
    const sequence = ++replanSequence.current
    setReplanLoading('preview')
    setError(null)
    try {
      const proposedWorkItems = parseProposedWorkItems(requestedText)
      const nextPreview = await window.electronAPI.previewMissionReplan(workspaceId, {
        missionId: mission.spec.id,
        expectedRevision: mission.revision,
        proposedWorkItems,
      })
      if (sequence !== replanSequence.current
        || !requestIdentityMatches(currentRequestIdentity.current, requestedIdentity)) return
      setPreview(assertPreviewContract(nextPreview, requestedIdentity))
      setPreviewedText(requestedText)
    } catch (cause) {
      if (sequence !== replanSequence.current
        || !requestIdentityMatches(currentRequestIdentity.current, requestedIdentity)) return
      setPreview(null)
      setPreviewedText(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (sequence === replanSequence.current
        && requestIdentityMatches(currentRequestIdentity.current, requestedIdentity)) {
        setReplanLoading(null)
      }
    }
  }, [mission, workItemsText, workspaceId])

  const applyReplan = React.useCallback(async () => {
    const requestedIdentity = requestIdentity(workspaceId, mission)
    if (!workspaceId
      || !canReplan
      || !previewMatchesMission(preview, previewedText, workItemsText, requestedIdentity)
      || !previewHasChanges(preview)
      || !reason.trim()) return
    if (!window.confirm(t('missionControl.replanConfirm', { title: mission.spec.title }))) return
    const sequence = ++replanSequence.current
    setReplanLoading('apply')
    setError(null)
    try {
      const snapshot = await window.electronAPI.replanMission(workspaceId, {
        missionId: mission.spec.id,
        expectedRevision: mission.revision,
        proposedWorkItems: parseProposedWorkItems(workItemsText),
        reason: reason.trim(),
      })
      if (sequence !== replanSequence.current
        || !requestIdentityMatches(currentRequestIdentity.current, requestedIdentity)) return
      if (snapshot.spec.id !== requestedIdentity.missionId
        || snapshot.revision <= requestedIdentity.revision) {
        throw new Error('Mission replan response does not advance the requested Mission revision')
      }
      onReplanned(snapshot)
    } catch (cause) {
      if (sequence !== replanSequence.current
        || !requestIdentityMatches(currentRequestIdentity.current, requestedIdentity)) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (sequence === replanSequence.current
        && requestIdentityMatches(currentRequestIdentity.current, requestedIdentity)) {
        setReplanLoading(null)
      }
    }
  }, [canReplan, mission, onReplanned, preview, previewedText, reason, t, workItemsText, workspaceId])

  const previewIsCurrent = canReplan && previewMatchesMission(
    preview,
    previewedText,
    workItemsText,
    currentRequestIdentity.current,
  )
  const previewHasMaterialChanges = previewIsCurrent
    && preview !== null
    && previewHasChanges(preview)

  return (
    <section className="rounded-lg border border-foreground/10 bg-background p-3" aria-labelledby={`mission-${mission.spec.id}-twin-title`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id={`mission-${mission.spec.id}-twin-title`} className="flex items-center gap-2 text-sm font-semibold">
            <ShieldQuestion className="size-4 text-muted-foreground" />
            {t('missionControl.digitalTwinTitle')}
          </h3>
          <p className="mt-1 max-w-3xl text-xs text-muted-foreground">{t('missionControl.digitalTwinDesc')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!workspaceId || preflightLoading}
            aria-busy={preflightLoading}
            onClick={() => void runPreflight()}
          >
            {preflightLoading ? <Loader2 className="animate-spin" /> : <ShieldQuestion />}
            {t('missionControl.preflightRun')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={replanLoading === 'apply'}
            aria-expanded={editorOpen}
            aria-controls={editorId}
            onClick={() => setEditorOpen((open) => !open)}
          >
            <GitCompareArrows /> {t('missionControl.replanEdit')}
          </Button>
        </div>
      </div>

      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}

      {preflight && (
        <div
          className="mt-3 space-y-3 rounded-md bg-foreground/[0.03] p-3 text-xs"
          role="status"
          aria-live="polite"
        >
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className={preflight.readyToStart ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}>
              <strong>{preflight.readyToStart ? t('missionControl.preflightReady') : t('missionControl.preflightNotReady')}</strong>
            </span>
            <span>{t('missionControl.preflightMutations', { count: preflight.projectedExternalMutations })}</span>
            <span>{preflight.projectedCostUsd === undefined
              ? t('missionControl.preflightCostUnknown')
              : t('missionControl.preflightCost', { cost: preflight.projectedCostUsd.toFixed(4) })}</span>
            <span className="text-muted-foreground">{t('missionControl.preflightNoMutation')}</span>
          </div>
          <ul className="grid gap-1 @2xl/panel:grid-cols-2">
            {preflight.gates.map((gate) => (
              <li
                key={gate.id}
                className={cn(
                  'flex items-start gap-2 rounded px-2 py-1.5',
                  gate.status === 'fail' && 'bg-red-500/[0.04] text-red-700 dark:text-red-300',
                  gate.status === 'unknown' && 'bg-amber-500/[0.04] text-amber-700 dark:text-amber-300',
                )}
              >
                {gate.status === 'pass'
                  ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
                  : <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />}
                <span><strong>{gate.category}</strong> · {gate.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {editorOpen && (
        <div id={editorId} className="mt-3 space-y-3 border-t border-foreground/10 pt-3">
          <p className="text-xs text-muted-foreground">{t('missionControl.replanDesc')}</p>
          <textarea
            value={workItemsText}
            onChange={(event) => {
              replanSequence.current += 1
              setWorkItemsText(event.target.value)
              setPreview(null)
              setPreviewedText(null)
              setReplanLoading(null)
            }}
            disabled={replanLoading === 'apply'}
            spellCheck={false}
            aria-label={t('missionControl.replanWorkItems')}
            className="min-h-72 w-full resize-y rounded-lg bg-foreground-2 px-3 py-2 font-mono text-xs text-foreground outline-none shadow-minimal focus:bg-background focus:ring-2 focus:ring-ring"
          />
          <label className="block space-y-1">
            <span className="text-xs font-medium">{t('missionControl.replanReason')}</span>
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={replanLoading === 'apply'}
              className="h-9 w-full rounded-md border border-foreground/10 bg-background px-3 text-sm outline-none focus:border-foreground/30"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={replanLoading !== null}
              aria-busy={replanLoading === 'preview'}
              onClick={() => void previewReplan()}
            >
              {replanLoading === 'preview' ? <Loader2 className="animate-spin" /> : <GitCompareArrows />}
              {t('missionControl.replanPreview')}
            </Button>
            <Button
              size="sm"
              disabled={!previewHasMaterialChanges || !reason.trim() || replanLoading !== null}
              aria-busy={replanLoading === 'apply'}
              onClick={() => void applyReplan()}
            >
              {replanLoading === 'apply' && <Loader2 className="animate-spin" />}
              {t('missionControl.replanApply')}
            </Button>
          </div>
          {previewIsCurrent && (
            <div
              className="grid gap-2 text-xs sm:grid-cols-2 @4xl/panel:grid-cols-5"
              role="status"
              aria-live="polite"
            >
              <DiffList label={t('missionControl.replanAdded')} values={preview.addedWorkItemIds} />
              <DiffList label={t('missionControl.replanRemoved')} values={preview.removedWorkItemIds} />
              <DiffList label={t('missionControl.replanChanged')} values={preview.changedWorkItemIds} />
              <DiffList label={t('missionControl.replanInvalidated')} values={preview.invalidatedWorkItemIds} />
              <DiffList label={t('missionControl.replanPreserved')} values={preview.preservedAcceptedWorkItemIds} />
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function DiffList({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="rounded-md bg-foreground/[0.035] px-2.5 py-2">
      <strong>{label}</strong>
      <p className="mt-1 break-words font-mono text-muted-foreground">{values.length > 0 ? values.join(', ') : '—'}</p>
    </div>
  )
}

export const missionDigitalTwinPanelInternals = {
  parseProposedWorkItems,
  previewHasChanges,
  requestIdentityMatches,
  missionCanReplan,
  assertPreflightContract,
  assertPreviewContract,
  previewMatchesMission,
}
