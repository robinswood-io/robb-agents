import type { EvalGateResult } from "../../evals/eval-gate.ts";
import { verifyProofPassport, type SignedProofPassport } from "../../missions/proof-passport.ts";
import { redactSecretLikeMaterial } from "../../utils/redaction.ts";
import type { LearningEventSigner, LearningTrajectorySource, VerifiedLearningAuthority, VerifiedLearningEvent, VerifiedLearningProposal } from './contracts.ts';
import { LearningTrajectorySchema, VerifiedLearningProposalSchema } from './contracts.ts';
import { appendVerifiedEvent, hashLearningIdentity, requireProjection, requireVerifiedHistory, resolveLearningIdentity } from './history.ts';
import { canonicalJson, sha256, signEvent } from './signatures.ts';

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
