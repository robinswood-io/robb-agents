import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  randomUUID,
} from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  SignedProofPassportSchema,
  ProofPassportTrustAnchorSchema,
  missionDir,
  readMissionEvents,
  signProofPassport,
  verifyProofPassport,
  type MissionSnapshot,
  type ProofPassportTrustAnchor,
  type SignedProofPassport,
  type UnsignedProofPassport,
} from '@craft-agent/shared/missions';
import { resolveMissionSubmissionEvidence } from './MissionEvidenceResolver.ts';

const PASSPORT_FILE = 'proof-passport.json';

const sha256 = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');

function passportPath(workspaceRoot: string, missionId: string): string {
  return join(missionDir(workspaceRoot, missionId), PASSPORT_FILE);
}

function assertPassportBinding(
  passport: SignedProofPassport,
  missionId: string,
  workspaceId: string,
): void {
  if (passport.missionId !== missionId) {
    throw new Error(
      `Stored Proof Passport mission binding is invalid: expected "${missionId}", found "${passport.missionId}"`,
    );
  }
  if (passport.workspaceId !== workspaceId) {
    throw new Error(
      `Stored Proof Passport workspace binding is invalid: expected "${workspaceId}", found "${passport.workspaceId}"`,
    );
  }
}

function proofPassportTrustAnchor(
  workspaceId: string,
  privateKeyValue: KeyObject | string | Uint8Array,
): ProofPassportTrustAnchor {
  const privateKey = privateKeyValue instanceof KeyObject
    ? privateKeyValue
    : typeof privateKeyValue === 'string' && privateKeyValue.includes('BEGIN PRIVATE KEY')
      ? createPrivateKey(privateKeyValue)
      : createPrivateKey({ key: Buffer.from(privateKeyValue), format: 'der', type: 'pkcs8' });
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Proof Passport signing key must be Ed25519');
  }
  const publicKey = createPublicKey(privateKey);
  const publicKeyDer = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }));
  return ProofPassportTrustAnchorSchema.parse({
    schemaVersion: 1,
    workspaceId,
    algorithm: 'Ed25519',
    publicKeySpki: publicKeyDer.toString('base64url'),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    fingerprintSha256: sha256(publicKeyDer),
  });
}

function writeAtomic(path: string, value: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const descriptor = openSync(temporary, 'r');
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* rename or an earlier failure already handled it */ }
  }
}

export interface MissionProofPassportServiceOptions {
  workspaceId: string;
  workspaceRoot: string;
  privateKey: KeyObject | string | Uint8Array;
  now?: () => string;
}

/** Host-only issuer for redacted, independently verifiable mission outcome evidence. */
export class MissionProofPassportService {
  private readonly now: () => string;
  private readonly trustAnchor: ProofPassportTrustAnchor;

  constructor(private readonly options: MissionProofPassportServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.trustAnchor = proofPassportTrustAnchor(options.workspaceId, options.privateKey);
  }

  /** Return only the public issuer identity; private signing material never crosses this boundary. */
  getTrustAnchor(): ProofPassportTrustAnchor {
    return { ...this.trustAnchor };
  }

  issue(snapshot: MissionSnapshot): SignedProofPassport {
    if (snapshot.status !== 'completed') {
      throw new Error(`Proof Passport requires a completed mission, found ${snapshot.status}`);
    }
    const existing = this.read(snapshot.spec.id);
    if (existing) {
      if (existing.missionId !== snapshot.spec.id) throw new Error('Stored Proof Passport mission binding is invalid');
      const decision = verifyProofPassport(existing, this.trustAnchor.publicKeySpki);
      if (!decision.valid) throw new Error(`Stored Proof Passport is invalid: ${decision.reason}`);
      return existing;
    }

    const issuedAt = this.now();
    const evidence = Object.values(snapshot.workItems)
      .filter((runtime) => runtime.submission && runtime.status !== 'superseded')
      .flatMap((runtime) => resolveMissionSubmissionEvidence({
        workspaceRoot: this.options.workspaceRoot,
        item: runtime.definition,
        submission: runtime.submission!,
        observedAt: issuedAt,
      }).evidence);
    const evidenceIdsByWorkItem = new Map<string, string[]>();
    for (const item of Object.values(snapshot.workItems)) {
      evidenceIdsByWorkItem.set(item.definition.id, item.definition.requiredEvidence.map(({ id }) => id));
    }
    const allEvidenceIds = evidence.map(({ requirementId }) => requirementId);
    const criteria: UnsignedProofPassport['criteria'] = [
      ...snapshot.spec.acceptanceCriteria.map((criterion) => ({
        workItemId: 'mission',
        criterionId: criterion.id,
        descriptionSha256: sha256(criterion.description),
        evidenceRequirementIds: [...new Set(allEvidenceIds)].sort(),
      })),
      ...Object.values(snapshot.workItems).flatMap((runtime) =>
        runtime.definition.acceptanceCriteria.map((criterion) => ({
          workItemId: runtime.definition.id,
          criterionId: criterion.id,
          descriptionSha256: sha256(criterion.description),
          evidenceRequirementIds: evidenceIdsByWorkItem.get(runtime.definition.id) ?? [],
        }))),
    ];
    const journal = readMissionEvents(this.options.workspaceRoot, snapshot.spec.id);
    const unsigned: UnsignedProofPassport = {
      schemaVersion: 1,
      passportId: `${snapshot.spec.id}-r${snapshot.revision}`,
      missionId: snapshot.spec.id,
      workspaceId: this.options.workspaceId,
      outcome: 'pass',
      completedAt: snapshot.updatedAt,
      issuedAt,
      missionObjectiveSha256: sha256(snapshot.spec.objective),
      missionJournalSha256: sha256(JSON.stringify(journal)),
      missionRevision: snapshot.revision,
      criteria,
      evidence,
      privacy: {
        redacted: true,
        excluded: [
          'artifact-content',
          'absolute-paths',
          'credentials',
          'model-messages',
          'provider-responses',
        ],
      },
    };
    const passport = signProofPassport(unsigned, this.options.privateKey);
    writeAtomic(passportPath(this.options.workspaceRoot, snapshot.spec.id), `${JSON.stringify(passport, null, 2)}\n`);
    return passport;
  }

  read(missionId: string): SignedProofPassport | null {
    const path = passportPath(this.options.workspaceRoot, missionId);
    if (!existsSync(path)) return null;
    const passport = SignedProofPassportSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    assertPassportBinding(passport, missionId, this.options.workspaceId);
    return passport;
  }

  verify(missionId: string): ReturnType<typeof verifyProofPassport> {
    try {
      const passport = this.read(missionId);
      return passport
        ? verifyProofPassport(passport, this.trustAnchor.publicKeySpki)
        : { valid: false, reason: `Proof Passport for mission "${missionId}" does not exist` };
    } catch (cause) {
      return {
        valid: false,
        reason: cause instanceof Error ? cause.message : 'Proof Passport could not be read safely',
      };
    }
  }
}
