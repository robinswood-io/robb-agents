import { KeyObject, verify as verifyBytes } from "node:crypto";
import { z } from "zod";
import type { HostVerifiedLearningIdentity, LearningActorRole, LearningEventSigner, VerifiedLearningAction, VerifiedLearningAuthority, VerifiedLearningEvent, VerifiedLearningProjection, VerifiedLearningProposal, VerifiedLearningState } from './contracts.ts';
import { HostVerifiedLearningIdentitySchema, VerifiedLearningEventSchema } from './contracts.ts';
import { canonicalJson, eventSigningBytes, hashEvent, sha256, signEvent } from './signatures.ts';

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

export function resolveLearningIdentity(
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

export function hashLearningIdentity(identity: HostVerifiedLearningIdentity): string {
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

export function requireVerifiedHistory(
  history: readonly unknown[],
  authority: VerifiedLearningAuthority,
): Extract<ReturnType<typeof verifyVerifiedLearningHistory>, { valid: true }> {
  const verified = verifyVerifiedLearningHistory(history, authority);
  if (!verified.valid) throw new Error(verified.reason);
  return verified;
}

export function requireProjection(
  history: readonly unknown[],
  authority: VerifiedLearningAuthority,
): VerifiedLearningProjection {
  return requireVerifiedHistory(history, authority).projection;
}

export function appendVerifiedEvent(
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
