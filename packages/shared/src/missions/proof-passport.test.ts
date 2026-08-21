import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import {
  signProofPassport,
  verifyProofPassport,
  type UnsignedProofPassport,
} from './proof-passport.ts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

function unsigned(): UnsignedProofPassport {
  return {
    schemaVersion: 1,
    passportId: 'mission-demo-2026-08-20',
    missionId: 'mission-demo',
    workspaceId: 'workspace-1',
    outcome: 'pass',
    completedAt: '2026-08-20T10:00:00.000Z',
    issuedAt: '2026-08-20T10:00:01.000Z',
    missionObjectiveSha256: sha('objective'),
    missionJournalSha256: sha('journal'),
    missionRevision: 12,
    criteria: [{
      workItemId: 'task-a',
      criterionId: 'criterion-a',
      descriptionSha256: sha('criterion'),
      evidenceRequirementIds: ['proof-a'],
    }],
    evidence: [{
      workItemId: 'task-a',
      requirementId: 'proof-a',
      kind: 'test',
      uri: 'workspace:///reports/test.json',
      sha256: sha('artifact'),
      sizeBytes: 8,
      observedAt: '2026-08-20T10:00:00.000Z',
      provenance: 'workspace-file',
    }],
    privacy: {
      redacted: true,
      excluded: ['artifact-content', 'absolute-paths', 'credentials'],
    },
  };
}

describe('Proof Passport', () => {
  it('signs and verifies a self-contained Ed25519 passport', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const passport = signProofPassport(unsigned(), privateKey);
    expect(verifyProofPassport(passport)).toEqual({ valid: true, passport });
  });

  it('detects an altered outcome envelope', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const passport = signProofPassport(unsigned(), privateKey);
    const altered = { ...passport, missionRevision: passport.missionRevision + 1 };
    expect(verifyProofPassport(altered)).toEqual({
      valid: false,
      reason: 'Proof Passport signature is invalid',
    });
  });

  it('rejects a non-Ed25519 private key', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => signProofPassport(unsigned(), privateKey)).toThrow('must be Ed25519');
  });
});
