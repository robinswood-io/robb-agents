import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import {
  MissionSpecSchema,
  signProofPassport,
  verifyProofPassport,
  type MissionSpec,
  type StructuredMissionVerdict,
  type WorkSubmission,
} from '@craft-agent/shared/missions';
import { MissionController } from './MissionController.ts';
import { MissionProofPassportService } from './MissionProofPassportService.ts';
import { resolveMissionSubmissionEvidence } from './MissionEvidenceResolver.ts';

function fixture(): MissionSpec {
  return MissionSpecSchema.parse({
    schemaVersion: 2,
    id: 'mission-demo', title: 'Mission demo', objective: 'Deliver a verified result',
    acceptanceCriteria: [{ id: 'mission-ok', description: 'Mission passes' }],
    plannerProfileId: 'planner', defaultWorkerProfileId: 'worker',
    reviewerProfileId: 'reviewer', supervisorProfileId: 'supervisor',
    agentProfiles: [
      { id: 'planner', role: 'planner', specialty: 'plan', systemPrompt: 'Plan.' },
      { id: 'worker', role: 'worker', specialty: 'work', systemPrompt: 'Work.' },
      { id: 'reviewer', role: 'reviewer', specialty: 'quality', systemPrompt: 'Review.' },
      { id: 'supervisor', role: 'supervisor', specialty: 'global', systemPrompt: 'Supervise.' },
    ],
    workItems: [
      {
        id: 'objective-one', kind: 'objective', title: 'Objective',
        acceptanceCriteria: [{ id: 'objective-ok', description: 'Objective passes' }],
      },
      {
        id: 'task-a', kind: 'task', title: 'Task A', prompt: 'Run test A',
        objectiveId: 'objective-one', dependsOn: [],
        acceptanceCriteria: [{ id: 'task-ok', description: 'Task passes' }],
        requiredEvidence: [{ id: 'test-a', description: 'Test A', kind: 'test' }],
      },
    ],
  });
}

function verdict(targetType: 'objective' | 'mission'): StructuredMissionVerdict {
  const mission = targetType === 'mission';
  return {
    targetType,
    targetId: mission ? 'mission-demo' : 'objective-one',
    result: 'pass',
    summary: 'Pass',
    criteria: [{
      criterionId: mission ? 'mission-ok' : 'objective-ok',
      result: 'pass', evidenceRefs: ['workspace:///test-a.txt'], explanation: 'Verified',
    }],
    affectedWorkItemIds: [], corrections: [],
  };
}

function completeMission(controller: MissionController, submission: WorkSubmission) {
  controller.dispatchWorkItem('mission-demo', 'task-a', 'worker-session');
  controller.submitWorkItem('mission-demo', 'task-a', 'worker-session', submission);
  const objectiveReview = controller.listReadyWork('mission-demo')[0]!.item.id;
  controller.dispatchWorkItem('mission-demo', objectiveReview, 'reviewer-session');
  controller.recordVerdict('mission-demo', objectiveReview, 'reviewer-session', verdict('objective'));
  const finalReview = controller.listReadyWork('mission-demo')[0]!.item.id;
  controller.dispatchWorkItem('mission-demo', finalReview, 'supervisor-session');
  return controller.recordVerdict('mission-demo', finalReview, 'supervisor-session', verdict('mission'));
}

const submissionA: WorkSubmission = {
  summary: 'Done', outputRefs: [],
  evidence: [{ requirementId: 'test-a', uri: 'test-a.txt', kind: 'test' }],
};

describe('MissionProofPassportService', () => {
  it('exports only the canonical public Ed25519 workspace trust anchor', () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-passport-anchor-'));
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const service = new MissionProofPassportService({
      workspaceId: 'workspace-anchor', workspaceRoot: root, privateKey,
    });
    const publicKeyDer = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }));
    const privateKeyDer = Buffer.from(privateKey.export({ format: 'der', type: 'pkcs8' })).toString('base64url');

    expect(service.getTrustAnchor()).toEqual({
      schemaVersion: 1,
      workspaceId: 'workspace-anchor',
      algorithm: 'Ed25519',
      publicKeySpki: publicKeyDer.toString('base64url'),
      publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      fingerprintSha256: createHash('sha256').update(publicKeyDer).digest('hex'),
    });
    expect(JSON.stringify(service.getTrustAnchor())).not.toContain(privateKeyDer);
    expect(JSON.stringify(service.getTrustAnchor())).not.toContain('PRIVATE KEY');
  });

  it('persists a redacted passport and detects later envelope tampering', () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-passport-'));
    writeFileSync(join(root, 'test-a.txt'), 'passed\n');
    const controller = new MissionController({
      workspaceRoot: root,
      now: () => new Date('2026-08-20T10:00:00.000Z'),
      resolveSubmissionEvidence: (item, submission) => resolveMissionSubmissionEvidence({
        workspaceRoot: root, item, submission, observedAt: '2026-08-20T10:00:00.000Z',
      }).submission,
    });
    controller.createMission(fixture());
    controller.startMission('mission-demo');
    const completed = completeMission(controller, {
      ...submissionA,
      evidence: [{ requirementId: 'test-a', uri: 'test-a.txt', kind: 'test' }],
    });
    const { privateKey } = generateKeyPairSync('ed25519');
    const service = new MissionProofPassportService({
      workspaceId: 'workspace-1', workspaceRoot: root, privateKey,
      now: () => '2026-08-20T10:00:01.000Z',
    });
    const passport = service.issue(completed);
    expect(verifyProofPassport(passport).valid).toBe(true);
    expect(JSON.stringify(passport)).not.toContain(root);
    expect(JSON.stringify(passport)).not.toContain('passed');
    expect(passport.evidence[0]).toMatchObject({ uri: 'workspace:///test-a.txt' });

    const path = join(root, 'missions', 'mission-demo', 'proof-passport.json');
    const altered = JSON.parse(readFileSync(path, 'utf8'));
    altered.missionRevision += 1;
    writeFileSync(path, JSON.stringify(altered));
    expect(() => service.issue(completed)).toThrow('signature is invalid');
  });

  it('refuses to issue if a previously accepted artifact changed', () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-passport-change-'));
    writeFileSync(join(root, 'test-a.txt'), 'passed\n');
    const controller = new MissionController({
      workspaceRoot: root,
      resolveSubmissionEvidence: (item, submission) => resolveMissionSubmissionEvidence({
        workspaceRoot: root, item, submission,
      }).submission,
    });
    controller.createMission(fixture());
    controller.startMission('mission-demo');
    const completed = completeMission(controller, {
      ...submissionA,
      evidence: [{ requirementId: 'test-a', uri: 'test-a.txt', kind: 'test' }],
    });
    writeFileSync(join(root, 'test-a.txt'), 'changed\n');
    const { privateKey } = generateKeyPairSync('ed25519');
    const service = new MissionProofPassportService({
      workspaceId: 'workspace-1', workspaceRoot: root, privateKey,
    });
    expect(() => service.issue(completed)).toThrow('does not match');
  });

  it('rejects a self-signed passport from an untrusted workspace key', () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-passport-untrusted-'));
    writeFileSync(join(root, 'test-a.txt'), 'passed\n');
    const controller = new MissionController({
      workspaceRoot: root,
      resolveSubmissionEvidence: (item, submission) => resolveMissionSubmissionEvidence({
        workspaceRoot: root, item, submission,
      }).submission,
    });
    controller.createMission(fixture());
    controller.startMission('mission-demo');
    const completed = completeMission(controller, submissionA);
    const attacker = generateKeyPairSync('ed25519');
    const trusted = generateKeyPairSync('ed25519');
    const attackerService = new MissionProofPassportService({
      workspaceId: 'workspace-1', workspaceRoot: root, privateKey: attacker.privateKey,
    });
    const forged = attackerService.issue(completed);
    expect(verifyProofPassport(forged).valid).toBe(true);

    const trustedService = new MissionProofPassportService({
      workspaceId: 'workspace-1', workspaceRoot: root, privateKey: trusted.privateKey,
    });
    expect(trustedService.verify('mission-demo')).toEqual({
      valid: false,
      reason: 'Proof Passport signer does not match the trusted issuer key',
    });
    expect(() => trustedService.issue(completed)).toThrow('trusted issuer key');
  });

  it('rejects valid signed passports copied across mission or workspace bindings', () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-passport-binding-'));
    const { privateKey } = generateKeyPairSync('ed25519');
    const passport = signProofPassport({
      schemaVersion: 1,
      passportId: 'mission-alpha-r1',
      missionId: 'mission-alpha',
      workspaceId: 'workspace-alpha',
      outcome: 'pass',
      completedAt: '2026-08-20T10:00:00.000Z',
      issuedAt: '2026-08-20T10:00:01.000Z',
      missionObjectiveSha256: 'a'.repeat(64),
      missionJournalSha256: 'b'.repeat(64),
      missionRevision: 1,
      criteria: [],
      evidence: [],
      privacy: { redacted: true, excluded: ['credentials'] },
    }, privateKey);
    expect(verifyProofPassport(passport).valid).toBe(true);

    const missionAlphaDir = join(root, 'missions', 'mission-alpha');
    const missionBetaDir = join(root, 'missions', 'mission-beta');
    mkdirSync(missionAlphaDir, { recursive: true });
    mkdirSync(missionBetaDir, { recursive: true });
    writeFileSync(join(missionAlphaDir, 'proof-passport.json'), JSON.stringify(passport));
    writeFileSync(join(missionBetaDir, 'proof-passport.json'), JSON.stringify(passport));

    const correctlyScopedService = new MissionProofPassportService({
      workspaceId: 'workspace-alpha', workspaceRoot: root, privateKey,
    });
    expect(correctlyScopedService.read('mission-alpha')).toEqual(passport);
    expect(correctlyScopedService.verify('mission-alpha')).toMatchObject({ valid: true });
    expect(() => correctlyScopedService.read('mission-beta')).toThrow('mission binding is invalid');
    expect(correctlyScopedService.verify('mission-beta')).toMatchObject({
      valid: false,
      reason: expect.stringContaining('mission binding is invalid'),
    });

    const foreignWorkspaceService = new MissionProofPassportService({
      workspaceId: 'workspace-beta', workspaceRoot: root, privateKey,
    });
    expect(() => foreignWorkspaceService.read('mission-alpha')).toThrow('workspace binding is invalid');
    expect(foreignWorkspaceService.verify('mission-alpha')).toMatchObject({
      valid: false,
      reason: expect.stringContaining('workspace binding is invalid'),
    });
  });
});
