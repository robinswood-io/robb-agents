import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type SpecializedProfileRegistryDocument, SpecializedProfileRegistryStore } from "@craft-agent/shared/specialized-profiles";
import { missionCorpusFingerprint } from "./SpecializedProfileService.ts";
import { evaluationMission, mission, setup, temporaryRoots } from "./testing/SpecializedProfileService-fixture.ts";

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

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
    const internal = service;
    const original = internal['options'].missionEvidenceProvider
    if (!original) throw new Error("Mission evidence fixture is required");
    internal['options'].missionEvidenceProvider = {
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
      internal['options'].missionEvidenceProvider = original
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
    const internal = service;
    const lineageProvider = internal['options'].corpusLineageProvider
    delete internal['options'].corpusLineageProvider
    await expect(service.recordEvaluation('workspace-1', offlineRequest))
      .rejects.toThrow('independent host corpus-lineage attestor')
    internal['options'].corpusLineageProvider = lineageProvider!
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
});
