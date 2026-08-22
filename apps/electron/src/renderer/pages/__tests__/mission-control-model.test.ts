import { describe, expect, it } from 'bun:test'
import type { MissionSnapshotDto } from '@craft-agent/shared/protocol'
import {
  filterAndSortMissions,
  getMissionAnalytics,
  getMissionTrustAnchorCopyValue,
  isCurrentMissionPassportRequest,
} from '../mission-control-model'

const NOW = Date.parse('2026-08-20T12:00:00.000Z')

function mission(
  id: string,
  overrides: Partial<MissionSnapshotDto> = {},
): MissionSnapshotDto {
  return {
    spec: {
      id,
      title: `Mission ${id}`,
      objective: `Outcome for ${id}`,
      projectId: 'project-a',
      agentProfiles: [],
      workItems: [],
    },
    status: 'running',
    workItems: {
      [`${id}-task`]: {
        definition: {
          id: `${id}-task`,
          title: 'Deliver',
          kind: 'task',
          requiredEvidence: [{ id: 'tests', description: 'Tests pass', kind: 'test' }],
        },
        status: 'running',
        attempt: 1,
        executionHistory: [],
        externalSessionHistory: [],
        attemptTelemetry: [{
          dispatchId: 'dispatch-1',
          durationMs: 100,
          tokenUsage: {
            inputTokens: 60,
            outputTokens: 40,
            totalTokens: 100,
            contextTokens: 60,
            costUsd: 0.25,
          },
        }],
        submission: {
          summary: 'Done',
          outputRefs: [],
          evidence: [{
            requirementId: 'tests',
            uri: 'workspace://report.json',
            kind: 'test',
            sha256: 'a'.repeat(64),
          }],
        },
      },
    },
    correctionCycles: {},
    revision: 2,
    createdAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T11:55:00.000Z',
    ...overrides,
  } as MissionSnapshotDto
}

describe('Mission Control Room portfolio model', () => {
  it('selects only public trust-anchor representations for clipboard export', () => {
    const anchor = {
      schemaVersion: 1 as const,
      workspaceId: 'workspace-a',
      algorithm: 'Ed25519' as const,
      publicKeySpki: 'public-spki-base64url',
      publicKeyPem: '-----BEGIN PUBLIC KEY-----\npublic-key\n-----END PUBLIC KEY-----\n',
      fingerprintSha256: 'f'.repeat(64),
    }
    expect(getMissionTrustAnchorCopyValue(anchor, 'spki')).toBe(anchor.publicKeySpki)
    expect(getMissionTrustAnchorCopyValue(anchor, 'pem')).toBe(anchor.publicKeyPem)
    expect(getMissionTrustAnchorCopyValue(anchor, 'fingerprint')).toBe(anchor.fingerprintSha256)
    expect(Object.values(anchor).join('\n')).not.toContain('PRIVATE KEY')
  })

  it('rejects stale Passport verification responses across identity, revision and sequence changes', () => {
    const request = { workspaceId: 'workspace-a', missionId: 'mission-a', revision: 3 }

    expect(isCurrentMissionPassportRequest(request, request, 7, 7)).toBe(true)
    expect(isCurrentMissionPassportRequest(
      request, { ...request, workspaceId: 'workspace-b' }, 7, 7,
    )).toBe(false)
    expect(isCurrentMissionPassportRequest(
      request, { ...request, missionId: 'mission-b' }, 7, 7,
    )).toBe(false)
    expect(isCurrentMissionPassportRequest(
      request, { ...request, revision: 4 }, 7, 7,
    )).toBe(false)
    expect(isCurrentMissionPassportRequest(request, request, 7, 8)).toBe(false)
  })

  it('derives cost and host-verifiable evidence from attempt telemetry and submissions', () => {
    const analytics = getMissionAnalytics(mission('alpha'), NOW)
    expect(analytics.hasTrackedCost).toBe(true)
    expect(analytics.costUsd).toBe(0.25)
    expect(analytics.totalTokens).toBe(100)
    expect(analytics.requiredEvidence).toBe(1)
    expect(analytics.submittedEvidence).toBe(1)
    expect(analytics.hashedEvidence).toBe(1)
    expect(analytics.freshness).toBe('healthy')
  })

  it('marks blocked missions as breach risk and exposes journal reasons', () => {
    const blocked = mission('blocked', {
      status: 'blocked',
      statusReason: 'Connector approval is required',
    })
    const analytics = getMissionAnalytics(blocked, NOW)
    expect(analytics.risk).toBe('breach')
    expect(analytics.blockerReasons).toContain('Connector approval is required')
  })

  it('treats stale active missions as an operational freshness breach, not a terminal SLA', () => {
    const stale = mission('stale', { updatedAt: '2026-08-20T08:00:00.000Z' })
    expect(getMissionAnalytics(stale, NOW).freshness).toBe('breach')
    const completed = mission('done', {
      status: 'completed',
      updatedAt: '2026-08-01T08:00:00.000Z',
    })
    expect(getMissionAnalytics(completed, NOW).freshness).toBe('settled')
  })

  it('filters by status, risk, project and query while sorting attention first', () => {
    const healthy = mission('healthy')
    const blocked = mission('blocked', {
      status: 'blocked',
      statusReason: 'Approval needed',
      spec: { ...healthy.spec, id: 'blocked', title: 'Critical launch', projectId: 'project-b' },
    })
    const completed = mission('complete', { status: 'completed' })

    expect(filterAndSortMissions([healthy, completed, blocked], {
      query: '', status: 'active', risk: 'all', projectId: '',
    }, NOW).map((item) => item.spec.id)).toEqual(['blocked', 'healthy'])

    expect(filterAndSortMissions([healthy, completed, blocked], {
      query: 'critical', status: 'all', risk: 'breach', projectId: 'project-b',
    }, NOW).map((item) => item.spec.id)).toEqual(['blocked'])
  })
})
