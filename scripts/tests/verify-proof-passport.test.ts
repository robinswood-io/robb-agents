import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  appendMissionEvents,
  MissionSpecSchema,
  readMissionEvents,
  signProofPassport,
  type SignedProofPassport,
  type UnsignedProofPassport,
} from '@craft-agent/shared/missions';

const REPOSITORY_ROOT = resolve(import.meta.dir, '../..');
const SCRIPT_PATH = resolve(import.meta.dir, '../verify-proof-passport.ts');
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'robb-proof-passport-cli-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function unsignedPassport(overrides: Partial<UnsignedProofPassport> = {}): UnsignedProofPassport {
  const hash = 'a'.repeat(64);
  return {
    schemaVersion: 1,
    passportId: 'mission-cli-r1',
    missionId: 'mission-cli',
    workspaceId: 'workspace-cli',
    outcome: 'pass',
    completedAt: '2026-08-20T10:00:00.000Z',
    issuedAt: '2026-08-20T10:00:01.000Z',
    missionObjectiveSha256: hash,
    missionJournalSha256: hash,
    missionRevision: 1,
    criteria: [],
    evidence: [],
    privacy: { redacted: true, excluded: ['credentials'] },
    ...overrides,
  };
}

function writePassport(
  directory: string,
  privateKey: KeyObject,
  unsigned = unsignedPassport(),
): {
  path: string;
  passport: SignedProofPassport;
} {
  const passport = signProofPassport(unsigned, privateKey);
  const path = join(directory, 'proof-passport.json');
  writeFileSync(path, `${JSON.stringify(passport)}\n`);
  return { path, passport };
}

function writeMissionJournal(workspaceRoot: string): string {
  const spec = MissionSpecSchema.parse({
    schemaVersion: 2,
    id: 'mission-cli',
    title: 'CLI verification mission',
    objective: 'Verify local artifacts',
    acceptanceCriteria: [{ id: 'mission-ok', description: 'Verified' }],
    plannerProfileId: 'planner',
    defaultWorkerProfileId: 'worker',
    reviewerProfileId: 'reviewer',
    supervisorProfileId: 'supervisor',
    agentProfiles: [
      { id: 'planner', role: 'planner', specialty: 'plan', systemPrompt: 'Plan.' },
      { id: 'worker', role: 'worker', specialty: 'work', systemPrompt: 'Work.' },
      { id: 'reviewer', role: 'reviewer', specialty: 'review', systemPrompt: 'Review.' },
      { id: 'supervisor', role: 'supervisor', specialty: 'supervise', systemPrompt: 'Supervise.' },
    ],
    workItems: [
      {
        id: 'objective', kind: 'objective', title: 'Objective',
        acceptanceCriteria: [{ id: 'objective-ok', description: 'Verified' }],
      },
      {
        id: 'task', kind: 'task', title: 'Task', prompt: 'Verify', objectiveId: 'objective',
        acceptanceCriteria: [{ id: 'task-ok', description: 'Verified' }],
      },
    ],
  });
  appendMissionEvents(workspaceRoot, spec.id, [{
    kind: 'mission-created', at: '2026-08-20T10:00:00.000Z', spec,
  }], 0);
  return createHash('sha256')
    .update(JSON.stringify(readMissionEvents(workspaceRoot, spec.id)))
    .digest('hex');
}

function runCli(args: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe('verify-proof-passport CLI trust policy', () => {
  it('rejects the passport embedded key as a self-declared identity', () => {
    const directory = temporaryDirectory();
    const issuer = generateKeyPairSync('ed25519');
    const { path } = writePassport(directory, issuer.privateKey);

    const result = runCli([path]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Identity verification requires an external trust anchor');
    expect(result.stderr).toContain("embedded public key is never\ntrusted automatically");
  });

  it('rejects a valid attacker signature when the external issuer SPKI differs', () => {
    const directory = temporaryDirectory();
    const attacker = generateKeyPairSync('ed25519');
    const trustedIssuer = generateKeyPairSync('ed25519');
    const { path } = writePassport(directory, attacker.privateKey);
    const trustedSpki = Buffer.from(trustedIssuer.publicKey.export({ format: 'der', type: 'spki' }))
      .toString('base64url');

    const result = runCli([path, '--trusted-spki', trustedSpki]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('signer does not match the trusted issuer key');
  });

  it('authenticates identity with a matching externally supplied SPKI', () => {
    const directory = temporaryDirectory();
    const issuer = generateKeyPairSync('ed25519');
    const { path, passport } = writePassport(directory, issuer.privateKey);
    const trustedSpki = Buffer.from(issuer.publicKey.export({ format: 'der', type: 'spki' }))
      .toString('base64url');

    const result = runCli([path, '--identity', '--trusted-spki', trustedSpki]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      valid: true,
      verificationMode: 'identity',
      identityVerified: true,
      passportId: passport.passportId,
    });
  });

  it('authenticates identity with a matching external PEM public key file', () => {
    const directory = temporaryDirectory();
    const issuer = generateKeyPairSync('ed25519');
    const { path } = writePassport(directory, issuer.privateKey);
    const publicKeyPath = join(directory, 'trusted-issuer-public-key.pem');
    writeFileSync(publicKeyPath, issuer.publicKey.export({ format: 'pem', type: 'spki' }));

    const result = runCli([path, '--trusted-public-key', publicKeyPath]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      valid: true,
      verificationMode: 'identity',
      identityVerified: true,
    });
  });

  it('labels self-contained verification as integrity-only and warns about identity', () => {
    const directory = temporaryDirectory();
    const issuer = generateKeyPairSync('ed25519');
    const { path } = writePassport(directory, issuer.privateKey);

    const result = runCli([path, '--integrity-only']);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('does not authenticate signer identity');
    expect(JSON.parse(result.stdout)).toMatchObject({
      valid: true,
      verificationMode: 'integrity-only',
      identityVerified: false,
    });
  });

  it('rehashes the confined Mission journal and workspace evidence on request', () => {
    const workspaceRoot = temporaryDirectory();
    const issuer = generateKeyPairSync('ed25519');
    const evidence = Buffer.from('verified workspace artifact\n');
    writeFileSync(join(workspaceRoot, 'report.txt'), evidence);
    const missionJournalSha256 = writeMissionJournal(workspaceRoot);
    const { path } = writePassport(workspaceRoot, issuer.privateKey, unsignedPassport({
      missionJournalSha256,
      evidence: [{
        workItemId: 'task',
        requirementId: 'report',
        kind: 'artifact',
        uri: 'workspace:///report.txt',
        sha256: createHash('sha256').update(evidence).digest('hex'),
        sizeBytes: evidence.length,
        observedAt: '2026-08-20T10:00:01.000Z',
        provenance: 'workspace-file',
      }],
    }));
    const trustedSpki = Buffer.from(issuer.publicKey.export({ format: 'der', type: 'spki' }))
      .toString('base64url');

    const result = runCli([
      path,
      '--trusted-spki',
      trustedSpki,
      '--workspace-root',
      workspaceRoot,
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      identityVerified: true,
      workspaceRevalidation: {
        journalVerified: true,
        workspaceEvidenceVerified: 1,
        nonWorkspaceEvidenceSkipped: 0,
      },
    });
  });

  it('fails workspace revalidation when a signed evidence artifact changed', () => {
    const workspaceRoot = temporaryDirectory();
    const issuer = generateKeyPairSync('ed25519');
    const original = Buffer.from('original');
    const evidencePath = join(workspaceRoot, 'report.txt');
    writeFileSync(evidencePath, original);
    const { path } = writePassport(workspaceRoot, issuer.privateKey, unsignedPassport({
      missionJournalSha256: writeMissionJournal(workspaceRoot),
      evidence: [{
        workItemId: 'task', requirementId: 'report', kind: 'artifact',
        uri: 'workspace:///report.txt',
        sha256: createHash('sha256').update(original).digest('hex'),
        sizeBytes: original.length,
        observedAt: '2026-08-20T10:00:01.000Z', provenance: 'workspace-file',
      }],
    }));
    writeFileSync(evidencePath, 'tampered');
    const trustedSpki = Buffer.from(issuer.publicKey.export({ format: 'der', type: 'spki' }))
      .toString('base64url');

    const result = runCli([
      path, '--trusted-spki', trustedSpki, '--workspace-root', workspaceRoot,
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('does not match the passport');
  });

  it('rejects non-Ed25519 and ambiguous trust configuration', () => {
    const directory = temporaryDirectory();
    const issuer = generateKeyPairSync('ed25519');
    const rsaIssuer = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const { path } = writePassport(directory, issuer.privateKey);
    const rsaPublicKeyPath = join(directory, 'rsa-public-key.pem');
    writeFileSync(rsaPublicKeyPath, rsaIssuer.publicKey.export({ format: 'pem', type: 'spki' }));

    const wrongAlgorithm = runCli([path, '--trusted-public-key', rsaPublicKeyPath]);
    expect(wrongAlgorithm.status).toBe(1);
    expect(wrongAlgorithm.stderr).toContain('must be Ed25519');

    const ambiguous = runCli([
      path,
      '--integrity-only',
      '--trusted-spki',
      'not-an-embedded-key-fallback',
    ]);
    expect(ambiguous.status).toBe(2);
    expect(ambiguous.stderr).toContain('Trust anchors cannot be combined with --integrity-only');
  });
});
