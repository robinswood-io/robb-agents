import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MissionSnapshot } from '@craft-agent/shared/missions'
import {
  SpecializedProfileRegistryRevisionConflictError,
  type SpecializedProfileRegistryDocument,
} from '@craft-agent/shared/specialized-profiles'
import { SpecializedProfileService } from './SpecializedProfileService.ts'

const temporaryRoots: string[] = []

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
      tools: [], sources: [], skills: [], permissionMode: 'safe' as const,
    },
    {
      id: 'worker', role: 'worker' as const, specialty: 'bounded-accounting', systemPrompt: 'Review.',
      tools: ['ledger.read'], sources: ['ledger'], skills: ['accounting-review'],
      permissionMode: 'safe' as const,
    },
    {
      id: 'unused-worker', role: 'worker' as const, specialty: 'unrelated', systemPrompt: 'Unused.',
      tools: ['unrelated.write'], sources: ['unrelated'], skills: ['unrelated-mutation'],
      permissionMode: 'allow-all' as const,
    },
    {
      id: 'reviewer', role: 'reviewer' as const, specialty: 'review', systemPrompt: 'Review.',
      tools: [], sources: [], skills: [], permissionMode: 'safe' as const,
    },
    {
      id: 'supervisor', role: 'supervisor' as const, specialty: 'supervision', systemPrompt: 'Supervise.',
      tools: [], sources: [], skills: [], permissionMode: 'safe' as const,
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

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'robb-specialized-profile-service-'))
  temporaryRoots.push(root)
  const stale = mission(9)
  stale.createdAt = '2025-01-01T09:00:00.000Z'
  stale.updatedAt = '2025-01-01T10:00:00.000Z'
  const missions = [...Array.from({ length: 8 }, (_, index) => mission(index + 1)), stale]
  let clock = new Date('2026-09-17T08:00:00.000Z')
  return {
    root,
    setNow: (value: string) => { clock = new Date(value) },
    service: new SpecializedProfileService({
      resolveWorkspace: (workspaceId) => workspaceId === 'workspace-1'
        ? { id: workspaceId, rootPath: root }
        : null,
      listMissions: async () => missions,
      now: () => new Date(clock),
      loadAuthorityKey: async () => Buffer.alloc(32, 7),
    }),
  }
}

describe('SpecializedProfileService', () => {
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
    expect(profile.versions[0]!.definition.specialty).toBe('bounded-accounting')
    expect(profile.versions[0]!.definition.requestedCapabilities.map((entry) => entry.kind)).toEqual([
      'skill',
      'source',
      'tool',
      'workspace-read',
    ])
    expect(profile.versions[0]!.definition).not.toHaveProperty('model')
    expect(profile.versions[0]!.definition).not.toHaveProperty('permissionMode')
  })

  it('rejects stale writes and refuses shadow without a qualifying offline evaluation', async () => {
    const { service } = setup()
    const analysis = await service.analyze('workspace-1')
    const proposal = analysis.report.proposals.find((entry) => entry.category === 'agent-profile')!
    const created = await service.createDraft('workspace-1', 'local-owner', {
      proposalId: proposal.proposalId,
      expectedRegistryRevision: 0,
    })

    await expect(service.createDraft('workspace-1', 'local-owner', {
      proposalId: proposal.proposalId,
      expectedRegistryRevision: 0,
    })).rejects.toBeInstanceOf(SpecializedProfileRegistryRevisionConflictError)

    await expect(service.transition('workspace-1', 'local-owner', {
      profileId: created.profileId,
      expectedRegistryRevision: created.registry.revision,
      expectedCurrentVersion: 1,
      to: 'shadow',
      reason: 'Attempt promotion without evidence.',
      evaluationIds: [],
    })).rejects.toThrow('requires the latest offline evaluation')
  })

  it('fails closed to an inactive draft when qualification evidence expires', async () => {
    const { service, setNow } = setup()
    const analysis = await service.analyze('workspace-1')
    const proposal = analysis.report.proposals.find((entry) => entry.category === 'agent-profile')!
    const created = await service.createDraft('workspace-1', 'local-owner', {
      proposalId: proposal.proposalId,
      expectedRegistryRevision: 0,
    })

    setNow('2026-09-17T10:00:00.000Z')
    const offline = await service.recordEvaluation('workspace-1', 'offline-validator', {
      expectedRegistryRevision: created.registry.revision,
      evaluation: evaluation(created.profileId, 'offline-eval', 'offline', 'offline-validator', {
        startedAt: '2026-09-17T09:00:00.000Z',
        completedAt: '2026-09-17T09:30:00.000Z',
      }),
    })
    const shadow = await service.transition('workspace-1', 'local-owner', {
      profileId: created.profileId,
      expectedRegistryRevision: offline.registry.revision,
      expectedCurrentVersion: 1,
      to: 'shadow',
      reason: 'Offline evaluation passed.',
      evaluationIds: ['offline-eval'],
    })
    expect(shadow.registry.profiles[0]!.currentState).toBe('shadow')

    setNow('2026-11-17T10:00:00.000Z')
    const reconciledRevisions: number[] = []
    const expired = await service.getRegistry(
      'workspace-1',
      'local-owner',
      (registry) => reconciledRevisions.push(registry.revision),
    )
    expect(expired.profiles[0]!.currentState).toBe('draft')
    expect(reconciledRevisions).toEqual([expired.revision])
    expect(expired.profiles[0]!.transitions.at(-1)).toMatchObject({
      from: 'shadow',
      to: 'draft',
      actorId: 'specialization-qualification-expiry-enforcer',
    })
  })

  it('host-attests evaluations, refuses synthetic human approval, and rejects durable tampering', async () => {
    const { root, service, setNow } = setup()
    const analysis = await service.analyze('workspace-1')
    const proposal = analysis.report.proposals.find((entry) => entry.category === 'agent-profile')!
    const created = await service.createDraft('workspace-1', 'local-owner', {
      proposalId: proposal.proposalId,
      expectedRegistryRevision: 0,
    })

    setNow('2026-09-17T10:00:00.000Z')
    const offline = await service.recordEvaluation('workspace-1', 'offline-validator', {
      expectedRegistryRevision: created.registry.revision,
      evaluation: evaluation(created.profileId, 'offline-eval', 'offline', 'offline-validator', {
        startedAt: '2026-09-17T09:00:00.000Z',
        completedAt: '2026-09-17T09:30:00.000Z',
      }),
    })
    const recordedOffline = offline.registry.profiles[0]!.evaluations[0]!
    expect(recordedOffline.evidence.some(({ uri }) =>
      uri.startsWith('robb-authority://specialized-profiles/v1/evaluation/'))).toBe(true)

    const shadow = await service.transition('workspace-1', 'local-owner', {
      profileId: created.profileId,
      expectedRegistryRevision: offline.registry.revision,
      expectedCurrentVersion: 1,
      to: 'shadow',
      reason: 'Offline corpus passed with host-observed evidence.',
      evaluationIds: ['offline-eval'],
    })

    setNow('2026-09-17T12:00:00.000Z')
    const shadowEvaluation = await service.recordEvaluation('workspace-1', 'shadow-validator', {
      expectedRegistryRevision: shadow.registry.revision,
      evaluation: evaluation(created.profileId, 'shadow-eval', 'shadow', 'shadow-validator', {
        startedAt: '2026-09-17T11:00:00.000Z',
        completedAt: '2026-09-17T11:30:00.000Z',
      }),
    })
    await expect(service.transition('workspace-1', 'human-reviewer', {
      profileId: created.profileId,
      expectedRegistryRevision: shadowEvaluation.registry.revision,
      expectedCurrentVersion: 1,
      to: 'opt-in',
      reason: 'A distinct human reviewer approved bounded opt-in use.',
      evaluationIds: ['shadow-eval'],
    })).rejects.toThrow('distinct host-attested human approval flow')
    expect((await service.getRegistry('workspace-1', 'local-owner')).revision).toBe(4)

    const registryPath = join(root, '.robb', 'specialized-agent-profiles.json')
    const tampered = JSON.parse(readFileSync(registryPath, 'utf8')) as SpecializedProfileRegistryDocument
    const authorityEvidence = tampered.profiles[0]!.evaluations[0]!.evidence.find(({ uri }) =>
      uri.startsWith('robb-authority://specialized-profiles/v1/evaluation/'))!
    authorityEvidence.sha256 = 'f'.repeat(64)
    writeFileSync(registryPath, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8')
    await expect(service.getRegistry('workspace-1', 'local-owner')).rejects.toThrow(
      'lacks a valid host authority attestation',
    )
  })
})

function evaluation(
  profileId: string,
  id: string,
  stage: 'offline' | 'shadow',
  actorId: string,
  times: { startedAt: string; completedAt: string },
) {
  return {
    schemaVersion: 1 as const,
    id,
    profileId,
    profileVersion: 1,
    stage,
    outcome: 'pass' as const,
    runId: `${id}-run`,
    corpus: { id: `${id}-corpus`, version: '1', heldOut: true as const },
    baseline: { kind: 'generalist' as const, reference: 'generalist-v1' },
    evaluator: { actorId },
    metrics: {
      caseCount: 20,
      verifiedPassCount: 20,
      verifiedPassRate: 1,
      falseCompletionCount: 0,
      policyViolationCount: 0,
      mutationCaseCount: 0,
      requiredReceiptCount: 0,
      completeReceiptCount: 0,
      humanInterventionRate: 0,
      qualityDelta: 0.1,
      costDelta: 0,
    },
    evidence: [{ uri: `evaluation://${id}`, sha256: 'a'.repeat(64) }],
    ...times,
    validUntil: '2026-10-17T12:00:00.000Z',
  }
}
