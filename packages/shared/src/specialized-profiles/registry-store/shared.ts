import { constants, fstatSync, lstatSync, type Stats } from "node:fs";
import { openConfinedRegularFile, unlinkConfinedRegularFile, type ConfinedRegularFile } from "../../missions/confined-file.ts";
import { SpecializedProfileHumanApprovalReceiptSchema, specializedProfileEvaluationPassesPromotionGate, type SpecializedAgentProfileDefinition, type SpecializedProfileEvaluation, type SpecializedProfileHumanApprovalReceipt, type SpecializedProfileRecord, type SpecializedProfileRegistryAnchor, type SpecializedProfileRegistryAuthorityAttestation, type SpecializedProfileRegistryDocument, type SpecializedProfileState, type SpecializedProfileTransition, type SpecializedProfileVersion } from "../schema.ts";

export const STORE_DIRECTORY_MODE = 0o700;

export const STORE_FILE_MODE = 0o600;

export const DEFAULT_LOCK_TIMEOUT_MS = 30000;

export const MIN_LOCK_TIMEOUT_MS = 1;

export const MAX_LOCK_TIMEOUT_MS = 10 * 60 * 1000;

export const HUMAN_APPROVAL_STATES = new Set<SpecializedProfileState>(['opt-in', 'canary', 'default']);

export class SpecializedProfileRegistryRevisionConflictError extends Error {
    readonly code = 'SPECIALIZED_PROFILE_REGISTRY_REVISION_CONFLICT';
    constructor(readonly expectedRevision: number, readonly actualRevision: number) {
        super(`Specialized profile registry revision conflict: expected ${expectedRevision}, current revision is ${actualRevision}`);
        this.name = 'SpecializedProfileRegistryRevisionConflictError';
    }
}

export class SpecializedProfileVersionConflictError extends Error {
    readonly code = 'SPECIALIZED_PROFILE_VERSION_CONFLICT';
    constructor(readonly profileId: string, readonly expectedVersion: number, readonly actualVersion: number) {
        super(`Specialized profile "${profileId}" version conflict: expected ${expectedVersion}, current version is ${actualVersion}`);
        this.name = 'SpecializedProfileVersionConflictError';
    }
}

export class SpecializedProfileTransitionGateError extends Error {
    readonly code = 'SPECIALIZED_PROFILE_TRANSITION_GATE_FAILED';
    constructor(message: string) {
        super(message);
        this.name = 'SpecializedProfileTransitionGateError';
    }
}

export class SpecializedProfileRegistryBusyError extends Error {
    readonly code = 'SPECIALIZED_PROFILE_REGISTRY_BUSY';
    constructor(lockPath: string) {
        super(`Specialized profile registry is busy: ${lockPath}`);
        this.name = 'SpecializedProfileRegistryBusyError';
    }
}

export interface SpecializedProfileRegistryStoreOptions {
    lockTimeoutMs?: number;
    now?: () => Date;
    authority?: SpecializedProfileRegistryAuthority;
    anchorStore?: SpecializedProfileRegistryAnchorStore;
}

export interface SpecializedProfileRegistryAuthority {
    verifyEvaluation(input: {
        evaluation: SpecializedProfileEvaluation;
        version: SpecializedProfileVersion;
    }): boolean;
    verifyHumanApprovalReceipt(input: {
        receipt: SpecializedProfileHumanApprovalReceipt;
        version: SpecializedProfileVersion;
        transition: SpecializedProfileTransition;
    }): boolean;
    attestRegistryHead(input: {
        workspaceId: string;
        revision: number;
        documentSha256: string;
        previousDocumentSha256: string | null;
    }): SpecializedProfileRegistryAuthorityAttestation;
    verifyRegistryHead(document: SpecializedProfileRegistryDocument): boolean;
    attestRegistryAnchor(input: Omit<SpecializedProfileRegistryAnchor, 'authority'>): SpecializedProfileRegistryAuthorityAttestation;
    verifyRegistryAnchor(anchor: SpecializedProfileRegistryAnchor): boolean;
}

/** Host-owned monotone head kept outside the workspace trust boundary. */
export interface SpecializedProfileRegistryAnchorStore {
    load(workspaceId: string): Promise<SpecializedProfileRegistryAnchor | null>;
    save(workspaceId: string, anchor: SpecializedProfileRegistryAnchor): Promise<void>;
}

export function requireProfile(document: SpecializedProfileRegistryDocument, profileId: string): SpecializedProfileRecord {
    const profile = document.profiles.find((entry) => entry.id === profileId);
    if (!profile)
        throw new Error(`Specialized profile "${profileId}" does not exist`);
    return profile;
}

export function assertProfileVersion(profile: SpecializedProfileRecord, expectedVersion: number): void {
    if (profile.currentVersion !== expectedVersion) {
        throw new SpecializedProfileVersionConflictError(profile.id, expectedVersion, profile.currentVersion);
    }
}

export function assertMutable(profile: SpecializedProfileRecord): void {
    if (profile.currentState === 'revoked') {
        throw new Error(`Specialized profile "${profile.id}" is revoked and cannot be modified`);
    }
}

export function resetToDraft(profile: SpecializedProfileRecord, actorId: string, reason: string, occurredAt: string): void {
    const from = profile.currentState;
    profile.currentState = 'draft';
    profile.updatedAt = occurredAt;
    profile.transitions.push({
        sequence: profile.transitions.length + 1,
        profileVersion: profile.currentVersion,
        from,
        to: 'draft',
        occurredAt,
        actorId,
        reason,
        evaluationIds: [],
    });
}

export function latestEvaluation(profile: SpecializedProfileRecord, version: number, stage: SpecializedProfileEvaluation['stage']): SpecializedProfileEvaluation | undefined {
    return profile.evaluations
        .filter((evaluation) => evaluation.profileVersion === version && evaluation.stage === stage)
        .sort((left, right) => Date.parse(left.completedAt) - Date.parse(right.completedAt))
        .at(-1);
}

export function assertPassingEvaluation(evaluation: SpecializedProfileEvaluation, definition: SpecializedAgentProfileDefinition, now: Date): void {
    if (!specializedProfileEvaluationPassesPromotionGate(evaluation, definition, now)) {
        throw new SpecializedProfileTransitionGateError(`Evaluation "${evaluation.id}" does not satisfy the promotion gate`);
    }
}

export function assertApprovalReceipt(receipt: ReturnType<typeof SpecializedProfileHumanApprovalReceiptSchema.parse>, document: SpecializedProfileRegistryDocument, profile: SpecializedProfileRecord, from: SpecializedProfileState, to: SpecializedProfileState, actorId: string, evaluationIds: string[], now: Date): void {
    if (receipt.profileId !== profile.id
        || receipt.profileVersion !== profile.currentVersion
        || receipt.transition.from !== from
        || receipt.transition.to !== to) {
        throw new SpecializedProfileTransitionGateError('Human approval receipt is not bound to the exact profile version and transition');
    }
    if (receipt.reviewer.actorId !== actorId) {
        throw new SpecializedProfileTransitionGateError('Human approval reviewer must match the host-authenticated transition actor');
    }
    const currentEntry = profile.transitions.at(-1)!;
    if (receipt.authorizationContext.registryRevision !== document.revision
        || receipt.authorizationContext.registryHeadSha256 !== document.head.documentSha256
        || receipt.authorizationContext.lifecycleEntryTransitionSequence !== currentEntry.sequence
        || receipt.authorizationContext.evaluationIds.length !== evaluationIds.length
        || receipt.authorizationContext.evaluationIds.some((id, index) => id !== evaluationIds[index])) {
        throw new SpecializedProfileTransitionGateError('Human approval receipt is not bound to the exact registry head, lifecycle entry, and evaluation set');
    }
    const proposer = profile.versions[profile.currentVersion - 1]!.provenance.proposedBy.actorId;
    const versionCreator = profile.versions[profile.currentVersion - 1]!.createdBy;
    if ([proposer, versionCreator].includes(receipt.reviewer.actorId)) {
        throw new SpecializedProfileTransitionGateError('Human approval must be independent from the version proposer and creator');
    }
    if (profile.evaluations.some((evaluation) => evaluation.profileVersion === profile.currentVersion
        && evaluation.evaluator.actorId === receipt.reviewer.actorId)) {
        throw new SpecializedProfileTransitionGateError('Human approval must be independent from profile evaluators');
    }
    if (Date.parse(receipt.issuedAt) > now.getTime()) {
        throw new SpecializedProfileTransitionGateError('Human approval receipt cannot be issued in the future');
    }
    if (Date.parse(receipt.expiresAt) <= now.getTime()) {
        throw new SpecializedProfileTransitionGateError('Human approval receipt has expired');
    }
    if (profile.transitions.some((transition) => transition.approvalReceipt?.receiptId === receipt.receiptId)) {
        throw new SpecializedProfileTransitionGateError('Human approval receipt has already been consumed');
    }
    if (profile.transitions.some((transition) => transition.approvalReceipt?.authentication.eventId === receipt.authentication.eventId)) {
        throw new SpecializedProfileTransitionGateError('Human authentication event has already been consumed');
    }
}

export function normalizeIds(values: string[], label: string): string[] {
    if (values.length > 100)
        throw new Error(`${label} cannot contain more than 100 ids`);
    const normalized = values.map((value) => value.trim());
    if (normalized.some((value) => !value))
        throw new Error(`${label} cannot contain empty ids`);
    if (new Set(normalized).size !== normalized.length)
        throw new Error(`${label} ids must be unique`);
    return normalized;
}

export function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error && error.code === code;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function processIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return !isNodeError(error, 'ESRCH');
    }
}

export function removeConfinedFileIfPresent(root: string, path: string): void {
    let handle: ConfinedRegularFile;
    try {
        handle = openConfinedRegularFile(root, path, { flags: constants.O_RDONLY });
    }
    catch (error) {
        if (isNodeError(error, 'ENOENT'))
            return;
        throw error;
    }
    try {
        unlinkConfinedRegularFile(handle);
    }
    finally {
        handle.close();
    }
}

export function assertConfinedFileOrAbsent(root: string, path: string): void {
    let handle: ConfinedRegularFile;
    try {
        handle = openConfinedRegularFile(root, path, { flags: constants.O_RDONLY });
    }
    catch (error) {
        if (isNodeError(error, 'ENOENT'))
            return;
        throw error;
    }
    handle.close();
}

export function assertPinnedDirectory(path: string, descriptor: number, initial: Stats): void {
    const currentPath = lstatSync(path);
    const currentDescriptor = fstatSync(descriptor);
    if (!currentPath.isDirectory()
        || currentPath.isSymbolicLink()
        || currentPath.dev !== initial.dev
        || currentPath.ino !== initial.ino
        || currentDescriptor.dev !== initial.dev
        || currentDescriptor.ino !== initial.ino) {
        throw new Error(`Specialized profile registry directory changed while in use: ${path}`);
    }
}

export function registryAnchorRef(document: SpecializedProfileRegistryDocument): SpecializedProfileRegistryAnchor['committed'] & {} {
    return {
        revision: document.revision,
        documentSha256: document.head.documentSha256,
    };
}

export function sameAnchorRef(left: SpecializedProfileRegistryAnchor['committed'] | undefined, right: SpecializedProfileRegistryAnchor['committed'] | undefined): boolean {
    return left !== null
        && left !== undefined
        && right !== null
        && right !== undefined
        && left.revision === right.revision
        && left.documentSha256 === right.documentSha256;
}
