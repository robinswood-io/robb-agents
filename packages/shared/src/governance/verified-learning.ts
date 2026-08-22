import {
  KeyObject,
  createHash,
  createPrivateKey,
  sign as signBytes,
  verify as verifyBytes,
} from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { EvalGateResult } from '../evals/eval-gate.ts';
import {
  verifyProofPassport,
  type SignedProofPassport,
} from '../missions/proof-passport.ts';
import { redactSecretLikeMaterial } from '../utils/redaction.ts';
import { atomicWriteFileSync } from '../utils/files.ts';

const SHA256 = /^[a-f0-9]{64}$/;
const BASE64URL_ED25519_SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const identifier = (label: string) => z.string().trim().min(1, `${label} is required`).max(256);
const version = z.string().trim().min(1).max(128);

export const LearningTrajectorySourceSchema = z.object({
  eventSha256: z.string().regex(SHA256),
  kind: z.enum(['decision', 'tool-result', 'critique', 'outcome']),
  redacted: z.literal(true),
}).strict();
export type LearningTrajectorySource = z.infer<typeof LearningTrajectorySourceSchema>;

const LearningTrajectorySchema = z.array(LearningTrajectorySourceSchema).min(1).max(10_000)
  .superRefine((sources, ctx) => {
    const hashes = new Set<string>();
    for (let index = 0; index < sources.length; index += 1) {
      const hash = sources[index]!.eventSha256;
      if (hashes.has(hash)) {
        ctx.addIssue({ code: 'custom', path: [index, 'eventSha256'], message: 'Learning trajectory hashes must be unique' });
      }
      hashes.add(hash);
    }
  });

export const VerifiedLearningProposalSchema = z.object({
  schemaVersion: z.literal(1),
  proposalId: identifier('Proposal id'),
  workspaceId: identifier('Workspace id'),
  artifact: z.object({
    kind: z.enum(['playbook', 'skill']),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(128),
    baseVersion: version,
    candidateVersion: version,
    candidateContentSha256: z.string().regex(SHA256),
  }).strict().refine((artifact) => artifact.baseVersion !== artifact.candidateVersion, {
    message: 'Candidate version must differ from base version', path: ['candidateVersion'],
  }),
  provenance: z.object({
    missionId: identifier('Mission id'),
    proofPassportId: identifier('Proof Passport id'),
    proofPassportSha256: z.string().regex(SHA256),
    trajectory: LearningTrajectorySchema,
  }).strict(),
  privacy: z.object({
    redacted: z.literal(true),
    secretScanPassed: z.literal(true),
    candidateContentStored: z.literal(false),
  }).strict(),
  createdAt: z.string().datetime(),
}).strict();
export type VerifiedLearningProposal = z.infer<typeof VerifiedLearningProposalSchema>;

export type VerifiedLearningAction =
  | 'proposed'
  | 'eval-passed'
  | 'human-approved'
  | 'canary-passed'
  | 'canary-failed'
  | 'rolled-back'
  | 'revoked';

const LearningSignatureSchema = z.object({
  algorithm: z.literal('Ed25519'),
  keyId: identifier('Learning key id'),
  value: z.string().regex(BASE64URL_ED25519_SIGNATURE),
}).strict();

const LearningEventBaseSchema = z.object({
  schemaVersion: z.literal(1),
  sequence: z.number().int().positive(),
  proposalId: identifier('Proposal id'),
  actorId: identifier('Actor id'),
  occurredAt: z.string().datetime(),
  previousHash: z.string().regex(SHA256).nullable(),
  signature: LearningSignatureSchema,
}).strict();

export const VerifiedLearningEventSchema = z.discriminatedUnion('action', [
  LearningEventBaseSchema.extend({
    action: z.literal('proposed'),
    payload: z.object({ proposal: VerifiedLearningProposalSchema }).strict(),
  }),
  LearningEventBaseSchema.extend({
    action: z.literal('eval-passed'),
    payload: z.object({
      evalRunId: identifier('Eval run id'),
      evalReportSha256: z.string().regex(SHA256),
      baselineRunId: identifier('Baseline run id').optional(),
      passRate: z.number().min(0).max(1),
      policyComplianceRate: z.number().min(0).max(1),
    }).strict(),
  }),
  LearningEventBaseSchema.extend({
    action: z.literal('human-approved'),
    payload: z.object({
      reviewerId: identifier('Reviewer id'),
      reviewerIdentitySha256: z.string().regex(SHA256),
      rationaleSha256: z.string().regex(SHA256),
    }).strict(),
  }),
  LearningEventBaseSchema.extend({
    action: z.union([z.literal('canary-passed'), z.literal('canary-failed')]),
    payload: z.object({
      tokenReduction: z.number().finite(),
      interventionReduction: z.number().finite(),
      qualityRegression: z.number().finite(),
      securityViolations: z.number().int().nonnegative(),
    }).strict(),
  }),
  LearningEventBaseSchema.extend({
    action: z.union([z.literal('rolled-back'), z.literal('revoked')]),
    payload: z.object({ reasonSha256: z.string().regex(SHA256) }).strict(),
  }),
]);
export type VerifiedLearningEvent = z.infer<typeof VerifiedLearningEventSchema>;

export interface LearningEventSigner {
  actorId: string;
  keyId: string;
  privateKey: KeyObject | string | Uint8Array;
}

export type LearningKeyResolver = (keyId: string, actorId: string) => KeyObject | null;

export const LearningActorRoleSchema = z.enum(['proposer', 'evaluator', 'reviewer', 'operator']);
export type LearningActorRole = z.infer<typeof LearningActorRoleSchema>;

const LearningIdentityBaseSchema = z.object({
  verificationStatus: z.literal('host-resolved'),
  actorId: identifier('Actor id'),
  workspaceId: identifier('Workspace id'),
  active: z.boolean(),
  keyIds: z.array(identifier('Learning key id')).min(1).max(16)
    .refine((keyIds) => new Set(keyIds).size === keyIds.length, 'Learning identity key ids must be unique'),
}).strict();

export const HostVerifiedLearningIdentitySchema = z.discriminatedUnion('kind', [
  LearningIdentityBaseSchema.extend({
    kind: z.literal('human'),
    role: LearningActorRoleSchema,
    humanAuthentication: z.object({
      assurance: z.literal('host-attested'),
      verifierId: identifier('Human authentication verifier id'),
      authenticatedAt: z.string().datetime(),
      expiresAt: z.string().datetime().optional(),
    }).strict(),
  }),
  LearningIdentityBaseSchema.extend({
    kind: z.literal('service'),
    role: z.enum(['proposer', 'evaluator', 'operator']),
  }),
  LearningIdentityBaseSchema.extend({
    kind: z.literal('agent'),
    role: z.enum(['proposer', 'evaluator', 'operator']),
  }),
]);
export type HostVerifiedLearningIdentity = z.infer<typeof HostVerifiedLearningIdentitySchema>;

/**
 * Trusted host boundary. The resolver, not this module, authenticates people and
 * binds identities to keys. Raw client claims must never be returned directly.
 */
export type LearningIdentityResolver = (
  actorId: string,
  keyId: string,
) => HostVerifiedLearningIdentity | null;

export interface VerifiedLearningAuthority {
  resolveKey: LearningKeyResolver;
  resolveIdentity: LearningIdentityResolver;
}

export type VerifiedLearningState =
  | 'proposed'
  | 'evaluated'
  | 'approved'
  | 'canary-passed'
  | 'rollback-required'
  | 'rolled-back'
  | 'revoked';

export interface VerifiedLearningProjection {
  proposal: VerifiedLearningProposal;
  state: VerifiedLearningState;
  participants: {
    proposerActorId: string;
    evaluatorActorId?: string;
    reviewerActorId?: string;
  };
  publicationMode: 'proposal-only';
  automaticPublication: false;
}

/** Durable proposal-only ledger. It persists hashes/signatures, never candidate content. */
export class VerifiedLearningStore {
  private readonly lockPath: string;

  /**
   * A key-only resolver is intentionally insufficient: every read and write must
   * also re-establish the host-resolved actor role and human-reviewer binding.
   */
  constructor(private readonly path: string, private readonly authority: VerifiedLearningAuthority) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.lockPath = `${path}.lock`;
  }

  create(event: VerifiedLearningEvent): VerifiedLearningProjection {
    return withLearningLock(this.lockPath, () => {
      if (existsSync(this.path)) throw new Error('Learning proposal ledger already exists');
      const verified = verifyVerifiedLearningHistory([event], this.authority);
      if (!verified.valid) throw new Error(verified.reason);
      this.write(verified.events);
      return verified.projection;
    });
  }

  append(event: VerifiedLearningEvent, expectedSequence: number): VerifiedLearningProjection {
    return withLearningLock(this.lockPath, () => {
      const current = this.readUnsafe();
      if (current.length !== expectedSequence) {
        throw new Error(`Learning ledger sequence conflict: expected ${expectedSequence}, found ${current.length}`);
      }
      const next = [...current, event];
      const verified = verifyVerifiedLearningHistory(next, this.authority);
      if (!verified.valid) throw new Error(verified.reason);
      this.write(verified.events);
      return verified.projection;
    });
  }

  read(): VerifiedLearningEvent[] {
    const events = this.readUnsafe();
    const verified = verifyVerifiedLearningHistory(events, this.authority);
    if (!verified.valid) throw new Error(verified.reason);
    return structuredClone(verified.events);
  }

  projection(): VerifiedLearningProjection {
    const verified = verifyVerifiedLearningHistory(this.readUnsafe(), this.authority);
    if (!verified.valid) throw new Error(verified.reason);
    return verified.projection;
  }

  private readUnsafe(): unknown[] {
    if (!existsSync(this.path)) return [];
    if (statSync(this.path).size > MAX_LEDGER_BYTES) throw new Error('Learning proposal ledger exceeds 16 MiB');
    const value: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
    const parsed = LearningLedgerSchema.safeParse(value);
    if (!parsed.success) throw new Error('Learning proposal ledger shape is invalid');
    return parsed.data.events;
  }

  private write(events: VerifiedLearningEvent[]): void {
    const ledger = LearningLedgerSchema.parse({ schemaVersion: 1, events });
    const serialized = `${JSON.stringify(ledger, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_LEDGER_BYTES) {
      throw new Error('Learning proposal ledger exceeds 16 MiB');
    }
    atomicWriteFileSync(this.path, serialized);
  }
}

const LearningLedgerSchema = z.object({
  schemaVersion: z.literal(1),
  events: z.array(VerifiedLearningEventSchema).min(1).max(10_000),
}).strict();

export function createVerifiedLearningProposal(input: {
  proposalId: string;
  workspaceId: string;
  artifact: Omit<VerifiedLearningProposal['artifact'], 'candidateContentSha256'>;
  candidateContent: string;
  passport: SignedProofPassport;
  /** Workspace issuer key distributed through the trusted governance plane. */
  trustedProofPassportPublicKeySpki: string;
  trajectory: LearningTrajectorySource[];
  createdAt?: string;
  signer: LearningEventSigner;
  authority: VerifiedLearningAuthority;
}): VerifiedLearningEvent {
  if (!input.proposalId.trim() || !input.workspaceId.trim()) throw new Error('Proposal and workspace identities are required');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(input.artifact.slug)) throw new Error('Learning artifact slug is invalid');
  if (!input.candidateContent.trim()) throw new Error('Candidate content is empty');
  if (Buffer.byteLength(input.candidateContent, 'utf8') > 1024 * 1024) throw new Error('Candidate content exceeds 1 MiB');
  if (redactSecretLikeMaterial(input.candidateContent) !== input.candidateContent) {
    throw new Error('Candidate content contains secret-like material');
  }
  const parsedTrajectory = LearningTrajectorySchema.safeParse(input.trajectory);
  if (!parsedTrajectory.success) {
    throw new Error('Learning trajectory must contain only redacted, hashed sources');
  }
  const verified = verifyProofPassport(input.passport, input.trustedProofPassportPublicKeySpki);
  if (!verified.valid) throw new Error(`Learning proposal requires a valid Proof Passport: ${verified.reason}`);
  if (verified.passport.workspaceId !== input.workspaceId) throw new Error('Proof Passport workspace binding does not match');
  const proposal = VerifiedLearningProposalSchema.parse({
    schemaVersion: 1,
    proposalId: input.proposalId,
    workspaceId: input.workspaceId,
    artifact: {
      ...input.artifact,
      candidateContentSha256: sha256(input.candidateContent),
    },
    provenance: {
      missionId: verified.passport.missionId,
      proofPassportId: verified.passport.passportId,
      proofPassportSha256: sha256(canonicalJson(verified.passport)),
      trajectory: parsedTrajectory.data,
    },
    privacy: { redacted: true, secretScanPassed: true, candidateContentStored: false },
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
  const event = signEvent({
    schemaVersion: 1,
    sequence: 1,
    proposalId: input.proposalId,
    action: 'proposed',
    actorId: input.signer.actorId,
    occurredAt: proposal.createdAt,
    previousHash: null,
    payload: { proposal },
  }, input.signer);
  return requireVerifiedHistory([event], input.authority).events[0]!;
}

export function recordVerifiedLearningEval(input: {
  history: VerifiedLearningEvent[];
  authority: VerifiedLearningAuthority;
  gate: EvalGateResult;
  signer: LearningEventSigner;
  occurredAt?: string;
}): VerifiedLearningEvent {
  const projection = requireProjection(input.history, input.authority);
  if (projection.state !== 'proposed') throw new Error('Learning eval requires a proposed candidate');
  if (!input.gate.passed || input.gate.failures.length > 0) throw new Error('Learning eval did not pass non-regression gates');
  return appendVerifiedEvent(input.history, input.authority, input.signer, 'eval-passed', {
    evalRunId: input.gate.report.runId,
    evalReportSha256: sha256(canonicalJson(input.gate.report)),
    ...(input.gate.baselineRunId ? { baselineRunId: input.gate.baselineRunId } : {}),
    passRate: input.gate.report.summary.passRate,
    policyComplianceRate: input.gate.report.summary.policyComplianceRate,
  }, input.occurredAt);
}

export function approveVerifiedLearningProposal(input: {
  history: VerifiedLearningEvent[];
  authority: VerifiedLearningAuthority;
  rationale: string;
  signer: LearningEventSigner;
  occurredAt?: string;
}): VerifiedLearningEvent {
  const projection = requireProjection(input.history, input.authority);
  if (projection.state !== 'evaluated') throw new Error('Human approval requires a passing non-regression eval');
  if (!input.rationale.trim()) throw new Error('Human approval rationale is required');
  const reviewerIdentity = resolveLearningIdentity(
    input.authority,
    input.signer.actorId,
    input.signer.keyId,
    projection.proposal.workspaceId,
    'reviewer',
    input.occurredAt ?? new Date().toISOString(),
  );
  if (reviewerIdentity.kind !== 'human') {
    throw new Error('Learning approval requires a host-attested human reviewer');
  }
  return appendVerifiedEvent(input.history, input.authority, input.signer, 'human-approved', {
    reviewerId: input.signer.actorId,
    reviewerIdentitySha256: hashLearningIdentity(reviewerIdentity),
    rationaleSha256: sha256(input.rationale.trim()),
  }, input.occurredAt);
}

export function recordVerifiedLearningCanary(input: {
  history: VerifiedLearningEvent[];
  authority: VerifiedLearningAuthority;
  tokenReduction: number;
  interventionReduction: number;
  qualityRegression: number;
  securityViolations: number;
  signer: LearningEventSigner;
  occurredAt?: string;
}): VerifiedLearningEvent {
  const projection = requireProjection(input.history, input.authority);
  if (projection.state !== 'approved') throw new Error('Canary requires explicit human approval');
  const values = [input.tokenReduction, input.interventionReduction, input.qualityRegression];
  if (values.some((value) => !Number.isFinite(value)) || !Number.isInteger(input.securityViolations) || input.securityViolations < 0) {
    throw new Error('Canary metrics are invalid');
  }
  const passed = input.tokenReduction >= 0.3
    && input.interventionReduction >= 0.3
    && input.qualityRegression <= 0
    && input.securityViolations === 0;
  return appendVerifiedEvent(input.history, input.authority, input.signer, passed ? 'canary-passed' : 'canary-failed', {
    tokenReduction: input.tokenReduction,
    interventionReduction: input.interventionReduction,
    qualityRegression: input.qualityRegression,
    securityViolations: input.securityViolations,
  }, input.occurredAt);
}

export function rollbackVerifiedLearningCanary(input: {
  history: VerifiedLearningEvent[];
  authority: VerifiedLearningAuthority;
  reason: string;
  signer: LearningEventSigner;
  occurredAt?: string;
}): VerifiedLearningEvent {
  const projection = requireProjection(input.history, input.authority);
  if (!['rollback-required', 'canary-passed'].includes(projection.state)) {
    throw new Error('Only a canary can be rolled back');
  }
  return appendReasonEvent(input, 'rolled-back');
}

export function revokeVerifiedLearningProposal(input: {
  history: VerifiedLearningEvent[];
  authority: VerifiedLearningAuthority;
  reason: string;
  signer: LearningEventSigner;
  occurredAt?: string;
}): VerifiedLearningEvent {
  const projection = requireProjection(input.history, input.authority);
  if (projection.state === 'revoked' || projection.state === 'rolled-back') throw new Error('Learning proposal is already terminal');
  return appendReasonEvent(input, 'revoked');
}

function appendReasonEvent(
  input: {
    history: VerifiedLearningEvent[];
    authority: VerifiedLearningAuthority;
    reason: string;
    signer: LearningEventSigner;
    occurredAt?: string;
  },
  action: 'rolled-back' | 'revoked',
): VerifiedLearningEvent {
  if (!input.reason.trim()) throw new Error(`${action} reason is required`);
  return appendVerifiedEvent(
    input.history,
    input.authority,
    input.signer,
    action,
    { reasonSha256: sha256(input.reason.trim()) },
    input.occurredAt,
  );
}

export function verifyVerifiedLearningHistory(
  history: readonly unknown[],
  authority: VerifiedLearningAuthority,
): { valid: true; projection: VerifiedLearningProjection; events: VerifiedLearningEvent[] }
  | { valid: false; reason: string } {
  const parsedHistory = z.array(VerifiedLearningEventSchema).min(1).max(10_000).safeParse(history);
  if (!parsedHistory.success) {
    if (history.length === 0) return { valid: false, reason: 'Learning history is empty' };
    const sequence = typeof parsedHistory.error.issues[0]?.path[0] === 'number'
      ? Number(parsedHistory.error.issues[0]!.path[0]) + 1
      : 1;
    return { valid: false, reason: `Learning event shape is invalid at sequence ${sequence}` };
  }
  const events = parsedHistory.data;
  let state: VerifiedLearningState | undefined;
  let proposal: VerifiedLearningProposal | undefined;
  let proposerActorId: string | undefined;
  let proposerKeyId: string | undefined;
  let evaluatorActorId: string | undefined;
  let evaluatorKeyId: string | undefined;
  let reviewerActorId: string | undefined;
  let previousHash: string | null = null;
  let previousOccurredAt = 0;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.sequence !== index + 1 || event.previousHash !== previousHash) {
      return { valid: false, reason: `Learning event chain is invalid at sequence ${index + 1}` };
    }
    const occurredAt = Date.parse(event.occurredAt);
    if (index > 0 && occurredAt < previousOccurredAt) {
      return { valid: false, reason: `Learning event time regresses at sequence ${index + 1}` };
    }
    let publicKey: KeyObject | null;
    try {
      publicKey = authority.resolveKey(event.signature.keyId, event.actorId);
    } catch {
      return { valid: false, reason: `Learning event key resolution failed at sequence ${index + 1}` };
    }
    if (!publicKey || publicKey.asymmetricKeyType !== 'ed25519' || !verifyBytes(
      null,
      eventSigningBytes(event),
      publicKey,
      Buffer.from(event.signature.value, 'base64url'),
    )) return { valid: false, reason: `Learning event signature is invalid at sequence ${index + 1}` };
    if (index === 0) {
      if (event.action !== 'proposed') return { valid: false, reason: 'Learning history must start with proposed' };
      proposal = event.payload.proposal;
      if (proposal.proposalId !== event.proposalId || proposal.createdAt !== event.occurredAt) {
        return { valid: false, reason: 'Learning proposal payload is invalid' };
      }
      proposerActorId = event.actorId;
      proposerKeyId = event.signature.keyId;
      state = 'proposed';
    } else {
      if (event.proposalId !== proposal!.proposalId) {
        return { valid: false, reason: `Learning proposal binding is invalid at sequence ${index + 1}` };
      }
      const next = transition(state!, event.action);
      if (!next) return { valid: false, reason: `Illegal learning transition ${state} -> ${event.action}` };
      state = next;
    }

    const expectedRole = requiredRole(event.action);
    let identity: HostVerifiedLearningIdentity;
    try {
      identity = resolveLearningIdentity(
        authority,
        event.actorId,
        event.signature.keyId,
        proposal!.workspaceId,
        expectedRole,
        event.occurredAt,
      );
    } catch (error) {
      return {
        valid: false,
        reason: `${learningErrorMessage(error, 'Learning actor identity is invalid')} at sequence ${index + 1}`,
      };
    }

    if (event.action === 'eval-passed') {
      if (event.actorId === proposerActorId || event.signature.keyId === proposerKeyId) {
        return { valid: false, reason: 'Learning evaluator identity and key must be independent from the proposer' };
      }
      evaluatorActorId = event.actorId;
      evaluatorKeyId = event.signature.keyId;
    }
    if (event.action === 'human-approved') {
      if (identity.kind !== 'human') {
        return { valid: false, reason: 'Learning approval requires a host-attested human reviewer' };
      }
      if (event.actorId === proposerActorId || event.actorId === evaluatorActorId
        || event.signature.keyId === proposerKeyId || event.signature.keyId === evaluatorKeyId) {
        return { valid: false, reason: 'Learning reviewer identity and key must be independent from proposer and evaluator' };
      }
      if (event.payload.reviewerId !== event.actorId
        || event.payload.reviewerIdentitySha256 !== hashLearningIdentity(identity)) {
        return { valid: false, reason: 'Learning reviewer identity binding is invalid' };
      }
      reviewerActorId = event.actorId;
    }
    if ((event.action === 'canary-passed' || event.action === 'canary-failed')
      && !canaryActionMatchesPayload(event)) {
      return { valid: false, reason: `Learning canary outcome is invalid at sequence ${index + 1}` };
    }
    previousHash = hashEvent(event);
    previousOccurredAt = occurredAt;
  }
  return {
    valid: true,
    events,
    projection: {
      proposal: proposal!,
      state: state!,
      participants: {
        proposerActorId: proposerActorId!,
        ...(evaluatorActorId ? { evaluatorActorId } : {}),
        ...(reviewerActorId ? { reviewerActorId } : {}),
      },
      publicationMode: 'proposal-only',
      automaticPublication: false,
    },
  };
}

function canaryActionMatchesPayload(
  event: Extract<VerifiedLearningEvent, { action: 'canary-passed' | 'canary-failed' }>,
): boolean {
  const passed = event.payload.tokenReduction >= 0.3
    && event.payload.interventionReduction >= 0.3
    && event.payload.qualityRegression <= 0
    && event.payload.securityViolations === 0;
  return (event.action === 'canary-passed') === passed;
}

function requiredRole(action: VerifiedLearningAction): LearningActorRole {
  if (action === 'proposed') return 'proposer';
  if (action === 'eval-passed') return 'evaluator';
  if (action === 'human-approved') return 'reviewer';
  return 'operator';
}

function resolveLearningIdentity(
  authority: VerifiedLearningAuthority,
  actorId: string,
  keyId: string,
  workspaceId: string,
  expectedRole: LearningActorRole,
  occurredAt: string,
): HostVerifiedLearningIdentity {
  const parsedOccurredAt = Date.parse(z.string().datetime().parse(occurredAt));
  const resolved = authority.resolveIdentity(actorId, keyId);
  if (!resolved) throw new Error('Learning actor identity is unavailable');
  const identity = HostVerifiedLearningIdentitySchema.parse(resolved);
  if (identity.actorId !== actorId || !identity.keyIds.includes(keyId)) {
    throw new Error('Learning actor identity/key binding is invalid');
  }
  if (!identity.active) throw new Error('Learning actor identity is inactive');
  if (identity.workspaceId !== workspaceId) throw new Error('Learning actor workspace binding is invalid');
  if (identity.role !== expectedRole) {
    throw new Error(`Learning action requires the ${expectedRole} role`);
  }
  if (expectedRole === 'reviewer' && identity.kind !== 'human') {
    throw new Error('Learning approval requires a host-attested human reviewer');
  }
  if (identity.kind === 'human') {
    const authenticatedAt = Date.parse(identity.humanAuthentication.authenticatedAt);
    const expiresAt = identity.humanAuthentication.expiresAt
      ? Date.parse(identity.humanAuthentication.expiresAt)
      : undefined;
    if (authenticatedAt > parsedOccurredAt || (expiresAt !== undefined && expiresAt <= parsedOccurredAt)) {
      throw new Error('Host-attested human authentication is not valid at event time');
    }
  }
  return identity;
}

function hashLearningIdentity(identity: HostVerifiedLearningIdentity): string {
  return sha256(canonicalJson(HostVerifiedLearningIdentitySchema.parse(identity)));
}

function learningErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function transition(state: VerifiedLearningState, action: VerifiedLearningAction): VerifiedLearningState | undefined {
  if (action === 'revoked' && state !== 'revoked' && state !== 'rolled-back') return 'revoked';
  if (state === 'proposed' && action === 'eval-passed') return 'evaluated';
  if (state === 'evaluated' && action === 'human-approved') return 'approved';
  if (state === 'approved' && action === 'canary-passed') return 'canary-passed';
  if (state === 'approved' && action === 'canary-failed') return 'rollback-required';
  if ((state === 'rollback-required' || state === 'canary-passed') && action === 'rolled-back') return 'rolled-back';
  return undefined;
}

function requireVerifiedHistory(
  history: readonly unknown[],
  authority: VerifiedLearningAuthority,
): Extract<ReturnType<typeof verifyVerifiedLearningHistory>, { valid: true }> {
  const verified = verifyVerifiedLearningHistory(history, authority);
  if (!verified.valid) throw new Error(verified.reason);
  return verified;
}

function requireProjection(
  history: readonly unknown[],
  authority: VerifiedLearningAuthority,
): VerifiedLearningProjection {
  return requireVerifiedHistory(history, authority).projection;
}

function appendVerifiedEvent(
  history: VerifiedLearningEvent[],
  authority: VerifiedLearningAuthority,
  signer: LearningEventSigner,
  action: VerifiedLearningAction, payload: Record<string, unknown>, occurredAt?: string,
): VerifiedLearningEvent {
  const previous = history.at(-1);
  if (!previous) throw new Error('Learning proposal history is empty');
  if (action === 'proposed') throw new Error('Learning proposal must be the first event');
  const event = signEvent({
    schemaVersion: 1,
    sequence: history.length + 1,
    proposalId: previous.proposalId,
    action,
    actorId: signer.actorId,
    occurredAt: occurredAt ?? new Date().toISOString(),
    previousHash: hashEvent(previous),
    payload,
  }, signer);
  return requireVerifiedHistory([...history, event], authority).events.at(-1)!;
}

type UnsignedLearningEvent = {
  schemaVersion: 1;
  sequence: number;
  proposalId: string;
  action: VerifiedLearningAction;
  actorId: string;
  occurredAt: string;
  previousHash: string | null;
  payload: Record<string, unknown>;
};

function signEvent(
  event: UnsignedLearningEvent,
  signer: LearningEventSigner,
): VerifiedLearningEvent {
  if (!signer.actorId.trim() || !signer.keyId.trim() || signer.actorId !== event.actorId) throw new Error('Learning signer binding is invalid');
  const privateKey = keyObject(signer.privateKey);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Learning signing key must be Ed25519');
  const unsigned = { ...event, signature: { algorithm: 'Ed25519' as const, keyId: signer.keyId, value: '' } };
  const signed = {
    ...unsigned,
    signature: {
      ...unsigned.signature,
      value: signBytes(null, eventSigningBytes(unsigned), privateKey).toString('base64url'),
    },
  };
  return VerifiedLearningEventSchema.parse(signed);
}

function eventSigningBytes(event: UnsignedLearningEvent & {
  signature: { algorithm: 'Ed25519'; keyId: string; value: string };
}): Buffer {
  const { signature, ...unsigned } = event;
  return Buffer.from(canonicalJson({ ...unsigned, signature: { algorithm: signature.algorithm, keyId: signature.keyId } }), 'utf8');
}

function keyObject(value: KeyObject | string | Uint8Array): KeyObject {
  if (value instanceof KeyObject) return value;
  if (typeof value === 'string') return createPrivateKey(value);
  return createPrivateKey({ key: Buffer.from(value), format: 'der', type: 'pkcs8' });
}

function hashEvent(event: VerifiedLearningEvent): string { return sha256(canonicalJson(event)); }
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
}

function withLearningLock<T>(path: string, operation: () => T): T {
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { descriptor = openSync(path, 'wx', 0o600); break; } catch (error) {
      if (learningErrorCode(error) !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > 30_000) unlinkSync(path);
      } catch (nested) { if (learningErrorCode(nested) !== 'ENOENT') throw nested; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
  }
  if (descriptor === undefined) throw new Error('Learning proposal ledger lock is unavailable');
  try {
    writeSync(descriptor, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    return operation();
  } finally {
    closeSync(descriptor);
    try { unlinkSync(path); } catch (error) { if (learningErrorCode(error) !== 'ENOENT') throw error; }
  }
}

function learningErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code) : undefined;
}
