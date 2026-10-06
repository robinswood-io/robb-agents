import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  randomUUID,
  sign as signBytes,
  verify as verifyBytes,
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
  reduceMissionEvents,
  signProofPassport,
  verifyProofPassport,
  type MissionSnapshot,
  type ProofPassportTrustAnchor,
  type SignedProofPassport,
  type UnsignedProofPassport,
} from '@craft-agent/shared/missions';
import { z } from 'zod';
import { resolveMissionSubmissionEvidence } from './MissionEvidenceResolver.ts';

const PASSPORT_FILE = 'proof-passport.json';
const TERMINAL_ATTESTATION_FILE = 'mission-terminal-attestation.json';

const SignedMissionTerminalAttestationSchema = z.object({
  schemaVersion: z.literal(1),
  attestationId: z.string().min(1),
  missionId: z.string().min(1),
  workspaceId: z.string().min(1),
  outcome: z.enum(['pass', 'fail']),
  terminalStatus: z.enum(['completed', 'failed']),
  terminalAt: z.string().datetime(),
  issuedAt: z.string().datetime(),
  missionObjectiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
  missionJournalSha256: z.string().regex(/^[a-f0-9]{64}$/),
  missionRevision: z.number().int().positive(),
  signature: z.object({
    algorithm: z.literal('Ed25519'),
    publicKeySpki: z.string().min(1),
    value: z.string().min(1),
  }).strict(),
}).strict();

type SignedMissionTerminalAttestation = z.infer<typeof SignedMissionTerminalAttestationSchema>;

const sha256 = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');

function privateKeyFrom(value: KeyObject | string | Uint8Array): KeyObject {
  if (value instanceof KeyObject) return value;
  return typeof value === 'string' && value.includes('BEGIN PRIVATE KEY')
    ? createPrivateKey(value)
    : createPrivateKey({ key: Buffer.from(value), format: 'der', type: 'pkcs8' });
}

function passportPath(workspaceRoot: string, missionId: string): string {
  return join(missionDir(workspaceRoot, missionId), PASSPORT_FILE);
}

function terminalAttestationPath(workspaceRoot: string, missionId: string): string {
  return join(missionDir(workspaceRoot, missionId), TERMINAL_ATTESTATION_FILE);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

function unsignedTerminalAttestation(
  attestation: SignedMissionTerminalAttestation,
): Omit<SignedMissionTerminalAttestation, 'signature'> {
  const { signature: _signature, ...unsigned } = attestation;
  return unsigned;
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
  const privateKey = privateKeyFrom(privateKeyValue);
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

  /**
   * Persist an issuer-authenticated terminal outcome for both positive and
   * negative evaluation cases. Unlike a Proof Passport, this attestation does
   * not claim that acceptance criteria passed.
   */
  issueTerminalAttestation(snapshot: MissionSnapshot): SignedMissionTerminalAttestation {
    if (snapshot.status !== 'completed' && snapshot.status !== 'failed') {
      throw new Error(`Terminal Mission attestation requires completed or failed, found ${snapshot.status}`);
    }
    const existing = this.readTerminalAttestation(snapshot.spec.id);
    if (existing) {
      const verified = this.verifyTerminalSnapshot(snapshot.spec.id);
      if (!verified.valid) throw new Error(`Stored terminal Mission attestation is invalid: ${verified.reason}`);
      if (verified.snapshot.revision > snapshot.revision
        || verified.snapshot.status !== snapshot.status
        || verified.snapshot.spec.objective !== snapshot.spec.objective) {
        throw new Error('Stored terminal Mission attestation targets another outcome revision');
      }
      return existing;
    }
    const events = readMissionEvents(this.options.workspaceRoot, snapshot.spec.id);
    if (events.length !== snapshot.revision) {
      throw new Error('Terminal Mission journal revision changed before attestation');
    }
    const replayed = reduceMissionEvents(events);
    if (replayed.revision !== snapshot.revision
      || replayed.status !== snapshot.status
      || replayed.updatedAt !== snapshot.updatedAt
      || replayed.spec.objective !== snapshot.spec.objective) {
      throw new Error('Terminal Mission snapshot does not match its persisted journal');
    }
    const privateKey = privateKeyFrom(this.options.privateKey);
    const unsigned = {
      schemaVersion: 1 as const,
      attestationId: `${snapshot.spec.id}-r${snapshot.revision}-${snapshot.status}`,
      missionId: snapshot.spec.id,
      workspaceId: this.options.workspaceId,
      outcome: snapshot.status === 'completed' ? 'pass' as const : 'fail' as const,
      terminalStatus: snapshot.status,
      terminalAt: snapshot.updatedAt,
      issuedAt: this.now(),
      missionObjectiveSha256: sha256(snapshot.spec.objective),
      missionJournalSha256: sha256(JSON.stringify(events)),
      missionRevision: snapshot.revision,
    };
    const signature = signBytes(null, Buffer.from(canonicalize(unsigned), 'utf8'), privateKey);
    const attestation = SignedMissionTerminalAttestationSchema.parse({
      ...unsigned,
      signature: {
        algorithm: 'Ed25519',
        publicKeySpki: this.trustAnchor.publicKeySpki,
        value: signature.toString('base64url'),
      },
    });
    writeAtomic(
      terminalAttestationPath(this.options.workspaceRoot, snapshot.spec.id),
      `${JSON.stringify(attestation, null, 2)}\n`,
    );
    return attestation;
  }

  readTerminalAttestation(missionId: string): SignedMissionTerminalAttestation | null {
    const path = terminalAttestationPath(this.options.workspaceRoot, missionId);
    if (!existsSync(path)) return null;
    const attestation = SignedMissionTerminalAttestationSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (attestation.missionId !== missionId || attestation.workspaceId !== this.options.workspaceId) {
      throw new Error('Stored terminal Mission attestation binding is invalid');
    }
    return attestation;
  }

  verifyTerminalSnapshot(missionId: string):
    | { valid: true; attestation: SignedMissionTerminalAttestation; snapshot: MissionSnapshot }
    | { valid: false; reason: string } {
    try {
      const attestation = this.readTerminalAttestation(missionId);
      if (!attestation) return { valid: false, reason: `Terminal Mission attestation for "${missionId}" does not exist` };
      if (attestation.signature.publicKeySpki !== this.trustAnchor.publicKeySpki) {
        return { valid: false, reason: 'Terminal Mission attestation signer is not trusted' };
      }
      const signatureValid = verifyBytes(
        null,
        Buffer.from(canonicalize(unsignedTerminalAttestation(attestation)), 'utf8'),
        createPublicKey({
          key: Buffer.from(attestation.signature.publicKeySpki, 'base64url'),
          format: 'der',
          type: 'spki',
        }),
        Buffer.from(attestation.signature.value, 'base64url'),
      );
      if (!signatureValid) return { valid: false, reason: 'Terminal Mission attestation signature is invalid' };
      const events = readMissionEvents(this.options.workspaceRoot, missionId);
      if (events.length < attestation.missionRevision) {
        return { valid: false, reason: 'Mission journal is shorter than its terminal attestation revision' };
      }
      const authenticatedEvents = events.slice(0, attestation.missionRevision);
      if (sha256(JSON.stringify(authenticatedEvents)) !== attestation.missionJournalSha256) {
        return { valid: false, reason: 'Mission journal no longer matches its terminal attestation' };
      }
      const snapshot = reduceMissionEvents(authenticatedEvents);
      if (snapshot.spec.id !== attestation.missionId
        || snapshot.revision !== attestation.missionRevision
        || snapshot.status !== attestation.terminalStatus
        || snapshot.updatedAt !== attestation.terminalAt
        || sha256(snapshot.spec.objective) !== attestation.missionObjectiveSha256
        || (snapshot.status === 'completed' ? 'pass' : 'fail') !== attestation.outcome) {
        return { valid: false, reason: 'Mission snapshot does not match its terminal attestation claims' };
      }
      return { valid: true, attestation, snapshot };
    } catch (cause) {
      return {
        valid: false,
        reason: cause instanceof Error ? cause.message : 'Terminal Mission attestation could not be verified',
      };
    }
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

  /**
   * Replays the exact journal prefix authenticated by the passport. Later
   * report-delivery events are intentionally excluded: the completed Mission
   * outcome and its execution bindings are frozen at passport issuance.
   */
  verifySnapshot(missionId: string):
    | { valid: true; passport: SignedProofPassport; snapshot: MissionSnapshot }
    | { valid: false; reason: string } {
    const decision = this.verify(missionId);
    if (!decision.valid) return decision;
    try {
      const events = readMissionEvents(this.options.workspaceRoot, missionId);
      if (events.length < decision.passport.missionRevision) {
        return { valid: false, reason: 'Mission journal is shorter than its signed Proof Passport revision' };
      }
      const authenticatedEvents = events.slice(0, decision.passport.missionRevision);
      if (sha256(JSON.stringify(authenticatedEvents)) !== decision.passport.missionJournalSha256) {
        return { valid: false, reason: 'Mission journal no longer matches its signed Proof Passport' };
      }
      const snapshot = reduceMissionEvents(authenticatedEvents);
      if (snapshot.spec.id !== decision.passport.missionId
        || snapshot.revision !== decision.passport.missionRevision
        || snapshot.status !== 'completed'
        || snapshot.updatedAt !== decision.passport.completedAt
        || sha256(snapshot.spec.objective) !== decision.passport.missionObjectiveSha256) {
        return { valid: false, reason: 'Mission snapshot does not match its signed Proof Passport claims' };
      }
      return { valid: true, passport: decision.passport, snapshot };
    } catch (cause) {
      return {
        valid: false,
        reason: cause instanceof Error ? cause.message : 'Mission Proof Passport snapshot could not be replayed',
      };
    }
  }
}
