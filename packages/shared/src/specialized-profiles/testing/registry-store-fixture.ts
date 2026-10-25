import { createHash } from "node:crypto";
import { canonicalSpecializedProfileRegistryAnchorPayloadHash, canonicalSpecializedProfileRegistryPayloadHash, type SpecializedAgentProfileDefinition, type SpecializedProfileEvaluation, type SpecializedProfileHumanApprovalReceipt, type SpecializedProfileRegistryAnchor, type SpecializedProfileProvenance } from "../schema.ts";
import { SpecializedProfileRegistryStore, type SpecializedProfileRegistryAuthority, type SpecializedProfileRegistryAnchorStore } from "../registry-store.ts";



export const NOW = new Date('2026-09-17T10:00:00.000Z');

export const CREATED_AT = new Date('2026-09-17T08:00:00.000Z');

export const HASH_A = 'a'.repeat(64);

export const HASH_B = 'b'.repeat(64);

export const authoritySha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const testAuthority: SpecializedProfileRegistryAuthority = {
  verifyEvaluation: ({ evaluation }) => evaluation.evaluator.actorId === 'independent-evaluator',
  verifyHumanApprovalReceipt: ({ receipt }) => receipt.reviewer.actorId === 'human-reviewer',
  attestRegistryHead: (head) => ({
    scheme: 'hmac-sha256', keyId: 'test-authority', sha256: authoritySha(head),
  }),
  verifyRegistryHead: (document) => document.head.authority.keyId === 'test-authority'
    && document.head.documentSha256 === canonicalSpecializedProfileRegistryPayloadHash(document)
    && document.head.authority.sha256 === authoritySha({
      workspaceId: document.workspaceId,
      revision: document.revision,
      documentSha256: document.head.documentSha256,
      previousDocumentSha256: document.head.previousDocumentSha256,
    }),
  attestRegistryAnchor: (anchor) => ({
    scheme: 'hmac-sha256', keyId: 'test-authority',
    sha256: authoritySha(canonicalSpecializedProfileRegistryAnchorPayloadHash(anchor)),
  }),
  verifyRegistryAnchor: (anchor) => anchor.authority.keyId === 'test-authority'
    && anchor.authority.sha256 === authoritySha(canonicalSpecializedProfileRegistryAnchorPayloadHash(anchor)),
};


export const anchors = new Map<string, SpecializedProfileRegistryAnchor>();

export const anchorStore: SpecializedProfileRegistryAnchorStore = {
  load: async (workspaceId) => structuredClone(anchors.get(workspaceId) ?? null),
  save: async (workspaceId, anchor) => { anchors.set(workspaceId, structuredClone(anchor)); },
};


export function definition(specialty = 'Contrôle indépendant'): SpecializedAgentProfileDefinition {
  return {
    displayName: 'Relecteur indépendant',
    role: 'reviewer',
    specialty,
    objective: 'Contrôler un livrable exact contre des critères explicites.',
    systemPrompt: 'Inspecter les preuves et rendre un verdict borné.',
    riskClass: 'moderate',
    eligibilityCriteria: [{
      id: 'review-task', description: 'Une revue indépendante est demandée.',
      field: 'task.family', operator: 'equals', value: 'independent-review',
    }],
    abstentionCriteria: [{
      id: 'missing-artifact', description: 'Le livrable exact est absent.',
      field: 'artifact.uri', operator: 'present',
    }],
    requestedCapabilities: [{
      id: 'artifact-read', kind: 'workspace-read', name: 'artifact.read',
      justification: 'Lire le livrable à contrôler.', required: true,
    }],
    successCriteria: [{ id: 'bound-verdict', description: 'Le verdict est lié à la version exacte.' }],
  };
}


export function provenance(actorId = 'agent-proposer'): SpecializedProfileProvenance {
  return {
    method: 'chat-pattern',
    proposedBy: { kind: 'agent', actorId },
    generatedBy: { name: 'profile-miner', version: '1.0.0' },
    generatedAt: '2026-09-17T08:00:00.000Z',
    analysisWindow: { from: '2026-06-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' },
    sample: { rawTaskCount: 20, deduplicatedRootTaskCount: 12 },
    sources: [{ kind: 'artifact', sourceId: 'audit-2026-q3', sha256: HASH_A, redacted: true }],
  };
}


export function evaluation(
  profileVersion: number,
  stage: SpecializedProfileEvaluation['stage'],
  id = `eval-${stage}-${profileVersion}`,
  overrides: Partial<SpecializedProfileEvaluation> = {},
): SpecializedProfileEvaluation {
  const stageTimes: Record<SpecializedProfileEvaluation['stage'], {
    startedAt: string;
    completedAt: string;
  }> = {
    offline: {
      startedAt: '2026-09-17T08:30:00.000Z',
      completedAt: '2026-09-17T09:00:00.000Z',
    },
    shadow: {
      startedAt: '2026-09-17T10:00:00.000Z',
      completedAt: '2026-09-17T10:00:00.000Z',
    },
    'opt-in': {
      startedAt: '2026-09-17T10:00:00.000Z',
      completedAt: '2026-09-17T10:00:00.000Z',
    },
    canary: {
      startedAt: '2026-09-17T10:00:00.000Z',
      completedAt: '2026-09-17T10:00:00.000Z',
    },
    regression: {
      startedAt: '2026-09-17T10:00:00.000Z',
      completedAt: '2026-09-17T10:00:00.000Z',
    },
  };
  return {
    schemaVersion: 1,
    id,
    profileId: 'independent-reviewer',
    profileVersion,
    stage,
    stageEntryTransitionSequence: stage === 'offline' ? 2
      : stage === 'shadow' ? 3
        : stage === 'opt-in' ? 4
          : stage === 'canary' ? 5
            : 6,
    executionRouteSha256: HASH_A,
    capabilityEnvelopeSha256: HASH_B,
    outcome: 'pass',
    runId: `run-${id}`,
    corpus: { id: 'held-out-reviews', version: '2026-09', heldOut: true },
    baseline: { kind: 'generalist', reference: 'generalist-2026-09' },
    cohort: {
      id: `campaign-${id}`,
      missionIds: Array.from({ length: 20 }, (_, index) => `mission-${id}-${index}`).sort(),
      closedAt: stageTimes[stage].completedAt,
    },
    evaluator: { actorId: 'independent-evaluator' },
    metrics: {
      caseCount: 20,
      verifiedPassCount: 19,
      verifiedPassRate: 0.95,
      falseCompletionCount: 0,
      policyViolationCount: 0,
      mutationCaseCount: 4,
      requiredReceiptCount: 4,
      completeReceiptCount: 4,
      humanInterventionRate: 0.1,
    },
    evidence: [{ uri: `eval://${id}`, sha256: HASH_B }],
    ...stageTimes[stage],
    validUntil: '2026-10-17T09:00:00.000Z',
    ...overrides,
  };
}


export function approval(
  from: SpecializedProfileHumanApprovalReceipt['transition']['from'],
  to: SpecializedProfileHumanApprovalReceipt['transition']['to'],
  document: Awaited<ReturnType<SpecializedProfileRegistryStore['loadOrCreate']>>,
  evaluationIds: string[],
  profileVersion = 1,
  receiptId = `approval-${to}-${profileVersion}`,
): SpecializedProfileHumanApprovalReceipt {
  return {
    schemaVersion: 1,
    receiptId,
    profileId: 'independent-reviewer',
    profileVersion,
    transition: { from, to },
    decision: 'approved',
    reviewer: { kind: 'human', actorId: 'human-reviewer' },
    authentication: {
      assurance: 'webauthn',
      verifierId: 'local-host',
      eventId: `authentication-${receiptId}`,
      authenticatedAt: '2026-09-17T09:30:00.000Z',
    },
    authorizationContext: {
      registryRevision: document.revision,
      registryHeadSha256: document.head.documentSha256,
      lifecycleEntryTransitionSequence: document.profiles[0]!.transitions.at(-1)!.sequence,
      evaluationIds,
    },
    issuedAt: '2026-09-17T09:35:00.000Z',
    expiresAt: '2026-09-18T09:35:00.000Z',
    rationale: 'Le corpus tenu à l’écart et les preuves satisfont le gate.',
    evidence: [{ uri: 'approval://review-1', sha256: HASH_A }],
  };
}


export async function recordEvaluationWithCampaign(
  registry: SpecializedProfileRegistryStore,
  document: Awaited<ReturnType<SpecializedProfileRegistryStore['loadOrCreate']>>,
  actorId: string,
  value: SpecializedProfileEvaluation,
) {
  let current = document;
  let campaignId = '';
  for (const missionId of value.cohort.missionIds) {
    const reserved = await registry.reserveEvaluationMission(current.revision, {
      profileId: value.profileId,
      expectedCurrentVersion: value.profileVersion,
      stage: value.stage,
      missionId,
      caseFingerprintSha256: createHash('sha256').update(missionId).digest('hex'),
      actorId: 'evaluation-campaign-host',
    });
    current = reserved.registry;
    campaignId = reserved.campaign.id;
  }
  const closed = await registry.closeEvaluationCampaign(current.revision, {
    profileId: value.profileId,
    expectedCurrentVersion: value.profileVersion,
    stage: value.stage,
    campaignId,
    actorId: 'evaluation-campaign-host',
  });
  return registry.recordEvaluation(closed.registry.revision, actorId, {
    ...value,
    cohort: {
      ...value.cohort,
      id: closed.campaign.id,
      missionIds: closed.campaign.missionIds,
      closedAt: closed.campaign.closedAt!,
    },
  });
}
