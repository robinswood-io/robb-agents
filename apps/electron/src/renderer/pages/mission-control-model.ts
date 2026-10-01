import type {
  MissionProofPassportTrustAnchorDto,
  MissionSnapshotDto,
} from '@craft-agent/shared/protocol'

export type MissionStatus = MissionSnapshotDto['status']
export type MissionRisk = 'healthy' | 'watch' | 'breach'
export type MissionFreshness = MissionRisk | 'settled'
export type MissionStatusFilter = 'all' | 'active' | 'terminal' | MissionStatus
export type MissionRiskFilter = 'all' | MissionRisk
export type MissionTrustAnchorCopyFormat = 'fingerprint' | 'pem' | 'spki'

export interface MissionPassportRequestIdentity {
  workspaceId: string
  missionId: string
  revision: number
}

export const MISSION_STATUS_VALUES: readonly MissionStatus[] = [
  'draft',
  'running',
  'correcting',
  'objective-review',
  'final-review',
  'paused',
  'blocked',
  'waiting-approval',
  'completed',
  'failed',
  'cancelled',
]

export const TERMINAL_MISSION_STATUSES = new Set<MissionStatus>([
  'completed',
  'failed',
  'cancelled',
])

const ACTIVE_FRESHNESS_WATCH_MS = 30 * 60 * 1_000
const ACTIVE_FRESHNESS_BREACH_MS = 2 * 60 * 60 * 1_000

/** Keep clipboard format selection pure and covered independently of the DOM. */
export function getMissionTrustAnchorCopyValue(
  trustAnchor: MissionProofPassportTrustAnchorDto,
  format: MissionTrustAnchorCopyFormat,
): string {
  if (format === 'fingerprint') return trustAnchor.fingerprintSha256
  if (format === 'pem') return trustAnchor.publicKeyPem
  return trustAnchor.publicKeySpki
}

/** Keep late Passport verification responses bound to the exact rendered Mission revision. */
export function isCurrentMissionPassportRequest(
  request: MissionPassportRequestIdentity,
  current: MissionPassportRequestIdentity,
  requestSequence: number,
  currentSequence: number,
): boolean {
  return requestSequence === currentSequence
    && request.workspaceId === current.workspaceId
    && request.missionId === current.missionId
    && request.revision === current.revision
}

export interface MissionAnalytics {
  totalWorkItems: number
  acceptedWorkItems: number
  activeWorkItems: number
  blockedWorkItems: number
  blockerCount: number
  rejectedWorkItems: number
  requiredEvidence: number
  submittedEvidence: number
  hashedEvidence: number
  costUsd: number
  hasTrackedCost: boolean
  totalTokens: number
  freshness: MissionFreshness
  risk: MissionRisk
  blockerReasons: string[]
}

function maxRisk(left: MissionRisk, right: MissionRisk): MissionRisk {
  const rank: Record<MissionRisk, number> = { healthy: 0, watch: 1, breach: 2 }
  return rank[left] >= rank[right] ? left : right
}

/**
 * Derive portfolio indicators exclusively from the journal-backed mission
 * snapshot. Freshness thresholds are operational signals, not contractual SLAs.
 */
export function getMissionAnalytics(
  mission: MissionSnapshotDto,
  nowMs = Date.now(),
): MissionAnalytics {
  const items = Object.values(mission.workItems)
  let costUsd = 0
  let totalTokens = 0
  let hasTrackedCost = false
  let requiredEvidence = 0
  let submittedEvidence = 0
  let hashedEvidence = 0
  const blockerReasons = new Set<string>()

  for (const item of items) {
    const submittedByRequirement = new Map(
      (item.submission?.evidence ?? []).map((evidence) => [evidence.requirementId, evidence]),
    )
    for (const requirement of item.definition.requiredEvidence) {
      requiredEvidence += 1
      const evidence = submittedByRequirement.get(requirement.id)
      if (evidence) submittedEvidence += 1
      if (evidence?.sha256) hashedEvidence += 1
    }
    for (const attempt of item.attemptTelemetry) {
      if (!attempt.tokenUsage) continue
      hasTrackedCost = true
      costUsd += attempt.tokenUsage.costUsd
      totalTokens += attempt.tokenUsage.totalTokens
    }
    if (item.status === 'blocked' && item.statusReason) blockerReasons.add(item.statusReason)
  }
  if ((mission.status === 'blocked' || mission.status === 'waiting-approval') && mission.statusReason) {
    blockerReasons.add(mission.statusReason)
  }

  const terminal = TERMINAL_MISSION_STATUSES.has(mission.status)
  const ageMs = Math.max(0, nowMs - Date.parse(mission.updatedAt))
  const freshness: MissionFreshness = terminal
    ? 'settled'
    : ageMs >= ACTIVE_FRESHNESS_BREACH_MS
      ? 'breach'
      : ageMs >= ACTIVE_FRESHNESS_WATCH_MS
        ? 'watch'
        : 'healthy'

  const blockedWorkItems = items.filter((item) => item.status === 'blocked').length
  const rejectedWorkItems = items.filter((item) => item.status === 'rejected').length
  let risk: MissionRisk = freshness === 'settled' ? 'healthy' : freshness
  if (mission.status === 'blocked' || mission.status === 'waiting-approval' || mission.status === 'failed') {
    risk = 'breach'
  } else if (
    mission.status === 'correcting'
    || mission.status === 'objective-review'
    || mission.status === 'final-review'
    || rejectedWorkItems > 0
  ) {
    risk = maxRisk(risk, 'watch')
  }
  if (blockedWorkItems > 0) risk = 'breach'

  return {
    totalWorkItems: items.length,
    acceptedWorkItems: items.filter((item) => item.status === 'accepted').length,
    activeWorkItems: items.filter((item) =>
      ['reserved', 'running', 'submitted', 'verifying'].includes(item.status)).length,
    blockedWorkItems,
    blockerCount: Math.max(blockedWorkItems, blockerReasons.size),
    rejectedWorkItems,
    requiredEvidence,
    submittedEvidence,
    hashedEvidence,
    costUsd,
    hasTrackedCost,
    totalTokens,
    freshness,
    risk,
    blockerReasons: [...blockerReasons],
  }
}

export interface MissionPortfolioFilter {
  query: string
  status: MissionStatusFilter
  risk: MissionRiskFilter
  projectId: string
}

export function filterAndSortMissions(
  missions: readonly MissionSnapshotDto[],
  filter: MissionPortfolioFilter,
  nowMs = Date.now(),
): MissionSnapshotDto[] {
  const query = filter.query.trim().toLocaleLowerCase()
  const riskRank: Record<MissionRisk, number> = { breach: 0, watch: 1, healthy: 2 }

  return missions
    .map((mission) => ({ mission, analytics: getMissionAnalytics(mission, nowMs) }))
    .filter(({ mission, analytics }) => {
      if (filter.status === 'active' && TERMINAL_MISSION_STATUSES.has(mission.status)) return false
      if (filter.status === 'terminal' && !TERMINAL_MISSION_STATUSES.has(mission.status)) return false
      if (!['all', 'active', 'terminal'].includes(filter.status) && mission.status !== filter.status) return false
      if (filter.projectId && mission.spec.projectId !== filter.projectId) return false
      if (filter.risk !== 'all' && analytics.risk !== filter.risk) return false
      if (!query) return true
      return [
        mission.spec.id,
        mission.spec.title,
        mission.spec.objective,
        mission.spec.projectId,
        mission.status,
        mission.statusReason,
      ].some((value) => value?.toLocaleLowerCase().includes(query))
    })
    .sort((left, right) => {
      const riskDelta = riskRank[left.analytics.risk] - riskRank[right.analytics.risk]
      if (riskDelta !== 0) return riskDelta
      const terminalDelta = Number(TERMINAL_MISSION_STATUSES.has(left.mission.status))
        - Number(TERMINAL_MISSION_STATUSES.has(right.mission.status))
      if (terminalDelta !== 0) return terminalDelta
      return right.mission.updatedAt.localeCompare(left.mission.updatedAt)
    })
    .map(({ mission }) => mission)
}
