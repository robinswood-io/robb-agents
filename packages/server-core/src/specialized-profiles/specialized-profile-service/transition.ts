import { SpecializedProfileRegistryRevisionConflictError, canonicalSpecializedProfileVersionHash, specializedProfileTransitionIsPromotion, type RollbackSpecializedProfileRequest, type SpecializedProfileRegistryMutationResult, type TransitionSpecializedProfileRequest } from "@craft-agent/shared/specialized-profiles";
import type { SpecializedProfileService } from '../SpecializedProfileService.ts';
import { PROMOTION_STATES, WRITE_OR_EXTERNAL_CAPABILITIES } from './shared.ts';
import { attestApprovalReceipt, assertNoAuthorityEvidence } from './authority.ts';
import { requireProfile } from './definition.ts';
import { canonicalJson, sha256 } from './serialization.ts';

export async function transition(transportOwner: SpecializedProfileService, workspaceId: string, actorId: string, request: TransitionSpecializedProfileRequest): Promise<SpecializedProfileRegistryMutationResult> {
    const workspace = transportOwner["requireWorkspace"](workspaceId);
    const authorityKey = await transportOwner["loadAuthorityKey"](workspaceId);
    const store = await transportOwner["storeFor"](workspace, authorityKey);
    const current = await store.loadOrCreate(workspaceId, actorId);
    if (current.revision !== request.expectedRegistryRevision) {
        throw new SpecializedProfileRegistryRevisionConflictError(request.expectedRegistryRevision, current.revision);
    }
    const currentProfile = requireProfile(current, request.profileId);
    const requiresPromotionApproval = specializedProfileTransitionIsPromotion(currentProfile.currentState, request.to) && PROMOTION_STATES.has(request.to);
    if (!requiresPromotionApproval && request.humanApprovalChallengeId !== undefined) {
        throw new Error('Human approval challenges are accepted only at human promotion gates');
    }
    const registry = await store.transition(request.expectedRegistryRevision, {
        profileId: request.profileId,
        expectedCurrentVersion: request.expectedCurrentVersion,
        to: request.to,
        actorId,
        reason: request.reason,
        evaluationIds: request.evaluationIds,
    }, requiresPromotionApproval ? async (context) => {
        const unsafe = context.version.definition.requestedCapabilities.find((capability) => WRITE_OR_EXTERNAL_CAPABILITIES.has(capability.kind));
        if (unsafe) {
            throw new Error(`The Dev MVP cannot promote profiles requesting ${unsafe.kind}; keep this profile in shadow or draft`);
        }
        if (!request.humanApprovalChallengeId || !transportOwner["options"].humanApprovalProvider) {
            throw new Error(`Transition to ${request.to} requires a one-time separately authenticated human approval challenge`);
        }
        const versionSha256 = canonicalSpecializedProfileVersionHash(context.version);
        const approvalIdempotencyKey = sha256(canonicalJson({
            kind: 'specialized-profile-human-approval',
            workspaceId,
            challengeId: request.humanApprovalChallengeId,
            profileId: request.profileId,
            profileVersion: request.expectedCurrentVersion,
            from: context.from,
            to: request.to,
            rationale: request.reason,
            registryRevision: context.registryRevision,
            registryHeadSha256: context.registryHeadSha256,
            lifecycleEntryTransitionSequence: context.lifecycleEntryTransitionSequence,
            evaluationIds: context.evaluationIds,
            versionSha256,
        }));
        const approval = await transportOwner["options"].humanApprovalProvider.consume({
            idempotencyKey: approvalIdempotencyKey,
            challengeId: request.humanApprovalChallengeId,
            workspaceId,
            profileId: request.profileId,
            profileVersion: request.expectedCurrentVersion,
            from: context.from,
            to: request.to as 'opt-in' | 'canary' | 'default',
            rationale: request.reason,
            registryRevision: context.registryRevision,
            registryHeadSha256: context.registryHeadSha256,
            lifecycleEntryTransitionSequence: context.lifecycleEntryTransitionSequence,
            evaluationIds: context.evaluationIds,
            versionSha256,
        });
        if (approval.reviewerActorId !== actorId) {
            throw new Error('Authenticated human reviewer does not match the transition actor');
        }
        assertNoAuthorityEvidence(approval.evidence);
        const issuedAt = transportOwner["now"]();
        const authenticatedAt = Date.parse(approval.authenticatedAt);
        const expiresAt = Date.parse(approval.expiresAt);
        if (!Number.isFinite(authenticatedAt)
            || authenticatedAt > issuedAt.getTime()
            || issuedAt.getTime() - authenticatedAt > 10 * 60 * 1000
            || !Number.isFinite(expiresAt)
            || expiresAt <= issuedAt.getTime()) {
            throw new Error('Human approval authentication is stale, future-dated, or expired');
        }
        return attestApprovalReceipt({
            schemaVersion: 1 as const,
            receiptId: `profile-approval-${approvalIdempotencyKey}`,
            profileId: request.profileId,
            profileVersion: request.expectedCurrentVersion,
            transition: { from: context.from, to: request.to as 'opt-in' | 'canary' | 'default' },
            decision: 'approved' as const,
            reviewer: { kind: 'human' as const, actorId },
            authentication: {
                assurance: approval.assurance,
                verifierId: approval.verifierId,
                eventId: approval.eventId,
                authenticatedAt: approval.authenticatedAt,
            },
            authorizationContext: {
                registryRevision: context.registryRevision,
                registryHeadSha256: context.registryHeadSha256,
                lifecycleEntryTransitionSequence: context.lifecycleEntryTransitionSequence,
                evaluationIds: context.evaluationIds,
            },
            issuedAt: issuedAt.toISOString(),
            expiresAt: approval.expiresAt,
            rationale: request.reason,
            evidence: [
                ...approval.evidence,
                {
                    uri: `specialized-profile://${workspaceId}/${request.profileId}/${request.expectedCurrentVersion}`,
                    sha256: versionSha256,
                },
            ],
        }, workspaceId, context.version, authorityKey);
    } : undefined);
    return { registry, profileId: request.profileId };
}

export async function rollback(transportOwner: SpecializedProfileService, workspaceId: string, actorId: string, request: RollbackSpecializedProfileRequest): Promise<SpecializedProfileRegistryMutationResult> {
    const workspace = transportOwner["requireWorkspace"](workspaceId);
    const registry = await (await transportOwner["storeFor"](workspace)).rollback(request.expectedRegistryRevision, {
        profileId: request.profileId,
        expectedCurrentVersion: request.expectedCurrentVersion,
        rollbackOfVersion: request.rollbackOfVersion,
        actorId,
        reason: request.reason,
    });
    return { registry, profileId: request.profileId };
}
