import { describe, expect, it } from 'bun:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvalGateResult } from '../evals/eval-gate.ts';
import { signProofPassport } from '../missions/proof-passport.ts';
import {
  approveVerifiedLearningProposal,
  createVerifiedLearningProposal,
  recordVerifiedLearningCanary,
  recordVerifiedLearningEval,
  rollbackVerifiedLearningCanary,
  VerifiedLearningStore,
  verifyVerifiedLearningHistory,
  type HostVerifiedLearningIdentity,
  type VerifiedLearningAuthority,
} from './verified-learning.ts';

const proposerKeys = generateKeyPairSync('ed25519');
const evaluatorKeys = generateKeyPairSync('ed25519');
const reviewerKeys = generateKeyPairSync('ed25519');
const operatorKeys = generateKeyPairSync('ed25519');
const proposer = { actorId: 'learning-proposer', keyId: 'proposer-key-1', privateKey: proposerKeys.privateKey };
const evaluator = { actorId: 'learning-evaluator', keyId: 'evaluator-key-1', privateKey: evaluatorKeys.privateKey };
const reviewer = { actorId: 'human-reviewer-1', keyId: 'human-key-1', privateKey: reviewerKeys.privateKey };
const operator = { actorId: 'learning-operator', keyId: 'operator-key-1', privateKey: operatorKeys.privateKey };
const trustedProofPassportPublicKeySpki = Buffer.from(
  proposerKeys.publicKey.export({ format: 'der', type: 'spki' }),
).toString('base64url');
const resolveKey = (keyId: string, actorId: string) => {
  if (keyId === proposer.keyId && actorId === proposer.actorId) return proposerKeys.publicKey;
  if (keyId === evaluator.keyId && actorId === evaluator.actorId) return evaluatorKeys.publicKey;
  if (keyId === reviewer.keyId && actorId === reviewer.actorId) return reviewerKeys.publicKey;
  if (keyId === operator.keyId && actorId === operator.actorId) return operatorKeys.publicKey;
  return null;
};
const identities = new Map<string, HostVerifiedLearningIdentity>([
  [proposer.actorId, {
    verificationStatus: 'host-resolved', kind: 'service', actorId: proposer.actorId,
    workspaceId: 'workspace-1', role: 'proposer', active: true, keyIds: [proposer.keyId],
  }],
  [evaluator.actorId, {
    verificationStatus: 'host-resolved', kind: 'service', actorId: evaluator.actorId,
    workspaceId: 'workspace-1', role: 'evaluator', active: true, keyIds: [evaluator.keyId],
  }],
  [reviewer.actorId, {
    verificationStatus: 'host-resolved', kind: 'human', actorId: reviewer.actorId,
    workspaceId: 'workspace-1', role: 'reviewer', active: true, keyIds: [reviewer.keyId],
    humanAuthentication: {
      assurance: 'host-attested', verifierId: 'workforce-idp',
      authenticatedAt: '2026-08-20T10:30:00.000Z', expiresAt: '2026-08-20T14:00:00.000Z',
    },
  }],
  [operator.actorId, {
    verificationStatus: 'host-resolved', kind: 'service', actorId: operator.actorId,
    workspaceId: 'workspace-1', role: 'operator', active: true, keyIds: [operator.keyId],
  }],
]);
const authority: VerifiedLearningAuthority = {
  resolveKey,
  resolveIdentity: (actorId, keyId) => {
    const identity = identities.get(actorId);
    return identity?.keyIds.includes(keyId) ? identity : null;
  },
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function passport() {
  return signProofPassport({
    schemaVersion: 1, passportId: 'passport-1', missionId: 'mission-1', workspaceId: 'workspace-1',
    outcome: 'pass', completedAt: '2026-08-20T10:00:00.000Z', issuedAt: '2026-08-20T10:01:00.000Z',
    missionObjectiveSha256: hash('objective'), missionJournalSha256: hash('journal'), missionRevision: 2,
    criteria: [], evidence: [],
    privacy: { redacted: true, excluded: ['artifact-content', 'credentials'] },
  }, proposerKeys.privateKey);
}

function proposal() {
  return createVerifiedLearningProposal({
    proposalId: 'learning-1', workspaceId: 'workspace-1',
    artifact: { kind: 'playbook', slug: 'verified-flow', baseVersion: '1', candidateVersion: '2' },
    candidateContent: 'Use a bounded, verified workflow.', passport: passport(),
    trustedProofPassportPublicKeySpki,
    trajectory: [{ eventSha256: hash('event'), kind: 'outcome', redacted: true }],
    createdAt: '2026-08-20T11:00:00.000Z', signer: proposer, authority,
  });
}

function gate(): EvalGateResult {
  return {
    passed: true, failures: [],
    report: {
      schemaVersion: 1, corpusId: 'learning', corpusVersion: '1', runId: 'eval-1',
      createdAt: '2026-08-20T11:10:00.000Z',
      versions: { model: 'local', prompt: '2', router: '1', connectors: {} }, fingerprint: hash('eval'),
      results: [], aggregates: [],
      summary: {
        total: 10, uniqueCases: 10, averageRunsPerCase: 1, passRate: 1,
        passRateConfidence95: { lower: 0.7, upper: 1, confidence: 0.95, method: 'wilson' },
        toolSuccessRate: 1, policyComplianceRate: 1, factualityScore: 1,
        factualityConfidence95: { lower: 1, upper: 1, confidence: 0.95, method: 'normal-mean' },
        p95LatencyMs: 10, averageCostUsd: 0, costCoverageRate: 1,
        humanInterventionRate: 0, destructiveActionSafetyRate: 1, providerErrorRecoveryRate: 1,
      },
    },
  };
}

describe('verified organizational learning', () => {
  it('requires proof, eval, signed human approval and canary while remaining proposal-only', () => {
    const proposed = proposal();
    expect(() => approveVerifiedLearningProposal({ history: [proposed], authority, rationale: 'OK', signer: reviewer })).toThrow(/eval/);
    expect(() => recordVerifiedLearningEval({
      history: [proposed], authority, gate: gate(), signer: proposer,
      occurredAt: '2026-08-20T11:10:00.000Z',
    })).toThrow(/evaluator role/);
    const evaluated = recordVerifiedLearningEval({
      history: [proposed], authority, gate: gate(), signer: evaluator,
      occurredAt: '2026-08-20T11:10:00.000Z',
    });
    expect(() => approveVerifiedLearningProposal({
      history: [proposed, evaluated], authority, rationale: 'Self review', signer: evaluator,
    })).toThrow(/reviewer role/);
    const approved = approveVerifiedLearningProposal({
      history: [proposed, evaluated], authority, rationale: 'Reviewed', signer: reviewer,
      occurredAt: '2026-08-20T11:20:00.000Z',
    });
    const canary = recordVerifiedLearningCanary({
      history: [proposed, evaluated, approved], authority, signer: operator,
      tokenReduction: 0.35, interventionReduction: 0.4, qualityRegression: 0, securityViolations: 0,
      occurredAt: '2026-08-20T11:30:00.000Z',
    });
    const verified = verifyVerifiedLearningHistory([proposed, evaluated, approved, canary], authority);
    expect(verified).toMatchObject({
      valid: true,
      projection: {
        state: 'canary-passed', publicationMode: 'proposal-only', automaticPublication: false,
        participants: {
          proposerActorId: proposer.actorId,
          evaluatorActorId: evaluator.actorId,
          reviewerActorId: reviewer.actorId,
        },
      },
    });
    expect(JSON.stringify(proposed)).not.toContain('Use a bounded');
  });

  it('forces rollback after a failed canary and rejects tampering or secret candidates', () => {
    const proposed = proposal();
    const evaluated = recordVerifiedLearningEval({
      history: [proposed], authority, gate: gate(), signer: evaluator,
      occurredAt: '2026-08-20T11:10:00.000Z',
    });
    const approved = approveVerifiedLearningProposal({
      history: [proposed, evaluated], authority, rationale: 'Reviewed', signer: reviewer,
      occurredAt: '2026-08-20T11:20:00.000Z',
    });
    const failed = recordVerifiedLearningCanary({
      history: [proposed, evaluated, approved], authority, signer: operator,
      tokenReduction: 0.1, interventionReduction: 0.1, qualityRegression: 0.01, securityViolations: 1,
      occurredAt: '2026-08-20T11:30:00.000Z',
    });
    const rollback = rollbackVerifiedLearningCanary({
      history: [proposed, evaluated, approved, failed], authority, reason: 'Canary regressed', signer: operator,
      occurredAt: '2026-08-20T11:40:00.000Z',
    });
    expect(verifyVerifiedLearningHistory([proposed, evaluated, approved, failed, rollback], authority)).toMatchObject({
      valid: true, projection: { state: 'rolled-back' },
    });
    const tampered = structuredClone(proposed);
    (tampered.payload as Record<string, unknown>).extra = true;
    expect(verifyVerifiedLearningHistory([tampered], authority)).toMatchObject({
      valid: false, reason: expect.stringContaining('shape'),
    });
    expect(() => createVerifiedLearningProposal({
      proposalId: 'bad', workspaceId: 'workspace-1',
      artifact: { kind: 'skill', slug: 'bad', baseVersion: '1', candidateVersion: '2' },
      candidateContent: 'Authorization: Bearer abcdefghijklmnop', passport: passport(),
      trustedProofPassportPublicKeySpki,
      trajectory: [{ eventSha256: hash('event'), kind: 'outcome', redacted: true }],
      signer: proposer, authority,
    })).toThrow(/secret-like/);
  });

  it('requires the Proof Passport to be signed by the trusted workspace issuer', () => {
    const untrustedKeys = generateKeyPairSync('ed25519');
    const forged = signProofPassport({
      schemaVersion: 1, passportId: 'passport-forged', missionId: 'mission-1', workspaceId: 'workspace-1',
      outcome: 'pass', completedAt: '2026-08-20T10:00:00.000Z', issuedAt: '2026-08-20T10:01:00.000Z',
      missionObjectiveSha256: hash('objective'), missionJournalSha256: hash('journal'), missionRevision: 2,
      criteria: [], evidence: [],
      privacy: { redacted: true, excluded: ['artifact-content', 'credentials'] },
    }, untrustedKeys.privateKey);
    expect(() => createVerifiedLearningProposal({
      proposalId: 'forged-learning', workspaceId: 'workspace-1',
      artifact: { kind: 'skill', slug: 'forged', baseVersion: '1', candidateVersion: '2' },
      candidateContent: 'A forged but otherwise well-formed candidate.',
      passport: forged,
      trustedProofPassportPublicKeySpki,
      trajectory: [{ eventSha256: hash('event'), kind: 'outcome', redacted: true }],
      signer: proposer,
      authority,
    })).toThrow('trusted issuer key');
  });

  it('fails closed without a host identity resolver and requires an attested, unexpired human reviewer', () => {
    const proposed = proposal();
    const evaluated = recordVerifiedLearningEval({
      history: [proposed], authority, gate: gate(), signer: evaluator,
      occurredAt: '2026-08-20T11:10:00.000Z',
    });

    expect(verifyVerifiedLearningHistory([proposed], {
      resolveKey,
      resolveIdentity: () => null,
    })).toMatchObject({ valid: false, reason: expect.stringContaining('unavailable') });

    const expiredAuthority: VerifiedLearningAuthority = {
      resolveKey,
      resolveIdentity: (actorId, keyId) => {
        const identity = authority.resolveIdentity(actorId, keyId);
        if (identity?.kind !== 'human') return identity;
        return {
          ...identity,
          humanAuthentication: { ...identity.humanAuthentication, expiresAt: '2026-08-20T11:19:59.999Z' },
        };
      },
    };
    expect(() => approveVerifiedLearningProposal({
      history: [proposed, evaluated], authority: expiredAuthority, rationale: 'Expired session', signer: reviewer,
      occurredAt: '2026-08-20T11:20:00.000Z',
    })).toThrow(/not valid at event time/);

    const servicePretendingToReview: VerifiedLearningAuthority = {
      resolveKey,
      resolveIdentity: (actorId, keyId) => actorId === reviewer.actorId && keyId === reviewer.keyId
        ? ({
          verificationStatus: 'host-resolved', kind: 'service', actorId, workspaceId: 'workspace-1',
          role: 'reviewer', active: true, keyIds: [keyId],
        } as unknown as HostVerifiedLearningIdentity)
        : authority.resolveIdentity(actorId, keyId),
    };
    expect(() => approveVerifiedLearningProposal({
      history: [proposed, evaluated], authority: servicePretendingToReview,
      rationale: 'Machine claims to be human', signer: reviewer,
      occurredAt: '2026-08-20T11:20:00.000Z',
    })).toThrow();
  });

  it('enforces three distinct proposer, evaluator and reviewer actor identities', () => {
    const proposed = proposal();
    const evaluated = recordVerifiedLearningEval({
      history: [proposed], authority, gate: gate(), signer: evaluator,
      occurredAt: '2026-08-20T11:10:00.000Z',
    });
    const evaluatorAsReviewer = { ...reviewer, actorId: evaluator.actorId };
    const equivocalAuthority: VerifiedLearningAuthority = {
      resolveKey: (keyId, actorId) => {
        if (keyId === reviewer.keyId && actorId === evaluator.actorId) return reviewerKeys.publicKey;
        return resolveKey(keyId, actorId);
      },
      resolveIdentity: (actorId, keyId) => {
        if (actorId === evaluator.actorId && keyId === reviewer.keyId) {
          return {
            verificationStatus: 'host-resolved', kind: 'human', actorId, workspaceId: 'workspace-1',
            role: 'reviewer', active: true, keyIds: [keyId],
            humanAuthentication: {
              assurance: 'host-attested', verifierId: 'workforce-idp',
              authenticatedAt: '2026-08-20T10:30:00.000Z', expiresAt: '2026-08-20T14:00:00.000Z',
            },
          };
        }
        return authority.resolveIdentity(actorId, keyId);
      },
    };
    expect(() => approveVerifiedLearningProposal({
      history: [proposed, evaluated], authority: equivocalAuthority,
      rationale: 'Same actor, alternate role', signer: evaluatorAsReviewer,
      occurredAt: '2026-08-20T11:20:00.000Z',
    })).toThrow(/independent/);
  });

  it('persists a signature-checked ledger and rejects stale writers', () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-learning-ledger-'));
    const path = join(root, '.robb', 'learning', 'learning-1.json');
    const store = new VerifiedLearningStore(path, authority);
    const proposed = proposal();
    expect(store.create(proposed)).toMatchObject({ state: 'proposed', automaticPublication: false });
    const evaluated = recordVerifiedLearningEval({
      history: [proposed], authority, gate: gate(), signer: evaluator,
      occurredAt: '2026-08-20T11:10:00.000Z',
    });
    expect(store.append(evaluated, 1)).toMatchObject({ state: 'evaluated' });
    expect(() => store.append(evaluated, 1)).toThrow(/sequence conflict/);
    expect(new VerifiedLearningStore(path, authority).read()).toHaveLength(2);

    writeFileSync(path, JSON.stringify({ schemaVersion: 1, events: [proposed], unexpected: true }));
    expect(() => store.read()).toThrow(/shape/);
    writeFileSync(path, JSON.stringify({ schemaVersion: 2, events: [proposed] }));
    expect(() => store.read()).toThrow(/shape/);
  });
});
