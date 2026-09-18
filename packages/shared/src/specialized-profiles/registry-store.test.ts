import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalSpecializedProfileDefinitionHash,
  specializedProfileHasCurrentQualification,
  type SpecializedAgentProfileDefinition,
  type SpecializedProfileEvaluation,
  type SpecializedProfileHumanApprovalReceipt,
  type SpecializedProfileProvenance,
} from './schema.ts';
import {
  SpecializedProfileRegistryRevisionConflictError,
  SpecializedProfileRegistryStore,
  SpecializedProfileTransitionGateError,
  SpecializedProfileVersionConflictError,
  type SpecializedProfileRegistryAuthority,
} from './registry-store.ts';

const NOW = new Date('2026-09-17T10:00:00.000Z');
const CREATED_AT = new Date('2026-09-17T08:00:00.000Z');
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const testAuthority: SpecializedProfileRegistryAuthority = {
  verifyEvaluation: ({ evaluation }) => evaluation.evaluator.actorId === 'independent-evaluator',
  verifyHumanApprovalReceipt: ({ receipt }) => receipt.reviewer.actorId === 'human-reviewer',
};

let root: string;
let currentNow: Date;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'specialized-profile-registry-'));
  currentNow = CREATED_AT;
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function definition(specialty = 'Contrôle indépendant'): SpecializedAgentProfileDefinition {
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

function provenance(actorId = 'agent-proposer'): SpecializedProfileProvenance {
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

function evaluation(
  profileVersion: number,
  stage: SpecializedProfileEvaluation['stage'],
  id = `eval-${stage}-${profileVersion}`,
  overrides: Partial<SpecializedProfileEvaluation> = {},
): SpecializedProfileEvaluation {
  return {
    schemaVersion: 1,
    id,
    profileId: 'independent-reviewer',
    profileVersion,
    stage,
    outcome: 'pass',
    runId: `run-${stage}-${profileVersion}`,
    corpus: { id: 'held-out-reviews', version: '2026-09', heldOut: true },
    baseline: { kind: 'generalist', reference: 'generalist-2026-09' },
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
    startedAt: '2026-09-17T08:30:00.000Z',
    completedAt: '2026-09-17T09:00:00.000Z',
    validUntil: '2026-10-17T09:00:00.000Z',
    ...overrides,
  };
}

function approval(
  from: SpecializedProfileHumanApprovalReceipt['transition']['from'],
  to: SpecializedProfileHumanApprovalReceipt['transition']['to'],
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
      assurance: 'host-attested',
      verifierId: 'local-host',
      authenticatedAt: '2026-09-17T09:30:00.000Z',
    },
    issuedAt: '2026-09-17T09:35:00.000Z',
    expiresAt: '2026-09-18T09:35:00.000Z',
    rationale: 'Le corpus tenu à l’écart et les preuves satisfont le gate.',
    evidence: [{ uri: 'approval://review-1', sha256: HASH_A }],
  };
}

function store() {
  return new SpecializedProfileRegistryStore(root, {
    now: () => currentNow,
    authority: testAuthority,
  });
}

async function createCandidate(registry = store()) {
  await registry.loadOrCreate('workspace-1', 'local-owner');
  return registry.createCandidate(0, {
    profileId: 'independent-reviewer',
    definition: definition(),
    provenance: provenance(),
    actorId: 'agent-proposer',
    reason: 'Recurring independent review boundary.',
  });
}

describe('SpecializedProfileRegistryStore', () => {
  it('does not create storage during an absent-registry read', async () => {
    const registry = store();
    expect(await registry.load()).toBeNull();
    expect(existsSync(join(root, '.robb'))).toBe(false);
  });

  it('persists a strict candidate registry without granting capabilities', async () => {
    const registry = store();
    const created = await createCandidate(registry);

    expect(created).toMatchObject({
      schemaVersion: 1,
      workspaceId: 'workspace-1',
      revision: 1,
      profiles: [{ id: 'independent-reviewer', currentVersion: 1, currentState: 'candidate' }],
    });
    expect(created.profiles[0]?.versions[0]?.definition.requestedCapabilities[0]).toMatchObject({
      kind: 'workspace-read', name: 'artifact.read', required: true,
    });
    expect(JSON.stringify(created)).not.toContain('grantedPermissions');
    expect(JSON.stringify(created)).not.toContain('permissionMode');
    expect(statSync(registry.documentPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, '.robb')).mode & 0o777).toBe(0o700);
    expect(await new SpecializedProfileRegistryStore(root).load()).toEqual(created);

    const unsafe = { ...definition(), grantedPermissions: ['workspace-write'] };
    await expect(registry.reviseProfile(created.revision, {
      profileId: 'independent-reviewer', expectedCurrentVersion: 1,
      definition: unsafe as SpecializedAgentProfileDefinition,
      provenance: provenance(), actorId: 'agent-proposer', reason: 'Unsafe revision',
    })).rejects.toThrow();
    expect((await registry.load())?.revision).toBe(1);
  });

  it('creates an inactive draft atomically in one registry revision', async () => {
    const registry = store();
    await registry.loadOrCreate('workspace-1', 'local-owner');
    const created = await registry.createInactiveDraft(0, {
      profileId: 'independent-reviewer',
      definition: definition(),
      provenance: provenance(),
      actorId: 'agent-proposer',
      reason: 'Recurring independent review boundary.',
    }, 'local-owner', 'User confirmed inactive draft creation.');

    expect(created.revision).toBe(1);
    expect(created.profiles[0]).toMatchObject({
      currentState: 'draft',
      transitions: [
        { sequence: 1, from: null, to: 'candidate', actorId: 'agent-proposer' },
        { sequence: 2, from: 'candidate', to: 'draft', actorId: 'local-owner' },
      ],
    });
  });

  it('uses optimistic registry and profile version concurrency', async () => {
    const registry = store();
    const created = await createCandidate(registry);
    const revised = await registry.reviseProfile(created.revision, {
      profileId: 'independent-reviewer', expectedCurrentVersion: 1,
      definition: definition('Contrôle rendu'), provenance: provenance(),
      actorId: 'editor', reason: 'Clarify the specialty.',
    });
    expect(revised.profiles[0]).toMatchObject({ currentVersion: 2, currentState: 'draft' });

    await expect(registry.transition(created.revision, {
      profileId: 'independent-reviewer', expectedCurrentVersion: 2,
      to: 'retired', actorId: 'operator', reason: 'Stale registry writer.',
    })).rejects.toBeInstanceOf(SpecializedProfileRegistryRevisionConflictError);
    await expect(registry.transition(revised.revision, {
      profileId: 'independent-reviewer', expectedCurrentVersion: 1,
      to: 'retired', actorId: 'operator', reason: 'Stale profile writer.',
    })).rejects.toBeInstanceOf(SpecializedProfileVersionConflictError);
  });

  it('replays lifecycle gates when loading and rejects a forged disk promotion', async () => {
    const registry = store();
    const document = await createCandidate(registry);
    const forged = structuredClone(document);
    forged.profiles[0]!.currentState = 'default';
    forged.profiles[0]!.transitions.push({
      sequence: 2,
      profileVersion: 1,
      from: 'candidate',
      to: 'default',
      occurredAt: '2026-09-17T09:00:00.000Z',
      actorId: 'forger',
      reason: 'Bypass every gate.',
      evaluationIds: [],
    });
    writeFileSync(registry.documentPath, `${JSON.stringify(forged, null, 2)}\n`);

    await expect(registry.load()).rejects.toThrow(/not allowed|requires/);
  });

  it('rejects a forged new version that did not reset the lifecycle to draft', async () => {
    const registry = store();
    let document = await createCandidate(registry);
    document = await registry.reviseProfile(document.revision, {
      profileId: 'independent-reviewer', expectedCurrentVersion: 1,
      definition: definition('Second version'), provenance: provenance(),
      actorId: 'editor', reason: 'Prepare another candidate version.',
    });
    const forged = structuredClone(document);
    forged.profiles[0]!.transitions.pop();
    forged.profiles[0]!.currentState = 'candidate';
    writeFileSync(registry.documentPath, `${JSON.stringify(forged, null, 2)}\n`);

    await expect(registry.load()).rejects.toThrow('Latest profile version must have a lifecycle transition');
  });

  it('fails closed at every promotion gate and requires exact human receipts', async () => {
    const registry = store();
    let document = await createCandidate(registry);
    document = await registry.transition(document.revision, {
      profileId: 'independent-reviewer', expectedCurrentVersion: 1,
      to: 'draft', actorId: 'operator', reason: 'Candidate is complete enough for offline evaluation.',
    });

    await expect(registry.transition(document.revision, {
      profileId: 'independent-reviewer', expectedCurrentVersion: 1,
      to: 'shadow', actorId: 'operator', reason: 'No evaluation.',
    })).rejects.toBeInstanceOf(SpecializedProfileTransitionGateError);

    currentNow = NOW;
    document = await registry.recordEvaluation(document.revision, 'independent-evaluator', evaluation(1, 'offline'));
    document = await registry.transition(document.revision, {
      profileId: 'independent-reviewer', expectedCurrentVersion: 1,
      to: 'shadow', actorId: 'operator', reason: 'Offline gate passed.',
      evaluationIds: ['eval-offline-1'],
    });
    document = await registry.recordEvaluation(document.revision, 'independent-evaluator', evaluation(1, 'shadow'));

    await expect(registry.transition(document.revision, {
      profileId: 'independent-reviewer', expectedCurrentVersion: 1,
      to: 'opt-in', actorId: 'operator', reason: 'Missing approval.',
      evaluationIds: ['eval-shadow-1'],
    })).rejects.toThrow('structured human approval');
    await expect(registry.transition(document.revision, {
      profileId: 'independent-reviewer', expectedCurrentVersion: 1,
      to: 'opt-in', actorId: 'operator', reason: 'Wrong approval scope.',
      evaluationIds: ['eval-shadow-1'],
      approvalReceipt: { ...approval('shadow', 'opt-in'), profileVersion: 99 },
    })).rejects.toThrow('exact profile version');

    document = await registry.transition(document.revision, {
      profileId: 'independent-reviewer', expectedCurrentVersion: 1,
      to: 'opt-in', actorId: 'human-reviewer', reason: 'Shadow gate and human review passed.',
      evaluationIds: ['eval-shadow-1'], approvalReceipt: approval('shadow', 'opt-in'),
    });
    document = await registry.recordEvaluation(document.revision, 'independent-evaluator', evaluation(1, 'opt-in'));
    document = await registry.transition(document.revision, {
      profileId: 'independent-reviewer', expectedCurrentVersion: 1,
      to: 'canary', actorId: 'human-reviewer', reason: 'Opt-in gate and human review passed.',
      evaluationIds: ['eval-opt-in-1'], approvalReceipt: approval('opt-in', 'canary'),
    });
    document = await registry.recordEvaluation(document.revision, 'independent-evaluator', evaluation(1, 'canary'));
    document = await registry.transition(document.revision, {
      profileId: 'independent-reviewer', expectedCurrentVersion: 1,
      to: 'default', actorId: 'human-reviewer', reason: 'Canary gate and human review passed.',
      evaluationIds: ['eval-canary-1'], approvalReceipt: approval('canary', 'default'),
    });

    expect(document.profiles[0]?.currentState).toBe('default');
    expect(document.profiles[0]?.transitions.map(({ to }) => to)).toEqual([
      'candidate', 'draft', 'shadow', 'opt-in', 'canary', 'default',
    ]);
    expect(specializedProfileHasCurrentQualification(document.profiles[0]!, NOW)).toBe(true);
    expect(specializedProfileHasCurrentQualification(
      document.profiles[0]!,
      new Date('2026-11-17T10:00:00.000Z'),
    )).toBe(false);
  });

  it('uses the latest evaluation and rejects false completion or incomplete receipts', async () => {
    const registry = store();
    let document = await createCandidate(registry);
    document = await registry.transition(document.revision, {
      profileId: 'independent-reviewer', expectedCurrentVersion: 1,
      to: 'draft', actorId: 'operator', reason: 'Ready for offline evaluation.',
    });
    currentNow = NOW;
    document = await registry.recordEvaluation(document.revision, 'independent-evaluator', evaluation(1, 'offline', 'old-pass'));
    document = await registry.recordEvaluation(document.revision, 'independent-evaluator', evaluation(1, 'offline', 'latest-fail', {
      outcome: 'fail',
      completedAt: '2026-09-17T09:10:00.000Z',
      metrics: {
        ...evaluation(1, 'offline').metrics,
        falseCompletionCount: 1,
        completeReceiptCount: 3,
      },
    }));

    await expect(registry.transition(document.revision, {
      profileId: 'independent-reviewer', expectedCurrentVersion: 1,
      to: 'shadow', actorId: 'operator', reason: 'Cherry-pick old pass.', evaluationIds: ['old-pass'],
    })).rejects.toThrow('latest offline evaluation');
    await expect(registry.transition(document.revision, {
      profileId: 'independent-reviewer', expectedCurrentVersion: 1,
      to: 'shadow', actorId: 'operator', reason: 'Latest evaluation failed.', evaluationIds: ['latest-fail'],
    })).rejects.toThrow('does not satisfy');
    expect((await registry.load())?.profiles[0]?.currentState).toBe('draft');
  });

  it('requires host authority and statistically meaningful, expiring evaluations', async () => {
    const registry = store();
    let document = await createCandidate(registry);
    document = await registry.transition(document.revision, {
      profileId: 'independent-reviewer', expectedCurrentVersion: 1,
      to: 'draft', actorId: 'operator', reason: 'Ready for evaluation.',
    });
    currentNow = NOW;

    const undersized = evaluation(1, 'offline', 'undersized');
    undersized.metrics.caseCount = 1;
    undersized.metrics.verifiedPassCount = 1;
    undersized.metrics.verifiedPassRate = 1;
    await expect(registry.recordEvaluation(
      document.revision,
      'independent-evaluator',
      undersized,
    )).rejects.toThrow();
    await expect(registry.recordEvaluation(
      document.revision,
      'different-actor',
      evaluation(1, 'offline', 'wrong-actor'),
    )).rejects.toThrow('host-authenticated evaluator');

    document = await registry.recordEvaluation(
      document.revision,
      'independent-evaluator',
      evaluation(1, 'offline', 'authority-bound'),
    );
    await expect(new SpecializedProfileRegistryStore(root).load()).rejects.toThrow('host authority');
    expect((await registry.load())?.profiles[0]?.evaluations).toHaveLength(1);
  });

  it('rolls back by creating a new draft version without rewriting history', async () => {
    const registry = store();
    let document = await createCandidate(registry);
    const originalHash = canonicalSpecializedProfileDefinitionHash(
      document.profiles[0]?.versions[0]?.definition,
    );
    document = await registry.reviseProfile(document.revision, {
      profileId: 'independent-reviewer', expectedCurrentVersion: 1,
      definition: definition('Révision défectueuse'), provenance: {
        ...provenance(), sources: [{ kind: 'artifact', sourceId: 'revision', sha256: HASH_B, redacted: true }],
      }, actorId: 'editor', reason: 'Candidate revision.',
    });
    document = await registry.rollback(document.revision, {
      profileId: 'independent-reviewer', expectedCurrentVersion: 2,
      rollbackOfVersion: 1, actorId: 'operator', reason: 'Restore the last known definition.',
    });

    const profile = document.profiles[0]!;
    expect(profile).toMatchObject({ currentVersion: 3, currentState: 'draft' });
    expect(profile.versions.map(({ version }) => version)).toEqual([1, 2, 3]);
    expect(profile.versions[2]?.change).toEqual({
      kind: 'rollback', previousVersion: 2, rollbackOfVersion: 1,
      reason: 'Restore the last known definition.',
    });
    expect(canonicalSpecializedProfileDefinitionHash(profile.versions[2]?.definition)).toBe(originalHash);
    expect(profile.versions[1]?.definition.specialty).toBe('Révision défectueuse');
  });

  it('refuses symlinked store directories, documents, and locks', async () => {
    const outsideRoot = mkdtempSync(join(tmpdir(), 'specialized-profile-outside-'));
    try {
      const directoryRoot = mkdtempSync(join(tmpdir(), 'specialized-profile-directory-link-'));
      symlinkSync(outsideRoot, join(directoryRoot, '.robb'), 'dir');
      await expect(new SpecializedProfileRegistryStore(directoryRoot).load()).rejects.toThrow(/symbolic link|real directory/);
      expect(existsSync(join(outsideRoot, 'specialized-agent-profiles.json'))).toBe(false);
      rmSync(directoryRoot, { recursive: true, force: true });

      const registry = store();
      await registry.loadOrCreate('workspace-1', 'local-owner');
      const outsideDocument = join(outsideRoot, 'document.json');
      writeFileSync(outsideDocument, 'outside-document\n');
      unlinkSync(registry.documentPath);
      symlinkSync(outsideDocument, registry.documentPath);
      await expect(registry.load()).rejects.toThrow(/symbolic link/);
      expect(readFileSync(outsideDocument, 'utf8')).toBe('outside-document\n');
      unlinkSync(registry.documentPath);

      await registry.loadOrCreate('workspace-1', 'local-owner');
      const outsideLock = join(outsideRoot, 'lock');
      writeFileSync(outsideLock, 'outside-lock\n');
      symlinkSync(outsideLock, registry.lockPath);
      await expect(registry.createCandidate(0, {
        profileId: 'independent-reviewer', definition: definition(), provenance: provenance(),
        actorId: 'agent-proposer', reason: 'Must not follow lock link.',
      })).rejects.toThrow(/symbolic link/);
      expect(readFileSync(outsideLock, 'utf8')).toBe('outside-lock\n');
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('rejects a non-directory .robb path before reading or writing', async () => {
    writeFileSync(join(root, '.robb'), 'not-a-directory');
    const registry = store();
    await expect(registry.loadOrCreate('workspace-1', 'local-owner')).rejects.toThrow(/real directory/);
    expect(readFileSync(join(root, '.robb'), 'utf8')).toBe('not-a-directory');
  });

  it('validates lock timeout and never evicts an old lock owned by a live process', async () => {
    expect(() => new SpecializedProfileRegistryStore(root, { lockTimeoutMs: 0 })).toThrow('lockTimeoutMs');
    expect(() => new SpecializedProfileRegistryStore(root, { lockTimeoutMs: 10 * 60 * 1_000 + 1 })).toThrow('lockTimeoutMs');

    const registry = store();
    await registry.loadOrCreate('workspace-1', 'local-owner');
    writeFileSync(registry.lockPath, JSON.stringify({ pid: process.pid, acquiredAt: '2020-01-01T00:00:00.000Z' }));
    const old = new Date('2020-01-01T00:00:00.000Z');
    utimesSync(registry.lockPath, old, old);

    await expect(registry.createCandidate(0, {
      profileId: 'independent-reviewer', definition: definition(), provenance: provenance(),
      actorId: 'agent-proposer', reason: 'Must not steal a live lock.',
    })).rejects.toThrow('busy');
    expect(existsSync(registry.lockPath)).toBe(true);
  });
});
