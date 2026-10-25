import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalSpecializedProfileDefinitionHash, canonicalSpecializedProfileRegistryPayloadHash, type SpecializedAgentProfileDefinition } from "./schema.ts";
import { SpecializedProfileRegistryRevisionConflictError, SpecializedProfileRegistryStore, SpecializedProfileTransitionGateError, SpecializedProfileVersionConflictError, type SpecializedProfileRegistryAnchorStore } from "./registry-store.ts";
import { CREATED_AT, HASH_B, NOW, anchorStore, anchors, approval, definition, evaluation, provenance, recordEvaluationWithCampaign, testAuthority } from "./testing/registry-store-fixture.ts";

let root: string;
let currentNow: Date;
function store() {
  return new SpecializedProfileRegistryStore(root, {
    now: () => currentNow,
    authority: testAuthority,
    anchorStore,
  });
}
async function createCandidate(registry = store()) {
  await registry.loadOrCreate('workspace-1', 'local-owner');
  return registry.createCandidate(0, {
    profileId: 'independent-reviewer',
    creationRequestId: 'proposal-independent-reviewer',
    definition: definition(),
    provenance: provenance(),
    actorId: 'agent-proposer',
    reason: 'Recurring independent review boundary.',
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'specialized-profile-registry-'));
  currentNow = CREATED_AT;
  anchors.clear();
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

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
      schemaVersion: 2,
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
    expect(await store().load()).toEqual(created);

    const unsafe = { ...definition(), grantedPermissions: ['workspace-write'] };
    await expect(registry.reviseProfile(created.revision, {
      profileId: 'independent-reviewer', expectedCurrentVersion: 1,
      definition: unsafe as SpecializedAgentProfileDefinition,
      provenance: provenance(), actorId: 'agent-proposer', reason: 'Unsafe revision',
    })).rejects.toThrow();
    expect((await registry.load())?.revision).toBe(1);
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

  it('creates a draft in one durable revision and makes crash retries idempotent', async () => {
    let rejectFinalCommit = true;
    const crashAnchorStore: SpecializedProfileRegistryAnchorStore = {
      load: anchorStore.load,
      save: async (workspaceId, anchor) => {
        if (rejectFinalCommit
          && !anchor.pending
          && anchor.committed?.revision === 1) {
          rejectFinalCommit = false;
          throw new Error('injected final anchor commit failure');
        }
        await anchorStore.save(workspaceId, anchor);
      },
    };
    const registry = new SpecializedProfileRegistryStore(root, {
      now: () => currentNow,
      authority: testAuthority,
      anchorStore: crashAnchorStore,
    });
    await registry.loadOrCreate('workspace-1', 'local-owner');
    const input = {
      profileId: 'independent-reviewer',
      creationRequestId: 'atomic-draft-request',
      definition: definition(),
      provenance: provenance(),
      actorId: 'agent-proposer',
      reason: 'Create an atomic inactive draft.',
    };
    await expect(registry.createDraft(0, input)).rejects.toThrow('injected final anchor commit failure');

    const recovered = await registry.loadOrCreate('workspace-1', 'local-owner');
    expect(recovered).toMatchObject({
      revision: 1,
      profiles: [{
        creationRequestId: 'atomic-draft-request',
        currentState: 'draft',
      }],
    });
    expect(recovered.profiles[0]?.transitions.map(({ to }) => to)).toEqual(['candidate', 'draft']);
    expect(await registry.createDraft(0, input)).toEqual(recovered);
  });

  it('rejects rollback replay even when the old document has a valid host signature', async () => {
    const registry = store();
    const created = await createCandidate(registry);
    const oldDocument = readFileSync(registry.documentPath, 'utf8');
    await registry.reviseProfile(created.revision, {
      profileId: 'independent-reviewer', expectedCurrentVersion: 1,
      definition: definition('New authenticated version'), provenance: provenance(),
      actorId: 'editor', reason: 'Advance the monotone head.',
    });
    writeFileSync(registry.documentPath, oldDocument, { mode: 0o600 });
    await expect(registry.load()).rejects.toThrow(/replay|unanchored composition/);
  });

  it('rejects recomposed documents and legacy schema migration fail-closed', async () => {
    const registry = store();
    const document = await createCandidate(registry);
    const recomposed = structuredClone(document);
    recomposed.profiles[0]!.versions[0]!.definition.objective = 'Attacker-composed objective.';
    recomposed.head.documentSha256 = canonicalSpecializedProfileRegistryPayloadHash(recomposed);
    writeFileSync(registry.documentPath, `${JSON.stringify(recomposed, null, 2)}\n`, { mode: 0o600 });
    await expect(registry.load()).rejects.toThrow('whole-document host attestation');

    const legacy = { ...document, schemaVersion: 1 };
    writeFileSync(registry.documentPath, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });
    await expect(registry.load()).rejects.toThrow();
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
    document = await recordEvaluationWithCampaign(registry, document, 'independent-evaluator', evaluation(1, 'offline'));
    document = await registry.transition(document.revision, {
      profileId: 'independent-reviewer', expectedCurrentVersion: 1,
      to: 'shadow', actorId: 'operator', reason: 'Offline gate passed.',
      evaluationIds: ['eval-offline-1'],
    });
    document = await recordEvaluationWithCampaign(registry, document, 'independent-evaluator', evaluation(1, 'shadow'));

    await expect(registry.transition(document.revision, {
      profileId: 'independent-reviewer', expectedCurrentVersion: 1,
      to: 'opt-in', actorId: 'operator', reason: 'Missing approval.',
      evaluationIds: ['eval-shadow-1'],
    })).rejects.toThrow('structured human approval');
    await expect(registry.transition(document.revision, {
      profileId: 'independent-reviewer', expectedCurrentVersion: 1,
      to: 'opt-in', actorId: 'operator', reason: 'Wrong approval scope.',
      evaluationIds: ['eval-shadow-1'],
      approvalReceipt: {
        ...approval('shadow', 'opt-in', document, ['eval-shadow-1']),
        profileVersion: 99,
      },
    })).rejects.toThrow('exact profile version');

    document = await registry.transition(document.revision, {
      profileId: 'independent-reviewer', expectedCurrentVersion: 1,
      to: 'opt-in', actorId: 'human-reviewer', reason: 'Shadow gate and human review passed.',
      evaluationIds: ['eval-shadow-1'],
      approvalReceipt: approval('shadow', 'opt-in', document, ['eval-shadow-1']),
    });
    document = await recordEvaluationWithCampaign(registry, document, 'independent-evaluator', evaluation(1, 'opt-in'));
    document = await registry.transition(document.revision, {
      profileId: 'independent-reviewer', expectedCurrentVersion: 1,
      to: 'canary', actorId: 'human-reviewer', reason: 'Opt-in gate and human review passed.',
      evaluationIds: ['eval-opt-in-1'],
      approvalReceipt: approval('opt-in', 'canary', document, ['eval-opt-in-1']),
    });
    document = await recordEvaluationWithCampaign(registry, document, 'independent-evaluator', evaluation(1, 'canary'));
    document = await registry.transition(document.revision, {
      profileId: 'independent-reviewer', expectedCurrentVersion: 1,
      to: 'default', actorId: 'human-reviewer', reason: 'Canary gate and human review passed.',
      evaluationIds: ['eval-canary-1'],
      approvalReceipt: approval('canary', 'default', document, ['eval-canary-1']),
    });

    expect(document.profiles[0]?.currentState).toBe('default');
    expect(document.profiles[0]?.transitions.map(({ to }) => to)).toEqual([
      'candidate', 'draft', 'shadow', 'opt-in', 'canary', 'default',
    ]);

    for (const to of ['canary', 'opt-in', 'shadow'] as const) {
      document = await registry.transition(document.revision, {
        profileId: 'independent-reviewer', expectedCurrentVersion: 1,
        to, actorId: 'operator', reason: `Fail-closed downgrade to ${to}.`,
      });
    }
    expect(document.profiles[0]?.currentState).toBe('shadow');
    expect(document.profiles[0]?.transitions.slice(-3).map(({ to }) => to))
      .toEqual(['canary', 'opt-in', 'shadow']);
  });

  it('uses the latest evaluation and rejects false completion or incomplete receipts', async () => {
    const registry = store();
    let document = await createCandidate(registry);
    document = await registry.transition(document.revision, {
      profileId: 'independent-reviewer', expectedCurrentVersion: 1,
      to: 'draft', actorId: 'operator', reason: 'Ready for offline evaluation.',
    });
    currentNow = NOW;
    document = await recordEvaluationWithCampaign(registry, document, 'independent-evaluator', evaluation(1, 'offline', 'old-pass'));
    document = await recordEvaluationWithCampaign(registry, document, 'independent-evaluator', evaluation(1, 'offline', 'latest-fail', {
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
    await expect(recordEvaluationWithCampaign(
      registry,
      document,
      'independent-evaluator',
      undersized,
    )).rejects.toThrow();
    document = (await registry.load())!;
    await expect(recordEvaluationWithCampaign(
      registry,
      document,
      'different-actor',
      evaluation(1, 'offline', 'wrong-actor'),
    )).rejects.toThrow('host-authenticated evaluator');
    document = (await registry.load())!;

    document = await recordEvaluationWithCampaign(
      registry,
      document,
      'independent-evaluator',
      evaluation(1, 'offline', 'authority-bound'),
    );
    await expect(new SpecializedProfileRegistryStore(root).load()).rejects.toThrow(/host attestation|host authority/);
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
      const originalDocument = readFileSync(registry.documentPath, 'utf8');
      const outsideDocument = join(outsideRoot, 'document.json');
      writeFileSync(outsideDocument, 'outside-document\n');
      unlinkSync(registry.documentPath);
      symlinkSync(outsideDocument, registry.documentPath);
      await expect(registry.load()).rejects.toThrow(/symbolic link/);
      expect(readFileSync(outsideDocument, 'utf8')).toBe('outside-document\n');
      unlinkSync(registry.documentPath);
      writeFileSync(registry.documentPath, originalDocument, { mode: 0o600 });
      const outsideLock = join(outsideRoot, 'lock');
      writeFileSync(outsideLock, 'outside-lock\n');
      symlinkSync(outsideLock, registry.lockPath);
      await expect(registry.createCandidate(0, {
        profileId: 'independent-reviewer', creationRequestId: 'linked-lock-attempt',
        definition: definition(), provenance: provenance(),
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
      profileId: 'independent-reviewer', creationRequestId: 'live-lock-attempt',
      definition: definition(), provenance: provenance(),
      actorId: 'agent-proposer', reason: 'Must not steal a live lock.',
    })).rejects.toThrow('busy');
    expect(existsSync(registry.lockPath)).toBe(true);
  });
});
