import { join } from "node:path";
import { canonicalConfinementRoot, type ConfinedRegularFile } from "../missions/confined-file.ts";
import { type CreateSpecializedProfileCandidateInput, type RollbackSpecializedProfileInput, type ReviseSpecializedProfileInput, type SpecializedProfileEvaluation, type SpecializedProfileEvaluationCampaign, type SpecializedProfileHumanApprovalReceipt, type SpecializedProfileRegistryAnchor, type SpecializedProfileRegistryDocument, type SpecializedProfileState, type SpecializedProfileVersion, type TransitionSpecializedProfileInput } from "./schema.ts";
import { DEFAULT_LOCK_TIMEOUT_MS, MIN_LOCK_TIMEOUT_MS, MAX_LOCK_TIMEOUT_MS } from './registry-store/shared.ts';
import type { SpecializedProfileRegistryStoreOptions, SpecializedProfileRegistryAuthority, SpecializedProfileRegistryAnchorStore } from './registry-store/shared.ts';
import * as registryStoreDocument from './registry-store/document.ts';
import * as registryStoreDraft from './registry-store/draft.ts';
import * as registryStoreEvaluation from './registry-store/evaluation.ts';
import * as registryStoreTransition from './registry-store/transition.ts';
import * as registryStoreWriting from './registry-store/writing.ts';
import * as registryStoreLocking from './registry-store/locking.ts';
export type { SpecializedProfileRegistryStoreOptions, SpecializedProfileRegistryAuthority, SpecializedProfileRegistryAnchorStore } from './registry-store/shared.ts';
export { SpecializedProfileRegistryRevisionConflictError, SpecializedProfileVersionConflictError, SpecializedProfileTransitionGateError, SpecializedProfileRegistryBusyError } from './registry-store/shared.ts';

/**
 * Durable workspace-scoped candidate registry.
 *
 * The registry records only requested capabilities. It does not grant runtime
 * permissions or select a model/provider. Promotion state is therefore an
 * auditable qualification signal, not an authorization decision.
 */
export class SpecializedProfileRegistryStore {
    readonly documentPath: string;
    readonly pendingDocumentPath: string;
    readonly lockPath: string;
    private readonly lockTimeoutMs: number;
    private readonly now: () => Date;
    private readonly authority?: SpecializedProfileRegistryAuthority;
    private readonly anchorStore?: SpecializedProfileRegistryAnchorStore;
    constructor(workspaceRoot: string, options: SpecializedProfileRegistryStoreOptions = {}) {
        this.workspaceRoot = canonicalConfinementRoot(workspaceRoot);
        this.documentPath = join(this.workspaceRoot, '.robb', 'specialized-agent-profiles.json');
        this.pendingDocumentPath = join(this.workspaceRoot, '.robb', 'specialized-agent-profiles.pending.json');
        this.lockPath = join(this.workspaceRoot, '.robb', 'specialized-agent-profiles.lock');
        const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
        if (!Number.isSafeInteger(lockTimeoutMs)
            || lockTimeoutMs < MIN_LOCK_TIMEOUT_MS
            || lockTimeoutMs > MAX_LOCK_TIMEOUT_MS) {
            throw new RangeError(`lockTimeoutMs must be an integer between ${MIN_LOCK_TIMEOUT_MS} and ${MAX_LOCK_TIMEOUT_MS}`);
        }
        this.lockTimeoutMs = lockTimeoutMs;
        this.now = options.now ?? (() => new Date());
        this.authority = options.authority;
        this.anchorStore = options.anchorStore;
    }
    private readonly workspaceRoot: string;
    async load(): Promise<SpecializedProfileRegistryDocument | null> {
        return registryStoreDocument.load(this);
    }
    private async loadDocument(recover: boolean): Promise<SpecializedProfileRegistryDocument | null> {
        return registryStoreDocument.loadDocument(this, recover);
    }
    async loadOrCreate(workspaceId: string, actorId: string): Promise<SpecializedProfileRegistryDocument> {
        return registryStoreDocument.loadOrCreate(this, workspaceId, actorId);
    }
    async createCandidate(expectedRevision: number, input: CreateSpecializedProfileCandidateInput): Promise<SpecializedProfileRegistryDocument> {
        return registryStoreDraft.createCandidate(this, expectedRevision, input);
    }
    /**
     * Atomically materialize an inactive draft. The candidate and draft history
     * entries are committed in the same registry revision, and creationRequestId
     * makes a retry return the already committed result without another write.
     */
    async createDraft(expectedRevision: number, input: CreateSpecializedProfileCandidateInput): Promise<SpecializedProfileRegistryDocument> {
        return registryStoreDraft.createDraft(this, expectedRevision, input);
    }
    async reviseProfile(expectedRevision: number, input: ReviseSpecializedProfileInput): Promise<SpecializedProfileRegistryDocument> {
        return registryStoreDraft.reviseProfile(this, expectedRevision, input);
    }
    async recordEvaluation(expectedRevision: number, actorId: string, value: SpecializedProfileEvaluation): Promise<SpecializedProfileRegistryDocument> {
        return registryStoreEvaluation.recordEvaluation(this, expectedRevision, actorId, value);
    }
    /** Reserve one Mission id in the single open host campaign for this lifecycle entry. */
    async reserveEvaluationMission(expectedRevision: number, input: {
        profileId: string;
        expectedCurrentVersion: number;
        stage: SpecializedProfileEvaluation['stage'];
        missionId: string;
        caseFingerprintSha256: string;
        actorId: string;
    }): Promise<{
        registry: SpecializedProfileRegistryDocument;
        campaign: SpecializedProfileEvaluationCampaign;
    }> {
        return registryStoreEvaluation.reserveEvaluationMission(this, expectedRevision, input);
    }
    /** Close the population before evidence collection so no late case can be omitted. */
    async closeEvaluationCampaign(expectedRevision: number, input: {
        profileId: string;
        expectedCurrentVersion: number;
        stage: SpecializedProfileEvaluation['stage'];
        campaignId: string;
        actorId: string;
    }): Promise<{
        registry: SpecializedProfileRegistryDocument;
        campaign: SpecializedProfileEvaluationCampaign;
    }> {
        return registryStoreEvaluation.closeEvaluationCampaign(this, expectedRevision, input);
    }
    async releaseEvaluationMission(expectedRevision: number, input: {
        profileId: string;
        missionId: string;
        actorId: string;
    }): Promise<SpecializedProfileRegistryDocument> {
        return registryStoreEvaluation.releaseEvaluationMission(this, expectedRevision, input);
    }
    async transition(expectedRevision: number, input: TransitionSpecializedProfileInput, createApprovalReceipt?: (context: {
        registryRevision: number;
        registryHeadSha256: string;
        lifecycleEntryTransitionSequence: number;
        evaluationIds: string[];
        from: SpecializedProfileState;
        version: SpecializedProfileVersion;
    }) => Promise<SpecializedProfileHumanApprovalReceipt>): Promise<SpecializedProfileRegistryDocument> {
        return registryStoreTransition.transition(this, expectedRevision, input, createApprovalReceipt);
    }
    async rollback(expectedRevision: number, input: RollbackSpecializedProfileInput): Promise<SpecializedProfileRegistryDocument> {
        return registryStoreTransition.rollback(this, expectedRevision, input);
    }
    private async update(expectedRevision: number, actorId: string, mutate: (document: SpecializedProfileRegistryDocument, occurredAt: string) => Promise<void> | void): Promise<SpecializedProfileRegistryDocument> {
        return registryStoreWriting.update(this, expectedRevision, actorId, mutate);
    }
    private parseAndVerifyDocument(value: unknown): SpecializedProfileRegistryDocument {
        return registryStoreDocument.parseAndVerifyDocument(this, value);
    }
    private async writeDocument(document: SpecializedProfileRegistryDocument, previous: SpecializedProfileRegistryDocument | null): Promise<void> {
        return registryStoreWriting.writeDocument(this, document, previous);
    }
    private writeDocumentFile(document: SpecializedProfileRegistryDocument, destinationPath: string): void {
        return registryStoreWriting.writeDocumentFile(this, document, destinationPath);
    }
    private promotePendingDocument(): void {
        return registryStoreWriting.promotePendingDocument(this);
    }
    private sealDocument(value: Omit<SpecializedProfileRegistryDocument, 'head'> | SpecializedProfileRegistryDocument, previousDocumentSha256: string | null): SpecializedProfileRegistryDocument {
        return registryStoreWriting.sealDocument(this, value, previousDocumentSha256);
    }
    private sealAnchor(value: Omit<SpecializedProfileRegistryAnchor, 'authority'>): SpecializedProfileRegistryAnchor {
        return registryStoreWriting.sealAnchor(this, value);
    }
    private requireDurableAuthority(): void {
        return registryStoreWriting.requireDurableAuthority(this);
    }
    private async verifyAndRecoverAnchoredDocument(document: SpecializedProfileRegistryDocument, recover: boolean): Promise<SpecializedProfileRegistryDocument> {
        return registryStoreDocument.verifyAndRecoverAnchoredDocument(this, document, recover);
    }
    private readPendingDocument(): SpecializedProfileRegistryDocument {
        return registryStoreDocument.readPendingDocument(this);
    }
    private async withLock<T>(operation: () => Promise<T>): Promise<T> {
        return registryStoreLocking.withLock<T>(this, operation);
    }
    private acquireLock(): ConfinedRegularFile {
        return registryStoreLocking.acquireLock(this);
    }
    private ensureStoreDirectory(): string {
        return registryStoreLocking.ensureStoreDirectory(this);
    }
}
