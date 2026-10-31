import { SPECIALIZED_PROFILE_ALLOWED_TRANSITIONS, SPECIALIZED_PROFILE_REQUIRED_EVALUATION_STAGE, SpecializedProfileHumanApprovalReceiptSchema, SpecializedProfileVersionSchema, specializedProfileTransitionIsPromotion, type RollbackSpecializedProfileInput, type SpecializedProfileHumanApprovalReceipt, type SpecializedProfileRegistryDocument, type SpecializedProfileState, type SpecializedProfileTransition, type SpecializedProfileVersion, type TransitionSpecializedProfileInput } from "../schema.ts";
import type { SpecializedProfileRegistryStore } from '../registry-store.ts';
import { HUMAN_APPROVAL_STATES, SpecializedProfileTransitionGateError, requireProfile, assertProfileVersion, assertMutable, resetToDraft, latestEvaluation, assertPassingEvaluation, assertApprovalReceipt, normalizeIds } from './shared.ts';

export async function transition(transportOwner: SpecializedProfileRegistryStore, expectedRevision: number, input: TransitionSpecializedProfileInput, createApprovalReceipt?: (context: {
    registryRevision: number;
    registryHeadSha256: string;
    lifecycleEntryTransitionSequence: number;
    evaluationIds: string[];
    from: SpecializedProfileState;
    version: SpecializedProfileVersion;
}) => Promise<SpecializedProfileHumanApprovalReceipt>): Promise<SpecializedProfileRegistryDocument> {
    return transportOwner["update"](expectedRevision, input.actorId, async (document, occurredAt) => {
        const profile = requireProfile(document, input.profileId);
        assertProfileVersion(profile, input.expectedCurrentVersion);
        const from = profile.currentState;
        const allowed: readonly SpecializedProfileState[] = SPECIALIZED_PROFILE_ALLOWED_TRANSITIONS[from];
        if (!allowed.includes(input.to)) {
            throw new SpecializedProfileTransitionGateError(`Transition from ${from} to ${input.to} is not allowed`);
        }
        const evaluationIds = normalizeIds(input.evaluationIds ?? [], 'evaluationIds');
        const evaluations = evaluationIds.map((id) => {
            const evaluation = profile.evaluations.find((entry) => entry.id === id);
            if (!evaluation)
                throw new SpecializedProfileTransitionGateError(`Unknown evaluation "${id}"`);
            if (evaluation.profileVersion !== profile.currentVersion) {
                throw new SpecializedProfileTransitionGateError(`Evaluation "${id}" targets another profile version`);
            }
            return evaluation;
        });
        const promotion = specializedProfileTransitionIsPromotion(from, input.to);
        const requiredStage = promotion
            ? SPECIALIZED_PROFILE_REQUIRED_EVALUATION_STAGE[input.to]
            : undefined;
        if (requiredStage) {
            const latest = latestEvaluation(profile, profile.currentVersion, requiredStage);
            if (!latest || !evaluations.some((evaluation) => evaluation.id === latest.id)) {
                throw new SpecializedProfileTransitionGateError(`Transition to ${input.to} requires the latest ${requiredStage} evaluation`);
            }
            assertPassingEvaluation(latest, profile.versions[profile.currentVersion - 1]!.definition, transportOwner["now"]());
            const priorCertified = profile.transitions.flatMap((transition) => transition.profileVersion === profile.currentVersion
                ? transition.evaluationIds.flatMap((id) => {
                    const evaluation = profile.evaluations.find((candidate) => candidate.id === id);
                    return evaluation ? [evaluation] : [];
                })
                : []);
            if (priorCertified.some((evaluation) => evaluation.executionRouteSha256 !== latest.executionRouteSha256
                || evaluation.capabilityEnvelopeSha256 !== latest.capabilityEnvelopeSha256)) {
                throw new SpecializedProfileTransitionGateError(`Transition to ${input.to} changes the route or capability envelope certified by the promotion chain`);
            }
            const currentEntry = profile.transitions.at(-1)!;
            if (latest.stageEntryTransitionSequence !== currentEntry.sequence) {
                throw new SpecializedProfileTransitionGateError(`Transition to ${input.to} requires an evaluation from the current ${from} lifecycle entry`);
            }
        }
        let approvalReceipt: ReturnType<typeof SpecializedProfileHumanApprovalReceiptSchema.parse> | undefined;
        let transitionOccurredAt = occurredAt;
        if (promotion && HUMAN_APPROVAL_STATES.has(input.to)) {
            const value = input.approvalReceipt ?? await createApprovalReceipt?.({
                registryRevision: document.revision,
                registryHeadSha256: document.head.documentSha256,
                lifecycleEntryTransitionSequence: profile.transitions.at(-1)!.sequence,
                evaluationIds,
                from,
                version: profile.versions[profile.currentVersion - 1]!,
            });
            if (!value) {
                throw new SpecializedProfileTransitionGateError(`Transition to ${input.to} requires a structured human approval receipt`);
            }
            approvalReceipt = SpecializedProfileHumanApprovalReceiptSchema.parse(value);
            // Authentication may take time. The durable transition happens after
            // the receipt is issued, never at the pre-authentication timestamp.
            transitionOccurredAt = transportOwner["now"]().toISOString();
            assertApprovalReceipt(approvalReceipt, document, profile, from, input.to, input.actorId, evaluationIds, new Date(transitionOccurredAt));
        }
        else if (input.approvalReceipt !== undefined) {
            throw new SpecializedProfileTransitionGateError('Human approval receipts are accepted only for opt-in, canary, or default promotion');
        }
        const nextTransition: SpecializedProfileTransition = {
            sequence: profile.transitions.length + 1,
            profileVersion: profile.currentVersion,
            from,
            to: input.to,
            occurredAt: transitionOccurredAt,
            actorId: input.actorId,
            reason: input.reason,
            evaluationIds,
            ...(approvalReceipt ? { approvalReceipt } : {}),
        };
        if (approvalReceipt) {
            const version = profile.versions[profile.currentVersion - 1]!;
            if (!transportOwner["authority"]?.verifyHumanApprovalReceipt({
                receipt: approvalReceipt,
                version,
                transition: nextTransition,
            })) {
                throw new SpecializedProfileTransitionGateError(`Human approval receipt "${approvalReceipt.receiptId}" lacks a valid host authority attestation`);
            }
        }
        profile.currentState = input.to;
        profile.updatedAt = transitionOccurredAt;
        profile.transitions.push(nextTransition);
    });
}

export async function rollback(transportOwner: SpecializedProfileRegistryStore, expectedRevision: number, input: RollbackSpecializedProfileInput): Promise<SpecializedProfileRegistryDocument> {
    return transportOwner["update"](expectedRevision, input.actorId, (document, occurredAt) => {
        const profile = requireProfile(document, input.profileId);
        assertProfileVersion(profile, input.expectedCurrentVersion);
        assertMutable(profile);
        if (input.rollbackOfVersion >= profile.currentVersion) {
            throw new Error('Rollback target must precede the current profile version');
        }
        const target = profile.versions[input.rollbackOfVersion - 1];
        if (!target)
            throw new Error(`Rollback target version ${input.rollbackOfVersion} does not exist`);
        const nextVersion = profile.currentVersion + 1;
        const version = SpecializedProfileVersionSchema.parse({
            schemaVersion: 1,
            profileId: profile.id,
            version: nextVersion,
            definition: target.definition,
            provenance: target.provenance,
            change: {
                kind: 'rollback',
                previousVersion: profile.currentVersion,
                rollbackOfVersion: input.rollbackOfVersion,
                reason: input.reason,
            },
            createdAt: occurredAt,
            createdBy: input.actorId,
        });
        profile.versions.push(version);
        profile.currentVersion = nextVersion;
        resetToDraft(profile, input.actorId, input.reason, occurredAt);
    });
}
