import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { join } from 'node:path';
import {
  canonicalConfinementRoot,
  ensureConfinedDirectory,
  openConfinedRegularFile,
  unlinkConfinedRegularFile,
  type ConfinedRegularFile,
} from '../missions/confined-file.ts';
import {
  SpecializedAgentProfileDefinitionSchema,
  SPECIALIZED_PROFILE_ALLOWED_TRANSITIONS,
  SPECIALIZED_PROFILE_REQUIRED_EVALUATION_STAGE,
  SpecializedProfileEvaluationSchema,
  SpecializedProfileHumanApprovalReceiptSchema,
  SpecializedProfileProvenanceSchema,
  SpecializedProfileRegistryDocumentSchema,
  SpecializedProfileVersionSchema,
  specializedProfileEvaluationPassesPromotionGate,
  type CreateSpecializedProfileCandidateInput,
  type RollbackSpecializedProfileInput,
  type ReviseSpecializedProfileInput,
  type SpecializedAgentProfileDefinition,
  type SpecializedProfileEvaluation,
  type SpecializedProfileHumanApprovalReceipt,
  type SpecializedProfileRecord,
  type SpecializedProfileRegistryDocument,
  type SpecializedProfileState,
  type SpecializedProfileTransition,
  type SpecializedProfileVersion,
  type TransitionSpecializedProfileInput,
} from './schema.ts';

const STORE_DIRECTORY_MODE = 0o700;
const STORE_FILE_MODE = 0o600;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const MIN_LOCK_TIMEOUT_MS = 1;
const MAX_LOCK_TIMEOUT_MS = 10 * 60 * 1_000;

const HUMAN_APPROVAL_STATES = new Set<SpecializedProfileState>(['opt-in', 'canary', 'default']);

export class SpecializedProfileRegistryRevisionConflictError extends Error {
  readonly code = 'SPECIALIZED_PROFILE_REGISTRY_REVISION_CONFLICT';

  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`Specialized profile registry revision conflict: expected ${expectedRevision}, current revision is ${actualRevision}`);
    this.name = 'SpecializedProfileRegistryRevisionConflictError';
  }
}

export class SpecializedProfileVersionConflictError extends Error {
  readonly code = 'SPECIALIZED_PROFILE_VERSION_CONFLICT';

  constructor(
    readonly profileId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
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
}

/**
 * Durable workspace-scoped candidate registry.
 *
 * The registry records only requested capabilities. It does not grant runtime
 * permissions or select a model/provider. Promotion state is therefore an
 * auditable qualification signal, not an authorization decision.
 */
export class SpecializedProfileRegistryStore {
  readonly documentPath: string;
  readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly now: () => Date;
  private readonly authority?: SpecializedProfileRegistryAuthority;

  constructor(
    workspaceRoot: string,
    options: SpecializedProfileRegistryStoreOptions = {},
  ) {
    this.workspaceRoot = canonicalConfinementRoot(workspaceRoot);
    this.documentPath = join(this.workspaceRoot, '.robb', 'specialized-agent-profiles.json');
    this.lockPath = join(this.workspaceRoot, '.robb', 'specialized-agent-profiles.lock');
    const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    if (!Number.isSafeInteger(lockTimeoutMs)
      || lockTimeoutMs < MIN_LOCK_TIMEOUT_MS
      || lockTimeoutMs > MAX_LOCK_TIMEOUT_MS) {
      throw new RangeError(
        `lockTimeoutMs must be an integer between ${MIN_LOCK_TIMEOUT_MS} and ${MAX_LOCK_TIMEOUT_MS}`,
      );
    }
    this.lockTimeoutMs = lockTimeoutMs;
    this.now = options.now ?? (() => new Date());
    this.authority = options.authority;
  }

  private readonly workspaceRoot: string;

  async load(): Promise<SpecializedProfileRegistryDocument | null> {
    let handle: ConfinedRegularFile;
    try {
      handle = openConfinedRegularFile(this.workspaceRoot, this.documentPath, { flags: constants.O_RDONLY });
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return null;
      throw error;
    }
    try {
      const raw = readFileSync(handle.descriptor, 'utf8');
      handle.assertStillBound();
      return this.parseAndVerifyDocument(JSON.parse(raw) as unknown);
    } finally {
      handle.close();
    }
  }

  async loadOrCreate(workspaceId: string, actorId: string): Promise<SpecializedProfileRegistryDocument> {
    return this.withLock(async () => {
      const existing = await this.load();
      if (existing) {
        if (existing.workspaceId !== workspaceId) {
          throw new Error(`Specialized profile registry belongs to workspace "${existing.workspaceId}"`);
        }
        return existing;
      }
      const initial = SpecializedProfileRegistryDocumentSchema.parse({
        schemaVersion: 1,
        workspaceId,
        revision: 0,
        updatedAt: this.now().toISOString(),
        updatedBy: actorId,
        profiles: [],
      });
      this.writeDocument(initial);
      return initial;
    });
  }

  async createCandidate(
    expectedRevision: number,
    input: CreateSpecializedProfileCandidateInput,
  ): Promise<SpecializedProfileRegistryDocument> {
    return this.update(expectedRevision, input.actorId, (document, occurredAt) => {
      appendCandidate(document, input, occurredAt);
    });
  }

  async createInactiveDraft(
    expectedRevision: number,
    input: CreateSpecializedProfileCandidateInput,
    draftActorId: string,
    draftReason: string,
  ): Promise<SpecializedProfileRegistryDocument> {
    return this.update(expectedRevision, draftActorId, (document, occurredAt) => {
      const profile = appendCandidate(document, input, occurredAt);
      profile.currentState = 'draft';
      profile.transitions.push({
        sequence: 2,
        profileVersion: 1,
        from: 'candidate',
        to: 'draft',
        occurredAt,
        actorId: draftActorId,
        reason: draftReason,
        evaluationIds: [],
      });
    });
  }

  async reviseProfile(
    expectedRevision: number,
    input: ReviseSpecializedProfileInput,
  ): Promise<SpecializedProfileRegistryDocument> {
    return this.update(expectedRevision, input.actorId, (document, occurredAt) => {
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

  async recordEvaluation(
    expectedRevision: number,
    actorId: string,
    value: SpecializedProfileEvaluation,
  ): Promise<SpecializedProfileRegistryDocument> {
    return this.update(expectedRevision, actorId, (document, occurredAt) => {
      const evaluation = SpecializedProfileEvaluationSchema.parse(value);
      const profile = requireProfile(document, evaluation.profileId);
      const version = profile.versions[evaluation.profileVersion - 1];
      if (!version) {
        throw new Error(`Specialized profile "${profile.id}" version ${evaluation.profileVersion} does not exist`);
      }
      if (profile.evaluations.some((entry) => entry.id === evaluation.id)) {
        throw new Error(`Specialized profile evaluation "${evaluation.id}" already exists`);
      }
      if (actorId !== evaluation.evaluator.actorId) {
        throw new Error('Evaluation actor must match the host-authenticated evaluator');
      }
      if ([version.provenance.proposedBy.actorId, version.createdBy].includes(evaluation.evaluator.actorId)) {
        throw new Error('Specialized profile evaluation must be independent from the version proposer and creator');
      }
      if (!this.authority?.verifyEvaluation({ evaluation, version })) {
        throw new SpecializedProfileTransitionGateError(
          `Evaluation "${evaluation.id}" lacks a valid host authority attestation`,
        );
      }
      if (Date.parse(evaluation.completedAt) > this.now().getTime()) {
        throw new Error('Specialized profile evaluation completion cannot be in the future');
      }
      profile.evaluations.push(evaluation);
      profile.updatedAt = occurredAt;
    });
  }

  async transition(
    expectedRevision: number,
    input: TransitionSpecializedProfileInput,
  ): Promise<SpecializedProfileRegistryDocument> {
    return this.update(expectedRevision, input.actorId, (document, occurredAt) => {
      const profile = requireProfile(document, input.profileId);
      assertProfileVersion(profile, input.expectedCurrentVersion);
      const from = profile.currentState;
      const allowed: readonly SpecializedProfileState[] = SPECIALIZED_PROFILE_ALLOWED_TRANSITIONS[from];
      if (!allowed.includes(input.to)) {
        throw new SpecializedProfileTransitionGateError(
          `Transition from ${from} to ${input.to} is not allowed`,
        );
      }

      const evaluationIds = normalizeIds(input.evaluationIds ?? [], 'evaluationIds');
      const evaluations = evaluationIds.map((id) => {
        const evaluation = profile.evaluations.find((entry) => entry.id === id);
        if (!evaluation) throw new SpecializedProfileTransitionGateError(`Unknown evaluation "${id}"`);
        if (evaluation.profileVersion !== profile.currentVersion) {
          throw new SpecializedProfileTransitionGateError(`Evaluation "${id}" targets another profile version`);
        }
        return evaluation;
      });

      const requiredStage = SPECIALIZED_PROFILE_REQUIRED_EVALUATION_STAGE[input.to];
      if (requiredStage) {
        const latest = latestEvaluation(profile, profile.currentVersion, requiredStage);
        if (!latest || !evaluations.some((evaluation) => evaluation.id === latest.id)) {
          throw new SpecializedProfileTransitionGateError(
            `Transition to ${input.to} requires the latest ${requiredStage} evaluation`,
          );
        }
        assertPassingEvaluation(
          latest,
          profile.versions[profile.currentVersion - 1]!.definition,
          this.now(),
        );
      }

      let approvalReceipt;
      if (HUMAN_APPROVAL_STATES.has(input.to)) {
        if (!input.approvalReceipt) {
          throw new SpecializedProfileTransitionGateError(
            `Transition to ${input.to} requires a structured human approval receipt`,
          );
        }
        approvalReceipt = SpecializedProfileHumanApprovalReceiptSchema.parse(input.approvalReceipt);
        assertApprovalReceipt(approvalReceipt, profile, from, input.to, input.actorId, this.now());
      } else if (input.approvalReceipt !== undefined) {
        throw new SpecializedProfileTransitionGateError(
          'Human approval receipts are accepted only for opt-in, canary, or default promotion',
        );
      }

      const nextTransition: SpecializedProfileTransition = {
        sequence: profile.transitions.length + 1,
        profileVersion: profile.currentVersion,
        from,
        to: input.to,
        occurredAt,
        actorId: input.actorId,
        reason: input.reason,
        evaluationIds,
        ...(approvalReceipt ? { approvalReceipt } : {}),
      };
      if (approvalReceipt) {
        const version = profile.versions[profile.currentVersion - 1]!;
        if (!this.authority?.verifyHumanApprovalReceipt({
          receipt: approvalReceipt,
          version,
          transition: nextTransition,
        })) {
          throw new SpecializedProfileTransitionGateError(
            `Human approval receipt "${approvalReceipt.receiptId}" lacks a valid host authority attestation`,
          );
        }
      }
      profile.currentState = input.to;
      profile.updatedAt = occurredAt;
      profile.transitions.push(nextTransition);
    });
  }

  async rollback(
    expectedRevision: number,
    input: RollbackSpecializedProfileInput,
  ): Promise<SpecializedProfileRegistryDocument> {
    return this.update(expectedRevision, input.actorId, (document, occurredAt) => {
      const profile = requireProfile(document, input.profileId);
      assertProfileVersion(profile, input.expectedCurrentVersion);
      assertMutable(profile);
      if (input.rollbackOfVersion >= profile.currentVersion) {
        throw new Error('Rollback target must precede the current profile version');
      }
      const target = profile.versions[input.rollbackOfVersion - 1];
      if (!target) throw new Error(`Rollback target version ${input.rollbackOfVersion} does not exist`);
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

  private async update(
    expectedRevision: number,
    actorId: string,
    mutate: (document: SpecializedProfileRegistryDocument, occurredAt: string) => void,
  ): Promise<SpecializedProfileRegistryDocument> {
    return this.withLock(async () => {
      const current = await this.load();
      if (!current) throw new Error(`Specialized profile registry does not exist for workspace "${this.workspaceRoot}"`);
      if (current.revision !== expectedRevision) {
        throw new SpecializedProfileRegistryRevisionConflictError(expectedRevision, current.revision);
      }
      const next = structuredClone(current);
      const occurredAt = this.now().toISOString();
      mutate(next, occurredAt);
      next.revision += 1;
      next.updatedAt = occurredAt;
      next.updatedBy = actorId;
      const parsed = SpecializedProfileRegistryDocumentSchema.parse(next);
      this.writeDocument(parsed);
      return parsed;
    });
  }

  private parseAndVerifyDocument(value: unknown): SpecializedProfileRegistryDocument {
    const document = SpecializedProfileRegistryDocumentSchema.parse(value);
    for (const profile of document.profiles) {
      for (const evaluation of profile.evaluations) {
        const version = profile.versions[evaluation.profileVersion - 1]!;
        if (!this.authority?.verifyEvaluation({ evaluation, version })) {
          throw new SpecializedProfileTransitionGateError(
            `Evaluation "${evaluation.id}" lacks a valid host authority attestation`,
          );
        }
      }
      for (const transition of profile.transitions) {
        const receipt = transition.approvalReceipt;
        if (!receipt) continue;
        const version = profile.versions[transition.profileVersion - 1]!;
        if (!this.authority?.verifyHumanApprovalReceipt({ receipt, version, transition })) {
          throw new SpecializedProfileTransitionGateError(
            `Human approval receipt "${receipt.receiptId}" lacks a valid host authority attestation`,
          );
        }
      }
    }
    return document;
  }

  private writeDocument(document: SpecializedProfileRegistryDocument): void {
    const parsed = this.parseAndVerifyDocument(document);
    const directory = this.ensureStoreDirectory();
    const temporaryPath = `${this.documentPath}.${process.pid}.${randomUUID()}.tmp`;
    const directoryDescriptor = process.platform === 'win32'
      ? undefined
      : openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const directoryIdentity = directoryDescriptor === undefined ? undefined : fstatSync(directoryDescriptor);
    let temporaryHandle: ConfinedRegularFile | undefined;
    try {
      temporaryHandle = openConfinedRegularFile(this.workspaceRoot, temporaryPath, {
        flags: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        mode: STORE_FILE_MODE,
        allowCreate: true,
      });
      const payload = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
      let offset = 0;
      while (offset < payload.length) {
        offset += writeSync(temporaryHandle.descriptor, payload, offset, payload.length - offset);
      }
      fsyncSync(temporaryHandle.descriptor);
      temporaryHandle.assertStillBound();
      temporaryHandle.close();
      temporaryHandle = undefined;

      // Validate an existing destination before replacing it. This rejects
      // symbolic and hard links instead of letting rename() follow/replace them.
      assertConfinedFileOrAbsent(this.workspaceRoot, this.documentPath);
      if (directoryDescriptor !== undefined && directoryIdentity) {
        assertPinnedDirectory(directory, directoryDescriptor, directoryIdentity);
      }
      renameSync(temporaryPath, this.documentPath);
      if (directoryDescriptor !== undefined && directoryIdentity) {
        assertPinnedDirectory(directory, directoryDescriptor, directoryIdentity);
      }
      const committed = openConfinedRegularFile(this.workspaceRoot, this.documentPath, { flags: constants.O_RDONLY });
      try {
        committed.assertStillBound();
        if (process.platform !== 'win32') fchmodSync(committed.descriptor, STORE_FILE_MODE);
      } finally {
        committed.close();
      }
      if (directoryDescriptor !== undefined) fsyncSync(directoryDescriptor);
    } catch (error) {
      temporaryHandle?.close();
      removeConfinedFileIfPresent(this.workspaceRoot, temporaryPath);
      throw error;
    } finally {
      if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    this.ensureStoreDirectory();
    const handle = this.acquireLock();
    try {
      return await operation();
    } finally {
      try {
        unlinkConfinedRegularFile(handle);
      } finally {
        handle.close();
      }
    }
  }

  private acquireLock(): ConfinedRegularFile {
    const createLock = () => {
      const handle = openConfinedRegularFile(this.workspaceRoot, this.lockPath, {
        flags: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        mode: STORE_FILE_MODE,
        allowCreate: true,
      });
      writeSync(handle.descriptor, JSON.stringify({ pid: process.pid, acquiredAt: this.now().toISOString() }), undefined, 'utf8');
      fsyncSync(handle.descriptor);
      handle.assertStillBound();
      return handle;
    };
    try {
      return createLock();
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
    }
    let existing: ConfinedRegularFile;
    try {
      existing = openConfinedRegularFile(this.workspaceRoot, this.lockPath, { flags: constants.O_RDONLY });
      const lockStat = fstatSync(existing.descriptor);
      let ownerPid: number | undefined;
      try {
        const metadata: unknown = JSON.parse(readFileSync(existing.descriptor, 'utf8'));
        if (isRecord(metadata) && Number.isSafeInteger(metadata.pid) && Number(metadata.pid) > 0) {
          ownerPid = Number(metadata.pid);
        }
      } catch { /* age remains the fallback for malformed abandoned locks */ }
      existing.assertStillBound();
      if ((ownerPid !== undefined && processIsAlive(ownerPid))
        || this.now().getTime() - lockStat.mtimeMs <= this.lockTimeoutMs) {
        existing.close();
        throw new SpecializedProfileRegistryBusyError(this.lockPath);
      }
      try {
        unlinkConfinedRegularFile(existing);
      } finally {
        existing.close();
      }
      return createLock();
    } catch (error) {
      if (error instanceof SpecializedProfileRegistryBusyError) throw error;
      if (isNodeError(error, 'ENOENT')) return createLock();
      throw new SpecializedProfileRegistryBusyError(this.lockPath);
    }
  }

  private ensureStoreDirectory(): string {
    const directory = ensureConfinedDirectory(this.workspaceRoot, '.robb');
    if (process.platform !== 'win32') {
      const descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fchmodSync(descriptor, STORE_DIRECTORY_MODE); } finally { closeSync(descriptor); }
    }
    return directory;
  }
}

function appendCandidate(
  document: SpecializedProfileRegistryDocument,
  input: CreateSpecializedProfileCandidateInput,
  occurredAt: string,
): SpecializedProfileRecord {
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
  const profile: SpecializedProfileRecord = {
    id: version.profileId,
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
  };
  document.profiles.push(profile);
  return profile;
}

function requireProfile(
  document: SpecializedProfileRegistryDocument,
  profileId: string,
): SpecializedProfileRecord {
  const profile = document.profiles.find((entry) => entry.id === profileId);
  if (!profile) throw new Error(`Specialized profile "${profileId}" does not exist`);
  return profile;
}

function assertProfileVersion(profile: SpecializedProfileRecord, expectedVersion: number): void {
  if (profile.currentVersion !== expectedVersion) {
    throw new SpecializedProfileVersionConflictError(profile.id, expectedVersion, profile.currentVersion);
  }
}

function assertMutable(profile: SpecializedProfileRecord): void {
  if (profile.currentState === 'revoked') {
    throw new Error(`Specialized profile "${profile.id}" is revoked and cannot be modified`);
  }
}

function resetToDraft(
  profile: SpecializedProfileRecord,
  actorId: string,
  reason: string,
  occurredAt: string,
): void {
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

function latestEvaluation(
  profile: SpecializedProfileRecord,
  version: number,
  stage: SpecializedProfileEvaluation['stage'],
): SpecializedProfileEvaluation | undefined {
  return profile.evaluations
    .filter((evaluation) => evaluation.profileVersion === version && evaluation.stage === stage)
    .sort((left, right) => Date.parse(left.completedAt) - Date.parse(right.completedAt))
    .at(-1);
}

function assertPassingEvaluation(
  evaluation: SpecializedProfileEvaluation,
  definition: SpecializedAgentProfileDefinition,
  now: Date,
): void {
  if (!specializedProfileEvaluationPassesPromotionGate(evaluation, definition, now)) {
    throw new SpecializedProfileTransitionGateError(
      `Evaluation "${evaluation.id}" does not satisfy the promotion gate`,
    );
  }
}

function assertApprovalReceipt(
  receipt: ReturnType<typeof SpecializedProfileHumanApprovalReceiptSchema.parse>,
  profile: SpecializedProfileRecord,
  from: SpecializedProfileState,
  to: SpecializedProfileState,
  actorId: string,
  now: Date,
): void {
  if (receipt.profileId !== profile.id
    || receipt.profileVersion !== profile.currentVersion
    || receipt.transition.from !== from
    || receipt.transition.to !== to) {
    throw new SpecializedProfileTransitionGateError(
      'Human approval receipt is not bound to the exact profile version and transition',
    );
  }
  if (receipt.reviewer.actorId !== actorId) {
    throw new SpecializedProfileTransitionGateError(
      'Human approval reviewer must match the host-authenticated transition actor',
    );
  }
  const proposer = profile.versions[profile.currentVersion - 1]!.provenance.proposedBy.actorId;
  const versionCreator = profile.versions[profile.currentVersion - 1]!.createdBy;
  if ([proposer, versionCreator].includes(receipt.reviewer.actorId)) {
    throw new SpecializedProfileTransitionGateError('Human approval must be independent from the version proposer and creator');
  }
  if (profile.evaluations.some((evaluation) =>
    evaluation.profileVersion === profile.currentVersion
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
}

function normalizeIds(values: string[], label: string): string[] {
  if (values.length > 100) throw new Error(`${label} cannot contain more than 100 ids`);
  const normalized = values.map((value) => value.trim());
  if (normalized.some((value) => !value)) throw new Error(`${label} cannot contain empty ids`);
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} ids must be unique`);
  return normalized;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, 'ESRCH');
  }
}

function removeConfinedFileIfPresent(root: string, path: string): void {
  let handle: ConfinedRegularFile;
  try {
    handle = openConfinedRegularFile(root, path, { flags: constants.O_RDONLY });
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw error;
  }
  try {
    unlinkConfinedRegularFile(handle);
  } finally {
    handle.close();
  }
}

function assertConfinedFileOrAbsent(root: string, path: string): void {
  let handle: ConfinedRegularFile;
  try {
    handle = openConfinedRegularFile(root, path, { flags: constants.O_RDONLY });
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw error;
  }
  handle.close();
}

function assertPinnedDirectory(path: string, descriptor: number, initial: Stats): void {
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
