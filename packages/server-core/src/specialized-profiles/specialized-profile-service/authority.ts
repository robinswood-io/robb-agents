import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { SpecializedProfileRegistryStore, canonicalSpecializedProfileRegistryAnchorPayloadHash, canonicalSpecializedProfileRegistryPayloadHash, canonicalSpecializedProfileVersionHash, type SpecializedProfileEvaluation, type SpecializedProfileHumanApprovalReceipt, type SpecializedProfileRegistryAuthority, type SpecializedProfileRegistryDocument, type SpecializedProfileVersion } from "@craft-agent/shared/specialized-profiles";
import { loadWorkspaceGovernanceSigningKey } from "../../tasks/execution-proof-runtime.ts";
import { FileSpecializedProfileRegistryAnchorStore } from "../registry-anchor-store.ts";
import { AUTHORITY_KEY_PURPOSE, AUTHORITY_KEY_ID, AUTHORITY_EVIDENCE_PREFIX, DEFAULT_ANCHOR_DIRECTORY } from './shared.ts';
import type { SpecializedProfileWorkspace, SpecializedProfileRegistryLoaderOptions } from './shared.ts';
import { canonicalJson, sha256 } from './serialization.ts';

/**
 * Read and authenticate the registry used by Mission admission/execution.
 * Merely running an ordinary Mission must not mint a governance credential, so
 * the authority key is loaded only after a registry file is present.
 */
export async function loadSpecializedProfileRegistryForMission(workspace: SpecializedProfileWorkspace, options: SpecializedProfileRegistryLoaderOptions = {}): Promise<SpecializedProfileRegistryDocument | null> {
    const now = options.now ?? (() => new Date());
    const probe = new SpecializedProfileRegistryStore(workspace.rootPath, { now });
    // A crash may leave only the pending document plus the external pending
    // anchor. That is recoverable state, not an absent registry.
    if (!existsSync(probe.documentPath) && !existsSync(probe.pendingDocumentPath))
        return null;
    const key = await (options.loadAuthorityKey
        ?? ((workspaceId: string) => loadWorkspaceGovernanceSigningKey(workspaceId, AUTHORITY_KEY_PURPOSE)))(workspace.id);
    const registry = await new SpecializedProfileRegistryStore(workspace.rootPath, {
        now,
        authority: createRegistryAuthority(workspace.id, key),
        anchorStore: options.anchorStore
            ?? new FileSpecializedProfileRegistryAnchorStore(DEFAULT_ANCHOR_DIRECTORY),
    }).loadOrCreate(workspace.id, 'specialized-profile-runtime-recovery');
    if (registry && registry.workspaceId !== workspace.id) {
        throw new Error(`Specialized profile registry belongs to workspace "${registry.workspaceId}", not "${workspace.id}"`);
    }
    return registry;
}

export function createRegistryAuthority(workspaceId: string, key: string | Uint8Array): SpecializedProfileRegistryAuthority {
    return {
        verifyEvaluation: ({ evaluation, version }) => {
            const attestations = evaluation.evidence.filter(({ uri }) => uri.startsWith(AUTHORITY_EVIDENCE_PREFIX));
            const expectedUri = authorityEvidenceUri('evaluation', evaluation.id);
            if (attestations.length !== 1 || attestations[0]!.uri !== expectedUri)
                return false;
            const unsigned = withoutAuthorityEvidence(evaluation);
            const expected = authorityDigest(key, {
                kind: 'evaluation',
                workspaceId,
                versionSha256: canonicalSpecializedProfileVersionHash(version),
                evaluation: unsigned,
            });
            return safeEqualHex(attestations[0]!.sha256, expected);
        },
        verifyHumanApprovalReceipt: ({ receipt, version, transition }) => {
            if (transition.approvalReceipt?.receiptId !== receipt.receiptId)
                return false;
            const attestations = receipt.evidence.filter(({ uri }) => uri.startsWith(AUTHORITY_EVIDENCE_PREFIX));
            const expectedUri = authorityEvidenceUri('approval', receipt.receiptId);
            if (attestations.length !== 1 || attestations[0]!.uri !== expectedUri)
                return false;
            const unsigned = withoutAuthorityEvidence(receipt);
            const expected = authorityDigest(key, {
                kind: 'human-approval',
                workspaceId,
                versionSha256: canonicalSpecializedProfileVersionHash(version),
                receipt: unsigned,
            });
            return safeEqualHex(attestations[0]!.sha256, expected);
        },
        attestRegistryHead: (head) => ({
            scheme: 'hmac-sha256',
            keyId: AUTHORITY_KEY_ID,
            sha256: authorityDigest(key, { kind: 'registry-head', ...head }),
        }),
        verifyRegistryHead: (document) => {
            if (document.workspaceId !== workspaceId
                || document.head.authority.scheme !== 'hmac-sha256'
                || document.head.authority.keyId !== AUTHORITY_KEY_ID
                || document.head.documentSha256 !== canonicalSpecializedProfileRegistryPayloadHash(document)) {
                return false;
            }
            const expected = authorityDigest(key, {
                kind: 'registry-head',
                workspaceId,
                revision: document.head.revision,
                documentSha256: document.head.documentSha256,
                previousDocumentSha256: document.head.previousDocumentSha256,
            });
            return safeEqualHex(document.head.authority.sha256, expected);
        },
        attestRegistryAnchor: (anchor) => ({
            scheme: 'hmac-sha256',
            keyId: AUTHORITY_KEY_ID,
            sha256: authorityDigest(key, {
                kind: 'registry-anchor',
                workspaceId,
                payloadSha256: canonicalSpecializedProfileRegistryAnchorPayloadHash(anchor),
            }),
        }),
        verifyRegistryAnchor: (anchor) => {
            if (anchor.workspaceId !== workspaceId
                || anchor.authority.scheme !== 'hmac-sha256'
                || anchor.authority.keyId !== AUTHORITY_KEY_ID)
                return false;
            const expected = authorityDigest(key, {
                kind: 'registry-anchor',
                workspaceId,
                payloadSha256: canonicalSpecializedProfileRegistryAnchorPayloadHash(anchor),
            });
            return safeEqualHex(anchor.authority.sha256, expected);
        },
    };
}

export function evaluationCampaignManifestSha256(input: {
    workspaceId: string;
    profileId: string;
    profileVersion: number;
    stage: SpecializedProfileEvaluation['stage'];
    stageEntryTransitionSequence: number;
    campaignId: string;
    missionIds: string[];
    caseFingerprints?: Record<string, string>;
}): string {
    return sha256(canonicalJson({
        schemaVersion: 1,
        workspaceId: input.workspaceId,
        profileId: input.profileId,
        profileVersion: input.profileVersion,
        stage: input.stage,
        stageEntryTransitionSequence: input.stageEntryTransitionSequence,
        campaignId: input.campaignId,
        missionCases: input.missionIds.map((missionId) => ({
            missionId,
            caseFingerprintSha256: input.caseFingerprints?.[missionId],
        })),
    }));
}

export function attestEvaluation(evaluation: SpecializedProfileEvaluation, workspaceId: string, version: SpecializedProfileVersion, key: string | Uint8Array): SpecializedProfileEvaluation {
    assertNoAuthorityEvidence(evaluation.evidence);
    if (evaluation.evidence.length >= 1000) {
        throw new Error('Evaluation evidence has no room for the required host authority attestation');
    }
    const sha256 = authorityDigest(key, {
        kind: 'evaluation',
        workspaceId,
        versionSha256: canonicalSpecializedProfileVersionHash(version),
        evaluation,
    });
    return {
        ...evaluation,
        evidence: [
            ...evaluation.evidence,
            { uri: authorityEvidenceUri('evaluation', evaluation.id), sha256 },
        ],
    };
}

export function attestApprovalReceipt(receipt: SpecializedProfileHumanApprovalReceipt, workspaceId: string, version: SpecializedProfileVersion, key: string | Uint8Array): SpecializedProfileHumanApprovalReceipt {
    assertNoAuthorityEvidence(receipt.evidence);
    if (receipt.evidence.length >= 100) {
        throw new Error('Approval evidence has no room for the required host authority attestation');
    }
    const sha256 = authorityDigest(key, {
        kind: 'human-approval',
        workspaceId,
        versionSha256: canonicalSpecializedProfileVersionHash(version),
        receipt,
    });
    return {
        ...receipt,
        evidence: [
            ...receipt.evidence,
            { uri: authorityEvidenceUri('approval', receipt.receiptId), sha256 },
        ],
    };
}

export function withoutAuthorityEvidence<T extends {
    evidence: Array<{
        uri: string;
        sha256: string;
    }>;
}>(value: T): T {
    return {
        ...value,
        evidence: value.evidence.filter(({ uri }) => !uri.startsWith(AUTHORITY_EVIDENCE_PREFIX)),
    };
}

export function assertNoAuthorityEvidence(evidence: readonly {
    uri: string;
}[]): void {
    if (evidence.some(({ uri }) => uri.startsWith(AUTHORITY_EVIDENCE_PREFIX))) {
        throw new Error('Host authority evidence is reserved and cannot be supplied by the caller');
    }
}

export function authorityEvidenceUri(kind: 'evaluation' | 'approval', id: string): string {
    return `${AUTHORITY_EVIDENCE_PREFIX}${kind}/${sha256(id)}`;
}

export function authorityDigest(key: string | Uint8Array, payload: unknown): string {
    return createHmac('sha256', key).update(canonicalJson(payload), 'utf8').digest('hex');
}

export function safeEqualHex(left: string, right: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right))
        return false;
    return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
