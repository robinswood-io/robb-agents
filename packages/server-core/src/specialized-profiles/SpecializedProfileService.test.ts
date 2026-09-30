import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MissionSnapshot } from '@craft-agent/shared/missions'
import {
  type SpecializedProfileRegistryAnchor,
  type SpecializedProfileRegistryAnchorStore,
  type SpecializedProfileRegistryDocument,
  canonicalSpecializedProfileVersionHash,
  SpecializedProfileRegistryStore,
} from '@craft-agent/shared/specialized-profiles'
import {
  SpecializedProfileService,
  missionCorpusFingerprint,
  type SpecializedProfileCorpusLineageProvider,
} from './SpecializedProfileService.ts'

const temporaryRoots: string[] = []
const ROUTE_HASH = 'e'.repeat(64)

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function mission(index: number): MissionSnapshot {
  const missionId = `accounting-${index}`
  const objectiveId = `objective-${index}`
  const taskId = `task-${index}`
  const objective = {
    id: objectiveId,
    kind: 'objective' as const,
    title: `Close period ${index}`,
    dependsOn: [],
    acceptanceCriteria: [{ id: `objective-ok-${index}`, description: 'Period is reconciled.' }],
    requiredEvidence: [],
    effect: 'read' as const,
  }
  const task = {
    id: taskId,
    kind: 'task' as const,
    title: `Review ledger ${index}`,
    prompt: 'Review the bounded ledger sample.',
    parentId: objectiveId,
    objectiveId,
    dependsOn: [],
    acceptanceCriteria: [{ id: `task-ok-${index}`, description: 'Every variance is classified.' }],
    requiredEvidence: [{ id: `ledger-${index}`, description: 'Redacted ledger proof.', kind: 'artifact' as const }],
    agentProfileId: 'worker',
    effect: 'read' as const,
  }
  const profiles = [
    {
      id: 'planner', role: 'planner' as const, specialty: 'general', systemPrompt: 'Plan.',
      tools: [], sources: [], skills: [], permissionMode: 'safe' as const, modelTier: 'balanced' as const,
    },
    {
      id: 'worker', role: 'worker' as const, specialty: 'bounded-accounting', systemPrompt: 'Review.',
      tools: ['ledger.read'], sources: ['ledger'], skills: ['accounting-review'],
      permissionMode: 'safe' as const, modelTier: 'balanced' as const,
    },
    {
      id: 'unused-worker', role: 'worker' as const, specialty: 'unrelated', systemPrompt: 'Unused.',
      tools: ['unrelated.write'], sources: ['unrelated'], skills: ['unrelated-mutation'],
      permissionMode: 'allow-all' as const, modelTier: 'balanced' as const,
    },
    {
      id: 'reviewer', role: 'reviewer' as const, specialty: 'review', systemPrompt: 'Review.',
      tools: [], sources: [], skills: [], permissionMode: 'safe' as const, modelTier: 'balanced' as const,
    },
    {
      id: 'supervisor', role: 'supervisor' as const, specialty: 'supervision', systemPrompt: 'Supervise.',
      tools: [], sources: [], skills: [], permissionMode: 'safe' as const, modelTier: 'balanced' as const,
    },
  ]
  return {
    spec: {
      schemaVersion: 2,
      id: missionId,
      title: `Accounting close ${index}`,
      objective: `Reconcile distinct accounting period ${index}.`,
      acceptanceCriteria: [{ id: `mission-ok-${index}`, description: 'Period accepted.' }],
      plannerProfileId: 'planner',
      defaultWorkerProfileId: 'worker',
      reviewerProfileId: 'reviewer',
      supervisorProfileId: 'supervisor',
      agentProfiles: profiles,
      policy: {
        maxConcurrentAgents: 2,
        maxCorrectionCycles: 2,
        maxWorkItems: 16,
        maxDepth: 4,
        maxTechnicalAttempts: 2,
        requireIndependentReview: true,
        requireIndependentSupervisor: true,
      },
      workItems: [objective, task],
    },
    status: 'completed',
    workItems: {
      [objectiveId]: {
        definition: objective,
        status: 'accepted',
        attempt: 0,
        executionHistory: [],
        externalSessionHistory: [],
        attemptTelemetry: [],
      },
      [taskId]: {
        definition: task,
        status: 'accepted',
        attempt: 1,
        executionHistory: [],
        externalSessionHistory: [],
        attemptTelemetry: [],
      },
    },
    correctionCycles: {},
    planVersion: 1,
    replans: [],
    revision: 3,
    createdAt: `2026-08-${String(index).padStart(2, '0')}T09:00:00.000Z`,
    updatedAt: `2026-08-${String(index).padStart(2, '0')}T10:00:00.000Z`,
  }
}

function evaluationMission(
  index: number,
  batch: 'offline' | 'shadow',
  createdAt: string,
  updatedAt: string,
  registry: SpecializedProfileRegistryDocument,
  cohortId: string,
): MissionSnapshot {
  const snapshot = structuredClone(mission((index % 8) + 1))
  const missionId = `evaluation-${batch}-${index}`
  const task = snapshot.spec.workItems.find((item) => item.kind === 'task')!
  const taskRuntime = snapshot.workItems[task.id]!
  snapshot.spec.title = `Held-out accounting ${batch} case ${index}`
  snapshot.spec.objective = `Reconcile held-out ${batch} accounting scenario ${index}.`
  task.title = `Review held-out ledger ${batch} ${index}`
  task.prompt = `Analyze the held-out accounting ledger ${batch} ${index}.`
  const record = registry.profiles[0]!
  const version = record.versions[record.currentVersion - 1]!
  const capabilityEnvelope = version.definition.requestedCapabilities
    .map(({ kind, name }) => ({ kind, name }))
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name))
  const capabilityEnvelopeSha256 = createHash('sha256')
    .update(JSON.stringify(capabilityEnvelope))
    .digest('hex')
  const reference = {
    schemaVersion: 1,
    profileId: record.id,
    profileVersion: record.currentVersion,
    selectedState: record.currentState,
    lifecycleEntryTransitionSequence: record.transitions.at(-1)!.sequence,
    registryRevisionAtSelection: registry.revision,
    registryHeadSha256AtSelection: registry.head.documentSha256,
    versionSha256: canonicalSpecializedProfileVersionHash(version),
    capabilityEnvelopeSha256,
    executionRouteSha256: ROUTE_HASH,
    evaluationStage: batch,
    evaluationCohortId: cohortId,
  }
  const worker = snapshot.spec.agentProfiles.find(({ id }) => id === 'worker')!
  worker.id = record.id
  worker.role = version.definition.role
  worker.specialty = version.definition.specialty
  worker.systemPrompt = `<robb-specialized-profile-binding>${JSON.stringify(reference)}</robb-specialized-profile-binding>\n${version.definition.systemPrompt}`
  worker.skills = capabilityEnvelope.filter(({ kind }) => kind === 'skill').map(({ name }) => name)
  worker.tools = capabilityEnvelope.filter(({ kind }) => kind === 'tool').map(({ name }) => name)
  worker.sources = capabilityEnvelope.filter(({ kind }) => kind === 'source').map(({ name }) => name)
  snapshot.spec.defaultWorkerProfileId = record.id
  task.agentProfileId = record.id
  taskRuntime.definition.agentProfileId = record.id
  taskRuntime.agentProfileId = record.id
  taskRuntime.dispatchId = `dispatch-${batch}-${index}`
  taskRuntime.executionBinding = {
    executorKind: 'test',
    executionId: `execution-${batch}-${index}`,
    specializedProfile: {
      profileId: record.id,
      profileVersion: record.currentVersion,
      versionSha256: reference.versionSha256,
      capabilityEnvelopeSha256,
      executionRouteSha256: ROUTE_HASH,
    },
  }
  taskRuntime.executionHistory = [`execution-${batch}-${index}`]
  task.requiredEvidence = []
  taskRuntime.definition.requiredEvidence = []
  taskRuntime.submission = { summary: 'Verified bounded result.', outputRefs: [], evidence: [] }
  const finalReviewId = `final-review-${batch}-${index}`
  const finalReview = {
    id: finalReviewId,
    kind: 'final-review' as const,
    title: 'Verify the Mission result',
    dependsOn: [task.id],
    acceptanceCriteria: snapshot.spec.acceptanceCriteria,
    requiredEvidence: [],
    effect: 'read' as const,
  }
  snapshot.spec.id = missionId
  snapshot.spec.workItems.push(finalReview)
  snapshot.workItems[finalReviewId] = {
    definition: finalReview,
    status: 'accepted',
    attempt: 1,
    executionHistory: [],
    externalSessionHistory: [],
    attemptTelemetry: [],
    verdict: {
      targetType: 'mission',
      targetId: missionId,
      result: 'pass',
      summary: 'All criteria passed.',
      criteria: snapshot.spec.acceptanceCriteria.map((criterion) => ({
        criterionId: criterion.id,
        result: 'pass' as const,
        evidenceRefs: [`mission://${missionId}`],
        explanation: 'Verified by the persisted Mission final review.',
      })),
      affectedWorkItemIds: [],
      corrections: [],
    },
  }
  snapshot.createdAt = createdAt
  snapshot.updatedAt = updatedAt
  return snapshot
}

function setup(options: {
  corpusLineageProvider?: SpecializedProfileCorpusLineageProvider | null
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'robb-specialized-profile-service-'))
  temporaryRoots.push(root)
  const stale = mission(9)
  stale.createdAt = '2025-01-01T09:00:00.000Z'
  stale.updatedAt = '2025-01-01T10:00:00.000Z'
  const missions = [...Array.from({ length: 8 }, (_, index) => mission(index + 1)), stale]
  const anchors = new Map<string, SpecializedProfileRegistryAnchor>()
  const anchorStore: SpecializedProfileRegistryAnchorStore = {
    load: async (workspaceId) => structuredClone(anchors.get(workspaceId) ?? null),
    save: async (workspaceId, anchor) => { anchors.set(workspaceId, structuredClone(anchor)) },
  }
  let clock = new Date('2026-09-17T08:00:00.000Z')
  return {
    root,
    missions,
    setNow: (value: string) => { clock = new Date(value) },
    service: new SpecializedProfileService({
      resolveWorkspace: (workspaceId) => workspaceId === 'workspace-1'
        ? { id: workspaceId, rootPath: root }
        : null,
      listMissions: async () => missions,
      now: () => new Date(clock),
      loadAuthorityKey: async () => Buffer.alloc(32, 7),
      anchorStore,
      humanApprovalProvider: {
        consume: async ({ challengeId }) => ({
          reviewerActorId: 'human-reviewer',
          assurance: 'webauthn',
          verifierId: 'test-authenticator',
          eventId: `event-${challengeId}`,
          authenticatedAt: '2026-09-17T11:55:00.000Z',
          expiresAt: '2026-09-18T12:00:00.000Z',
          evidence: [{ uri: `authentication://${challengeId}`, sha256: 'f'.repeat(64) }],
        }),
      },
      missionEvidenceProvider: {
        loadVerified: async ({ missionId }) => {
          const snapshot = missions.find(({ spec }) => spec.id === missionId)
          if (!snapshot) throw new Error(`Missing test Mission ${missionId}`)
          return {
            snapshot: structuredClone(snapshot),
            evidence: {
              uri: `proof-passport://workspace-1/${missionId}/test-passport`,
              sha256: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
            },
          }
        },
      },
      ...(options.corpusLineageProvider === null ? {} : {
        corpusLineageProvider: options.corpusLineageProvider ?? {
          attestHeldOut: async (input) => ({
            schemaVersion: 1,
            providerId: 'test-corpus-authority',
            attestationId: `attestation-${input.campaignId}`,
            corpusId: `corpus-${input.campaignId}`,
            lineageId: `lineage-${input.campaignId}`,
            partitionVersion: 'test-partition-v1',
            reservedAt: '2026-08-01T00:00:00.000Z',
            manifestSha256: input.manifestSha256,
            provenanceSha256: input.provenanceSha256,
            disjointFromProvenance: true,
            evidence: {
              uri: `corpus-lineage://workspace-1/${input.campaignId}/test-attestation`,
              sha256: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
            },
          }),
        },
      }),
    }),
  }
}

describe('SpecializedProfileService', () => {
  it('canonicalizes punctuation and work-item ordering only for immutable case reservation', () => {
    const original = mission(1)
    const clone = structuredClone(original)
    clone.spec.title = `${clone.spec.title}...!!!`
    clone.spec.objective = ` ${clone.spec.objective} `
    clone.spec.workItems.reverse()
    expect(missionCorpusFingerprint(clone)).toBe(missionCorpusFingerprint(original))
  })

  it('detects a recurring bounded family and materializes only an inactive draft', async () => {
    const { service } = setup()
    const empty = await service.getRegistry('workspace-1', 'local-owner')
    expect(empty.revision).toBe(0)

    const analysis = await service.analyze('workspace-1')
    const proposal = analysis.report.proposals.find((entry) => entry.category === 'agent-profile')
    expect(proposal?.normalizedFamily).toBe('bounded-accounting')
    expect(analysis.analyzedMissionIds).toHaveLength(8)
    expect(analysis.excludedMissionCount).toBe(1)

    const result = await service.createDraft('workspace-1', 'local-owner', {
      proposalId: proposal!.proposalId,
      expectedRegistryRevision: 0,
    })
    const profile = result.registry.profiles[0]!
    expect(result.registry.revision).toBe(1)
    expect(profile.currentState).toBe('draft')
    expect(profile.transitions.map(({ to }) => to)).toEqual(['candidate', 'draft'])
    expect(profile.versions[0]!.definition.specialty).toBe('bounded-accounting')
    expect(profile.versions[0]!.definition.requestedCapabilities.map((entry) => entry.kind)).toEqual([
      'skill',
      'source',
      'workspace-read',
    ])
    expect(profile.versions[0]!.definition).not.toHaveProperty('model')
    expect(profile.versions[0]!.definition).not.toHaveProperty('permissionMode')
  })

  it('rechecks freshness on the authenticated terminal prefix, not later report activity', async () => {
    const { service, missions } = setup()
    const recentJournal = missions[0]!
    recentJournal.updatedAt = '2026-09-17T07:30:00.000Z'
    const staleTerminal = structuredClone(recentJournal)
    staleTerminal.updatedAt = '2025-01-01T10:00:00.000Z'
    const internal = service as unknown as {
      options: {
        missionEvidenceProvider: {
          loadVerified(input: { missionId: string }): Promise<{
            snapshot: MissionSnapshot
            evidence: { uri: string; sha256: string }
          }>
        }
      }
    }
    const original = internal.options.missionEvidenceProvider
    internal.options.missionEvidenceProvider = {
      loadVerified: async ({ missionId }) => {
        const snapshot = missionId === recentJournal.spec.id
          ? staleTerminal
          : missions.find(({ spec }) => spec.id === missionId)!
        return {
          snapshot: structuredClone(snapshot),
          evidence: { uri: `proof-passport://${missionId}`, sha256: 'a'.repeat(64) },
        }
      },
    }
    try {
      const result = await service.analyze('workspace-1')
      expect(result.analyzedMissionIds).not.toContain(recentJournal.spec.id)
      expect(result.excludedMissionCount).toBeGreaterThanOrEqual(2)
    } finally {
      internal.options.missionEvidenceProvider = original
    }
  })

  it('makes draft creation idempotent and refuses shadow without a qualifying offline evaluation', async () => {
    const { service } = setup()
    const analysis = await service.analyze('workspace-1')
    const proposal = analysis.report.proposals.find((entry) => entry.category === 'agent-profile')!
    const created = await service.createDraft('workspace-1', 'local-owner', {
      proposalId: proposal.proposalId,
      expectedRegistryRevision: 0,
    })

    const replayed = await service.createDraft('workspace-1', 'local-owner', {
      proposalId: proposal.proposalId,
      expectedRegistryRevision: 0,
    })
    expect(replayed.registry).toEqual(created.registry)
    expect(replayed.registry.profiles).toHaveLength(1)

    await expect(service.transition('workspace-1', 'local-owner', {
      profileId: created.profileId,
      expectedRegistryRevision: created.registry.revision,
      expectedCurrentVersion: 1,
      to: 'shadow',
      reason: 'Attempt promotion without evidence.',
      evaluationIds: [],
    })).rejects.toThrow('requires the latest offline evaluation')
  })

  it('host-attests evaluations and approval receipts and rejects durable tampering', async () => {
    const { root, missions, service, setNow } = setup()
    const analysis = await service.analyze('workspace-1')
    const proposal = analysis.report.proposals.find((entry) => entry.category === 'agent-profile')!
    const created = await service.createDraft('workspace-1', 'local-owner', {
      proposalId: proposal.proposalId,
      expectedRegistryRevision: 0,
    })

    let offlineCampaignId = ''
    let offlineCampaignRegistry = created.registry
    for (let index = 0; index < 20; index += 1) {
      const reservation = await service.reserveEvaluationMission('workspace-1', {
        profileId: created.profileId,
        stage: 'offline',
        missionId: `evaluation-offline-${index}`,
        caseFingerprintSha256: missionCorpusFingerprint(evaluationMission(
          index,
          'offline',
          '2026-09-17T09:00:00.000Z',
          '2026-09-17T09:30:00.000Z',
          offlineCampaignRegistry,
          offlineCampaignId || 'pending-campaign',
        )),
      })
      offlineCampaignId = reservation.campaignId
      offlineCampaignRegistry = reservation.registry
    }
    missions.push(...Array.from({ length: 20 }, (_, index) => evaluationMission(
      index,
      'offline',
      '2026-09-17T09:00:00.000Z',
      '2026-09-17T09:30:00.000Z',
      offlineCampaignRegistry,
      offlineCampaignId,
    )))
    setNow('2026-09-17T10:00:00.000Z')
    const offlineRequest = {
      expectedRegistryRevision: offlineCampaignRegistry.revision,
      profileId: created.profileId,
      expectedCurrentVersion: 1,
      stage: 'offline' as const,
    }
    const internal = service as unknown as {
      options: { corpusLineageProvider?: SpecializedProfileCorpusLineageProvider }
    }
    const lineageProvider = internal.options.corpusLineageProvider
    delete internal.options.corpusLineageProvider
    await expect(service.recordEvaluation('workspace-1', offlineRequest))
      .rejects.toThrow('independent host corpus-lineage attestor')
    internal.options.corpusLineageProvider = lineageProvider!
    const recordAfterClose = spyOn(SpecializedProfileRegistryStore.prototype, 'recordEvaluation')
      .mockImplementationOnce(async () => {
        throw new Error('simulated crash after campaign close')
      })
    await expect(service.recordEvaluation('workspace-1', offlineRequest))
      .rejects.toThrow('simulated crash after campaign close')
    recordAfterClose.mockRestore()
    await expect(service.recordEvaluation('workspace-1', {
      ...offlineRequest,
      expectedRegistryRevision: offlineRequest.expectedRegistryRevision - 1,
    })).rejects.toThrow('revision')
    const originalRecordEvaluation = SpecializedProfileRegistryStore.prototype.recordEvaluation
    const recordAfterCommit = spyOn(SpecializedProfileRegistryStore.prototype, 'recordEvaluation')
      .mockImplementationOnce(async function (
        this: SpecializedProfileRegistryStore,
        ...args: Parameters<typeof originalRecordEvaluation>
      ) {
        await originalRecordEvaluation.apply(this, args)
        throw new Error('simulated response loss after evaluation commit')
      })
    await expect(service.recordEvaluation('workspace-1', offlineRequest))
      .rejects.toThrow('simulated response loss after evaluation commit')
    recordAfterCommit.mockRestore()
    await expect(service.recordEvaluation('workspace-1', {
      ...offlineRequest,
      expectedRegistryRevision: offlineRequest.expectedRegistryRevision + 1,
    })).rejects.toThrow('revision')
    // The identical request retains its pre-close revision and must converge
    // after both a close-only crash and a committed response loss.
    const offline = await service.recordEvaluation('workspace-1', offlineRequest)
    const offlineReplay = await service.recordEvaluation('workspace-1', offlineRequest)
    expect(offlineReplay.registry.revision).toBe(offline.registry.revision)
    expect(offlineReplay.registry.profiles[0]!.evaluations).toHaveLength(1)
    const recordedOffline = offline.registry.profiles[0]!.evaluations[0]!
    expect(recordedOffline.corpus).toMatchObject({
      heldOut: true,
      version: 'test-partition-v1',
    })
    expect(recordedOffline.evidence.some(({ uri }) => uri.startsWith('corpus-lineage://'))).toBe(true)
    expect(recordedOffline.evidence.some(({ uri }) =>
      uri.startsWith('robb-authority://specialized-profiles/v2/evaluation/'))).toBe(true)

    const shadow = await service.transition('workspace-1', 'local-owner', {
      profileId: created.profileId,
      expectedRegistryRevision: offline.registry.revision,
      expectedCurrentVersion: 1,
      to: 'shadow',
      reason: 'Offline corpus passed with host-observed evidence.',
      evaluationIds: [recordedOffline.id],
    })

    let shadowCampaignId = ''
    let shadowCampaignRegistry = shadow.registry
    for (let index = 0; index < 20; index += 1) {
      const reservation = await service.reserveEvaluationMission('workspace-1', {
        profileId: created.profileId,
        stage: 'shadow',
        missionId: `evaluation-shadow-${index}`,
        caseFingerprintSha256: missionCorpusFingerprint(evaluationMission(
          index,
          'shadow',
          '2026-09-17T11:00:00.000Z',
          '2026-09-17T11:30:00.000Z',
          shadowCampaignRegistry,
          shadowCampaignId || 'pending-campaign',
        )),
      })
      shadowCampaignId = reservation.campaignId
      shadowCampaignRegistry = reservation.registry
    }
    missions.push(...Array.from({ length: 20 }, (_, index) => evaluationMission(
      index,
      'shadow',
      '2026-09-17T11:00:00.000Z',
      '2026-09-17T11:30:00.000Z',
      shadowCampaignRegistry,
      shadowCampaignId,
    )))
    setNow('2026-09-17T12:00:00.000Z')
    const shadowEvaluation = await service.recordEvaluation('workspace-1', {
      expectedRegistryRevision: shadowCampaignRegistry.revision,
      profileId: created.profileId,
      expectedCurrentVersion: 1,
      stage: 'shadow',
    })
    const recordedShadow = shadowEvaluation.registry.profiles[0]!.evaluations.at(-1)!
    const promoted = await service.transition('workspace-1', 'human-reviewer', {
      profileId: created.profileId,
      expectedRegistryRevision: shadowEvaluation.registry.revision,
      expectedCurrentVersion: 1,
      to: 'opt-in',
      reason: 'A distinct human reviewer approved bounded opt-in use.',
      evaluationIds: [recordedShadow.id],
      humanApprovalChallengeId: 'challenge-opt-in',
    })
    const receipt = promoted.registry.profiles[0]!.transitions.at(-1)!.approvalReceipt!
    expect(receipt.evidence.some(({ uri }) =>
      uri.startsWith('robb-authority://specialized-profiles/v2/approval/'))).toBe(true)
    expect((await service.getRegistry('workspace-1', 'local-owner')).revision)
      .toBe(promoted.registry.revision)

    const registryPath = join(root, '.robb', 'specialized-agent-profiles.json')
    const tampered = JSON.parse(readFileSync(registryPath, 'utf8')) as SpecializedProfileRegistryDocument
    tampered.profiles[0]!.transitions.at(-1)!.approvalReceipt!.rationale = 'Forged rationale.'
    writeFileSync(registryPath, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8')
    await expect(service.getRegistry('workspace-1', 'local-owner')).rejects.toThrow(/digest|host authority attestation/)
  })
})
