import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MissionSnapshot } from "@craft-agent/shared/missions";
import { type SpecializedProfileRegistryAnchor, type SpecializedProfileRegistryAnchorStore, type SpecializedProfileRegistryDocument, canonicalSpecializedProfileVersionHash } from "@craft-agent/shared/specialized-profiles";
import { SpecializedProfileService, type SpecializedProfileCorpusLineageProvider } from "../SpecializedProfileService.ts";



export const temporaryRoots: string[] = []

export const ROUTE_HASH = 'e'.repeat(64)


export function mission(index: number): MissionSnapshot {
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


export function evaluationMission(
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


export function setup(options: {
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
