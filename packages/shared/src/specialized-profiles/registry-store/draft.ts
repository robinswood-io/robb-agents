import { SpecializedAgentProfileDefinitionSchema, SpecializedProfileProvenanceSchema, SpecializedProfileVersionSchema, type CreateSpecializedProfileCandidateInput, type ReviseSpecializedProfileInput, type SpecializedProfileRegistryDocument } from "../schema.ts";
import type { SpecializedProfileRegistryStore } from '../registry-store.ts';
import { SpecializedProfileRegistryRevisionConflictError, requireProfile, assertProfileVersion, assertMutable, resetToDraft } from './shared.ts';

export async function createCandidate(transportOwner: SpecializedProfileRegistryStore, expectedRevision: number, input: CreateSpecializedProfileCandidateInput): Promise<SpecializedProfileRegistryDocument> {
    return transportOwner["update"](expectedRevision, input.actorId, (document, occurredAt) => {
        if (document.profiles.some((profile) => profile.id === input.profileId)) {
            throw new Error(`Specialized profile "${input.profileId}" already exists`);
        }
        const definition = SpecializedAgentProfileDefinitionSchema.parse(input.definition);
        const provenance = SpecializedProfileProvenanceSchema.parse(input.provenance);
        const version = SpecializedProfileVersionSchema.parse({
            schemaVersion: 1,
            profileId: input.profileId,
            version: 1,
            definition,
            provenance,
            change: { kind: 'initial', reason: input.reason },
            createdAt: occurredAt,
            createdBy: input.actorId,
        });
        document.profiles.push({
            id: version.profileId,
            creationRequestId: input.creationRequestId,
            currentVersion: 1,
            currentState: 'candidate',
            versions: [version],
            evaluations: [],
            transitions: [{
                    sequence: 1,
                    profileVersion: 1,
                    from: null,
                    to: 'candidate',
                    occurredAt,
                    actorId: input.actorId,
                    reason: input.reason,
                    evaluationIds: [],
                }],
            createdAt: occurredAt,
            updatedAt: occurredAt,
        });
    });
}

export async function createDraft(transportOwner: SpecializedProfileRegistryStore, expectedRevision: number, input: CreateSpecializedProfileCandidateInput): Promise<SpecializedProfileRegistryDocument> {
    return transportOwner["withLock"](async () => {
        const current = await transportOwner["loadDocument"](true);
        if (!current)
            throw new Error(`Specialized profile registry does not exist for workspace "${transportOwner["workspaceRoot"]}"`);
        const alreadyCommitted = current.profiles.find((profile) => profile.creationRequestId === input.creationRequestId);
        if (alreadyCommitted) {
            if (alreadyCommitted.id !== input.profileId || alreadyCommitted.currentState !== 'draft') {
                throw new Error(`Creation request "${input.creationRequestId}" is already bound to a different profile state`);
            }
            return current;
        }
        if (current.revision !== expectedRevision) {
            throw new SpecializedProfileRegistryRevisionConflictError(expectedRevision, current.revision);
        }
        if (current.profiles.some((profile) => profile.id === input.profileId)) {
            throw new Error(`Specialized profile "${input.profileId}" already exists`);
        }
        const next = structuredClone(current);
        const occurredAt = transportOwner["now"]().toISOString();
        const version = SpecializedProfileVersionSchema.parse({
            schemaVersion: 1,
            profileId: input.profileId,
            version: 1,
            definition: SpecializedAgentProfileDefinitionSchema.parse(input.definition),
            provenance: SpecializedProfileProvenanceSchema.parse(input.provenance),
            change: { kind: 'initial', reason: input.reason },
            createdAt: occurredAt,
            createdBy: input.actorId,
        });
        next.profiles.push({
            id: version.profileId,
            creationRequestId: input.creationRequestId,
            currentVersion: 1,
            currentState: 'draft',
            versions: [version],
            evaluations: [],
            transitions: [
                {
                    sequence: 1,
                    profileVersion: 1,
                    from: null,
                    to: 'candidate',
                    occurredAt,
                    actorId: input.actorId,
                    reason: input.reason,
                    evaluationIds: [],
                },
                {
                    sequence: 2,
                    profileVersion: 1,
                    from: 'candidate',
                    to: 'draft',
                    occurredAt,
                    actorId: input.actorId,
                    reason: 'Materialized atomically as an inactive specialization draft',
                    evaluationIds: [],
                },
            ],
            createdAt: occurredAt,
            updatedAt: occurredAt,
        });
        next.revision += 1;
        next.updatedAt = occurredAt;
        next.updatedBy = input.actorId;
        const sealed = transportOwner["sealDocument"](next, current.head.documentSha256);
        await transportOwner["writeDocument"](sealed, current);
        return sealed;
    });
}

export async function reviseProfile(transportOwner: SpecializedProfileRegistryStore, expectedRevision: number, input: ReviseSpecializedProfileInput): Promise<SpecializedProfileRegistryDocument> {
    return transportOwner["update"](expectedRevision, input.actorId, (document, occurredAt) => {
        const profile = requireProfile(document, input.profileId);
        assertProfileVersion(profile, input.expectedCurrentVersion);
        assertMutable(profile);
        const nextVersion = profile.currentVersion + 1;
        const version = SpecializedProfileVersionSchema.parse({
            schemaVersion: 1,
            profileId: profile.id,
            version: nextVersion,
            definition: SpecializedAgentProfileDefinitionSchema.parse(input.definition),
            provenance: SpecializedProfileProvenanceSchema.parse(input.provenance),
            change: {
                kind: 'revision',
                previousVersion: profile.currentVersion,
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
