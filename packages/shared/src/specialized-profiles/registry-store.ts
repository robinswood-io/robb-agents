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
  SPECIALIZED_PROFILE_EVALUATION_ENTRY_STATE,
  SPECIALIZED_PROFILE_REQUIRED_EVALUATION_STAGE,
  SpecializedProfileEvaluationSchema,
  SpecializedProfileHumanApprovalReceiptSchema,
  SpecializedProfileProvenanceSchema,
  SpecializedProfileRegistryAnchorSchema,
  SpecializedProfileRegistryDocumentSchema,
  SpecializedProfileVersionSchema,
  canonicalSpecializedProfileRegistryPayloadHash,
  specializedProfileEvaluationPassesPromotionGate,
  specializedProfileTransitionIsPromotion,
  type CreateSpecializedProfileCandidateInput,
  type RollbackSpecializedProfileInput,
  type ReviseSpecializedProfileInput,
  type SpecializedAgentProfileDefinition,
  type SpecializedProfileEvaluation,
  type SpecializedProfileEvaluationCampaign,
  type SpecializedProfileHumanApprovalReceipt,
  type SpecializedProfileRecord,
  type SpecializedProfileRegistryAnchor,
  type SpecializedProfileRegistryAuthorityAttestation,
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

  constructor(
    workspaceRoot: string,
    options: SpecializedProfileRegistryStoreOptions = {},
  ) {
    this.workspaceRoot = canonicalConfinementRoot(workspaceRoot);
    this.documentPath = join(this.workspaceRoot, '.robb', 'specialized-agent-profiles.json');
    this.pendingDocumentPath = join(this.workspaceRoot, '.robb', 'specialized-agent-profiles.pending.json');
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
    this.anchorStore = options.anchorStore;
  }

  private readonly workspaceRoot: string;

  async load(): Promise<SpecializedProfileRegistryDocument | null> {
    return this.loadDocument(false);
  }

  private async loadDocument(recover: boolean): Promise<SpecializedProfileRegistryDocument | null> {
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
      const document = this.parseAndVerifyDocument(JSON.parse(raw) as unknown);
      return await this.verifyAndRecoverAnchoredDocument(document, recover);
    } finally {
      handle.close();
    }
  }

  async loadOrCreate(workspaceId: string, actorId: string): Promise<SpecializedProfileRegistryDocument> {
    return this.withLock(async () => {
      const existing = await this.loadDocument(true);
      if (existing) {
        if (existing.workspaceId !== workspaceId) {
          throw new Error(`Specialized profile registry belongs to workspace "${existing.workspaceId}"`);
        }
        return existing;
      }
      this.requireDurableAuthority();
      const orphanedAnchor = await this.anchorStore!.load(workspaceId);
      if (orphanedAnchor) {
        const anchor = SpecializedProfileRegistryAnchorSchema.parse(orphanedAnchor);
        if (anchor.workspaceId === workspaceId
          && this.authority!.verifyRegistryAnchor(anchor)
          && anchor.committed === null
          && anchor.pending?.revision === 0) {
          const pending = this.readPendingDocument();
          if (pending.workspaceId === workspaceId
            && pending.head.previousDocumentSha256 === null
            && sameAnchorRef(anchor.pending, registryAnchorRef(pending))) {
            this.promotePendingDocument();
            await this.anchorStore!.save(workspaceId, this.sealAnchor({
              schemaVersion: 1,
              workspaceId,
              committed: registryAnchorRef(pending),
              updatedAt: this.now().toISOString(),
            }));
            return pending;
          }
        }
        throw new SpecializedProfileTransitionGateError(
          'Specialized profile registry is missing while its host monotone anchor still exists',
        );
      }
      const initial = this.sealDocument({
        schemaVersion: 2,
        workspaceId,
        revision: 0,
        updatedAt: this.now().toISOString(),
        updatedBy: actorId,
        profiles: [],
      }, null);
      await this.writeDocument(initial, null);
      return initial;
    });
  }

  async createCandidate(
    expectedRevision: number,
    input: CreateSpecializedProfileCandidateInput,
  ): Promise<SpecializedProfileRegistryDocument> {
    return this.update(expectedRevision, input.actorId, (document, occurredAt) => {
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

  /**
   * Atomically materialize an inactive draft. The candidate and draft history
   * entries are committed in the same registry revision, and creationRequestId
   * makes a retry return the already committed result without another write.
   */
  async createDraft(
    expectedRevision: number,
    input: CreateSpecializedProfileCandidateInput,
  ): Promise<SpecializedProfileRegistryDocument> {
    return this.withLock(async () => {
      const current = await this.loadDocument(true);
      if (!current) throw new Error(`Specialized profile registry does not exist for workspace "${this.workspaceRoot}"`);
      const alreadyCommitted = current.profiles.find((profile) =>
        profile.creationRequestId === input.creationRequestId);
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
      const occurredAt = this.now().toISOString();
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
      const sealed = this.sealDocument(next, current.head.documentSha256);
      await this.writeDocument(sealed, current);
      return sealed;
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
      if (profile.evaluations.some((entry) => entry.runId === evaluation.runId)) {
        throw new Error(`Specialized profile evaluation run "${evaluation.runId}" already exists`);
      }
      if (actorId !== evaluation.evaluator.actorId) {
        throw new Error('Evaluation actor must match the host-authenticated evaluator');
      }
      if ([version.provenance.proposedBy.actorId, version.createdBy].includes(evaluation.evaluator.actorId)) {
        throw new Error('Specialized profile evaluation must be independent from the version proposer and creator');
      }
      const expectedState = SPECIALIZED_PROFILE_EVALUATION_ENTRY_STATE[evaluation.stage];
      const stageEntry = profile.transitions[evaluation.stageEntryTransitionSequence - 1];
      if (profile.currentState !== expectedState
        || !stageEntry
        || stageEntry.sequence !== evaluation.stageEntryTransitionSequence
        || stageEntry.profileVersion !== evaluation.profileVersion
        || stageEntry.to !== expectedState
        || profile.transitions.at(-1)?.sequence !== stageEntry.sequence) {
        throw new SpecializedProfileTransitionGateError(
          `Evaluation stage ${evaluation.stage} must be recorded during the exact current ${expectedState} lifecycle entry`,
        );
      }
      if (Date.parse(evaluation.startedAt) < Date.parse(stageEntry.occurredAt)) {
        throw new SpecializedProfileTransitionGateError(
          `Evaluation stage ${evaluation.stage} started before entry into ${expectedState}`,
        );
      }
      if (!this.authority?.verifyEvaluation({ evaluation, version })) {
        throw new SpecializedProfileTransitionGateError(
          `Evaluation "${evaluation.id}" lacks a valid host authority attestation`,
        );
      }
      if (Date.parse(evaluation.completedAt) > this.now().getTime()) {
        throw new Error('Specialized profile evaluation completion cannot be in the future');
      }
      const campaign = (profile.evaluationCampaigns ?? []).find((candidate) =>
        candidate.id === evaluation.cohort.id);
      if (!campaign
        || campaign.state !== 'closed'
        || campaign.evaluationId !== undefined
        || campaign.profileVersion !== evaluation.profileVersion
        || campaign.stage !== evaluation.stage
        || campaign.stageEntryTransitionSequence !== evaluation.stageEntryTransitionSequence
        || campaign.missionIds.length !== evaluation.cohort.missionIds.length
        || campaign.missionIds.some((id, index) => id !== evaluation.cohort.missionIds[index])) {
        throw new SpecializedProfileTransitionGateError(
          `Evaluation "${evaluation.id}" is not bound to one exact closed host campaign`,
        );
      }
      profile.evaluations.push(evaluation);
      campaign.evaluationId = evaluation.id;
      profile.updatedAt = occurredAt;
    });
  }

  /** Reserve one Mission id in the single open host campaign for this lifecycle entry. */
  async reserveEvaluationMission(
    expectedRevision: number,
    input: {
      profileId: string;
      expectedCurrentVersion: number;
      stage: SpecializedProfileEvaluation['stage'];
      missionId: string;
      caseFingerprintSha256: string;
      actorId: string;
    },
  ): Promise<{ registry: SpecializedProfileRegistryDocument; campaign: SpecializedProfileEvaluationCampaign }> {
    return this.withLock(async () => {
      const current = await this.loadDocument(true);
      if (!current) throw new Error(`Specialized profile registry does not exist for workspace "${this.workspaceRoot}"`);
      const currentProfile = requireProfile(current, input.profileId);
      assertProfileVersion(currentProfile, input.expectedCurrentVersion);
      const existing = (currentProfile.evaluationCampaigns ?? []).find((campaign) =>
        campaign.missionIds.includes(input.missionId));
      if (existing) {
        if (existing.state !== 'open'
          || existing.profileVersion !== currentProfile.currentVersion
          || existing.stage !== input.stage
          || existing.stageEntryTransitionSequence !== currentProfile.transitions.at(-1)?.sequence) {
          throw new SpecializedProfileTransitionGateError(
            `Evaluation Mission "${input.missionId}" is already bound to another or closed campaign`,
          );
        }
        if (existing.caseFingerprints?.[input.missionId] !== input.caseFingerprintSha256) {
          throw new SpecializedProfileTransitionGateError(
            `Evaluation Mission "${input.missionId}" changed after host case reservation`,
          );
        }
        return { registry: current, campaign: structuredClone(existing) };
      }
      if (current.revision !== expectedRevision) {
        throw new SpecializedProfileRegistryRevisionConflictError(expectedRevision, current.revision);
      }
      const expectedState = SPECIALIZED_PROFILE_EVALUATION_ENTRY_STATE[input.stage];
      const stageEntry = currentProfile.transitions.at(-1)!;
      if (currentProfile.currentState !== expectedState || stageEntry.to !== expectedState) {
        throw new SpecializedProfileTransitionGateError(
          `Evaluation stage ${input.stage} requires current lifecycle state ${expectedState}`,
        );
      }
      const next = structuredClone(current);
      const profile = requireProfile(next, input.profileId);
      const campaigns = profile.evaluationCampaigns ??= [];
      let campaign = campaigns.find((candidate) =>
        candidate.state === 'open'
        && candidate.profileVersion === profile.currentVersion
        && candidate.stage === input.stage
        && candidate.stageEntryTransitionSequence === stageEntry.sequence);
      const occurredAt = this.now().toISOString();
      if (!campaign) {
        campaign = {
          schemaVersion: 1,
          id: `profile-evaluation-campaign-${randomUUID()}`,
          profileVersion: profile.currentVersion,
          stage: input.stage,
          stageEntryTransitionSequence: stageEntry.sequence,
          state: 'open',
          missionIds: [],
          caseFingerprints: {},
          createdAt: occurredAt,
        };
        campaigns.push(campaign);
      }
      if (campaign.missionIds.length >= 499) {
        throw new SpecializedProfileTransitionGateError('Specialized profile evaluation campaign is full');
      }
      campaign.missionIds.push(input.missionId);
      campaign.missionIds.sort();
      campaign.caseFingerprints ??= {};
      campaign.caseFingerprints[input.missionId] = input.caseFingerprintSha256;
      profile.updatedAt = occurredAt;
      next.revision += 1;
      next.updatedAt = occurredAt;
      next.updatedBy = input.actorId;
      const sealed = this.sealDocument(next, current.head.documentSha256);
      await this.writeDocument(sealed, current);
      return {
        registry: sealed,
        campaign: structuredClone(requireProfile(sealed, input.profileId).evaluationCampaigns!
          .find(({ id }) => id === campaign!.id)!),
      };
    });
  }

  /** Close the population before evidence collection so no late case can be omitted. */
  async closeEvaluationCampaign(
    expectedRevision: number,
    input: {
      profileId: string;
      expectedCurrentVersion: number;
      stage: SpecializedProfileEvaluation['stage'];
      campaignId: string;
      actorId: string;
    },
  ): Promise<{ registry: SpecializedProfileRegistryDocument; campaign: SpecializedProfileEvaluationCampaign }> {
    return this.withLock(async () => {
      const current = await this.loadDocument(true);
      if (!current) throw new Error(`Specialized profile registry does not exist for workspace "${this.workspaceRoot}"`);
      const currentProfile = requireProfile(current, input.profileId);
      assertProfileVersion(currentProfile, input.expectedCurrentVersion);
      const stageEntry = currentProfile.transitions.at(-1)!;
      const campaigns = currentProfile.evaluationCampaigns ?? [];
      const retry = campaigns.find((campaign) =>
        campaign.id === input.campaignId
        &&
        campaign.state === 'closed'
        && campaign.evaluationId === undefined
        && campaign.profileVersion === currentProfile.currentVersion
        && campaign.stage === input.stage
        && campaign.stageEntryTransitionSequence === stageEntry.sequence);
      if (retry) {
        if (retry.closedFromRevision !== expectedRevision) {
          throw new SpecializedProfileRegistryRevisionConflictError(expectedRevision, current.revision);
        }
        return { registry: current, campaign: structuredClone(retry) };
      }
      if (current.revision !== expectedRevision) {
        throw new SpecializedProfileRegistryRevisionConflictError(expectedRevision, current.revision);
      }
      const open = campaigns.find((campaign) =>
        campaign.id === input.campaignId
        &&
        campaign.state === 'open'
        && campaign.profileVersion === currentProfile.currentVersion
        && campaign.stage === input.stage
        && campaign.stageEntryTransitionSequence === stageEntry.sequence);
      if (!open) throw new SpecializedProfileTransitionGateError('No open host evaluation campaign exists');
      if (open.missionIds.length < 20) {
        throw new SpecializedProfileTransitionGateError('Host evaluation campaign requires at least 20 reserved Missions');
      }
      if (!open.caseFingerprints
        || Object.keys(open.caseFingerprints).length !== open.missionIds.length
        || open.missionIds.some((missionId) => !open.caseFingerprints?.[missionId])) {
        throw new SpecializedProfileTransitionGateError(
          'Host evaluation campaign has no complete immutable case manifest',
        );
      }
      const next = structuredClone(current);
      const profile = requireProfile(next, input.profileId);
      const campaign = profile.evaluationCampaigns!.find(({ id }) => id === open.id)!;
      const occurredAt = this.now().toISOString();
      campaign.state = 'closed';
      campaign.closedAt = occurredAt;
      campaign.closedFromRevision = current.revision;
      profile.updatedAt = occurredAt;
      next.revision += 1;
      next.updatedAt = occurredAt;
      next.updatedBy = input.actorId;
      const sealed = this.sealDocument(next, current.head.documentSha256);
      await this.writeDocument(sealed, current);
      return {
        registry: sealed,
        campaign: structuredClone(requireProfile(sealed, input.profileId).evaluationCampaigns!
          .find(({ id }) => id === open.id)!),
      };
    });
  }

  async releaseEvaluationMission(
    expectedRevision: number,
    input: { profileId: string; missionId: string; actorId: string },
  ): Promise<SpecializedProfileRegistryDocument> {
    return this.withLock(async () => {
      const current = await this.loadDocument(true);
      if (!current) throw new Error(`Specialized profile registry does not exist for workspace "${this.workspaceRoot}"`);
      const currentProfile = requireProfile(current, input.profileId);
      const found = (currentProfile.evaluationCampaigns ?? []).find((campaign) =>
        campaign.missionIds.includes(input.missionId));
      if (!found) return current;
      if (found.state !== 'open') {
        throw new SpecializedProfileTransitionGateError('Closed evaluation campaign reservations cannot be released');
      }
      if (current.revision !== expectedRevision) {
        throw new SpecializedProfileRegistryRevisionConflictError(expectedRevision, current.revision);
      }
      const next = structuredClone(current);
      const profile = requireProfile(next, input.profileId);
      const campaigns = profile.evaluationCampaigns ?? [];
      const campaign = campaigns.find(({ id }) => id === found.id)!;
      campaign.missionIds = campaign.missionIds.filter((missionId) => missionId !== input.missionId);
      if (campaign.caseFingerprints) delete campaign.caseFingerprints[input.missionId];
      if (campaign.missionIds.length === 0) {
        profile.evaluationCampaigns = campaigns.filter(({ id }) => id !== campaign.id);
      }
      const occurredAt = this.now().toISOString();
      profile.updatedAt = occurredAt;
      next.revision += 1;
      next.updatedAt = occurredAt;
      next.updatedBy = input.actorId;
      const sealed = this.sealDocument(next, current.head.documentSha256);
      await this.writeDocument(sealed, current);
      return sealed;
    });
  }

  async transition(
    expectedRevision: number,
    input: TransitionSpecializedProfileInput,
    createApprovalReceipt?: (context: {
      registryRevision: number;
      registryHeadSha256: string;
      lifecycleEntryTransitionSequence: number;
      evaluationIds: string[];
      from: SpecializedProfileState;
      version: SpecializedProfileVersion;
    }) => Promise<SpecializedProfileHumanApprovalReceipt>,
  ): Promise<SpecializedProfileRegistryDocument> {
    return this.update(expectedRevision, input.actorId, async (document, occurredAt) => {
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

      const promotion = specializedProfileTransitionIsPromotion(from, input.to);
      const requiredStage = promotion
        ? SPECIALIZED_PROFILE_REQUIRED_EVALUATION_STAGE[input.to]
        : undefined;
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
        const priorCertified = profile.transitions.flatMap((transition) =>
          transition.profileVersion === profile.currentVersion
            ? transition.evaluationIds.flatMap((id) => {
                const evaluation = profile.evaluations.find((candidate) => candidate.id === id);
                return evaluation ? [evaluation] : [];
              })
            : []);
        if (priorCertified.some((evaluation) =>
          evaluation.executionRouteSha256 !== latest.executionRouteSha256
          || evaluation.capabilityEnvelopeSha256 !== latest.capabilityEnvelopeSha256)) {
          throw new SpecializedProfileTransitionGateError(
            `Transition to ${input.to} changes the route or capability envelope certified by the promotion chain`,
          );
        }
        const currentEntry = profile.transitions.at(-1)!;
        if (latest.stageEntryTransitionSequence !== currentEntry.sequence) {
          throw new SpecializedProfileTransitionGateError(
            `Transition to ${input.to} requires an evaluation from the current ${from} lifecycle entry`,
          );
        }
      }

      let approvalReceipt;
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
          throw new SpecializedProfileTransitionGateError(
            `Transition to ${input.to} requires a structured human approval receipt`,
          );
        }
        approvalReceipt = SpecializedProfileHumanApprovalReceiptSchema.parse(value);
        // Authentication may take time. The durable transition happens after
        // the receipt is issued, never at the pre-authentication timestamp.
        transitionOccurredAt = this.now().toISOString();
        assertApprovalReceipt(
          approvalReceipt,
          document,
          profile,
          from,
          input.to,
          input.actorId,
          evaluationIds,
          new Date(transitionOccurredAt),
        );
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
        occurredAt: transitionOccurredAt,
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
      profile.updatedAt = transitionOccurredAt;
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
    mutate: (
      document: SpecializedProfileRegistryDocument,
      occurredAt: string,
    ) => Promise<void> | void,
  ): Promise<SpecializedProfileRegistryDocument> {
    return this.withLock(async () => {
      const current = await this.loadDocument(true);
      if (!current) throw new Error(`Specialized profile registry does not exist for workspace "${this.workspaceRoot}"`);
      if (current.revision !== expectedRevision) {
        throw new SpecializedProfileRegistryRevisionConflictError(expectedRevision, current.revision);
      }
      const next = structuredClone(current);
      const occurredAt = this.now().toISOString();
      await mutate(next, occurredAt);
      next.revision += 1;
      const mutationCompletedAt = this.now().toISOString();
      next.updatedAt = Date.parse(mutationCompletedAt) >= Date.parse(occurredAt)
        ? mutationCompletedAt
        : occurredAt;
      next.updatedBy = actorId;
      const sealed = this.sealDocument(next, current.head.documentSha256);
      await this.writeDocument(sealed, current);
      return sealed;
    });
  }

  private parseAndVerifyDocument(value: unknown): SpecializedProfileRegistryDocument {
    const document = SpecializedProfileRegistryDocumentSchema.parse(value);
    if (!this.authority?.verifyRegistryHead(document)) {
      throw new SpecializedProfileTransitionGateError(
        'Specialized profile registry lacks a valid whole-document host attestation',
      );
    }
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

  private async writeDocument(
    document: SpecializedProfileRegistryDocument,
    previous: SpecializedProfileRegistryDocument | null,
  ): Promise<void> {
    const parsed = this.parseAndVerifyDocument(document);
    this.requireDurableAuthority();
    const committed = previous ? registryAnchorRef(previous) : null;
    const pending = registryAnchorRef(parsed);
    const pendingAnchor = this.sealAnchor({
      schemaVersion: 1,
      workspaceId: parsed.workspaceId,
      committed,
      pending,
      updatedAt: this.now().toISOString(),
    });
    this.writeDocumentFile(parsed, this.pendingDocumentPath);
    await this.anchorStore!.save(parsed.workspaceId, pendingAnchor);
    this.promotePendingDocument();
    const committedAnchor = this.sealAnchor({
      schemaVersion: 1,
      workspaceId: parsed.workspaceId,
      committed: pending,
      updatedAt: this.now().toISOString(),
    });
    await this.anchorStore!.save(parsed.workspaceId, committedAnchor);
  }

  private writeDocumentFile(document: SpecializedProfileRegistryDocument, destinationPath: string): void {
    const directory = this.ensureStoreDirectory();
    const temporaryPath = `${destinationPath}.${process.pid}.${randomUUID()}.tmp`;
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
      const payload = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
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
      assertConfinedFileOrAbsent(this.workspaceRoot, destinationPath);
      if (directoryDescriptor !== undefined && directoryIdentity) {
        assertPinnedDirectory(directory, directoryDescriptor, directoryIdentity);
      }
      renameSync(temporaryPath, destinationPath);
      if (directoryDescriptor !== undefined && directoryIdentity) {
        assertPinnedDirectory(directory, directoryDescriptor, directoryIdentity);
      }
      const committed = openConfinedRegularFile(this.workspaceRoot, destinationPath, { flags: constants.O_RDONLY });
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

  private promotePendingDocument(): void {
    const directory = this.ensureStoreDirectory();
    const directoryDescriptor = process.platform === 'win32'
      ? undefined
      : openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const directoryIdentity = directoryDescriptor === undefined ? undefined : fstatSync(directoryDescriptor);
    try {
      assertConfinedFileOrAbsent(this.workspaceRoot, this.documentPath);
      const pending = openConfinedRegularFile(this.workspaceRoot, this.pendingDocumentPath, { flags: constants.O_RDONLY });
      try { pending.assertStillBound(); } finally { pending.close(); }
      if (directoryDescriptor !== undefined && directoryIdentity) {
        assertPinnedDirectory(directory, directoryDescriptor, directoryIdentity);
      }
      renameSync(this.pendingDocumentPath, this.documentPath);
      if (directoryDescriptor !== undefined) fsyncSync(directoryDescriptor);
    } finally {
      if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
    }
  }

  private sealDocument(
    value: Omit<SpecializedProfileRegistryDocument, 'head'> | SpecializedProfileRegistryDocument,
    previousDocumentSha256: string | null,
  ): SpecializedProfileRegistryDocument {
    this.requireDurableAuthority();
    const payload = Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== 'head'),
    ) as Omit<SpecializedProfileRegistryDocument, 'head'>;
    const documentSha256 = canonicalSpecializedProfileRegistryPayloadHash(payload);
    return SpecializedProfileRegistryDocumentSchema.parse({
      ...payload,
      head: {
        schemaVersion: 1,
        revision: payload.revision,
        documentSha256,
        previousDocumentSha256,
        authority: this.authority!.attestRegistryHead({
          workspaceId: payload.workspaceId,
          revision: payload.revision,
          documentSha256,
          previousDocumentSha256,
        }),
      },
    });
  }

  private sealAnchor(
    value: Omit<SpecializedProfileRegistryAnchor, 'authority'>,
  ): SpecializedProfileRegistryAnchor {
    this.requireDurableAuthority();
    return SpecializedProfileRegistryAnchorSchema.parse({
      ...value,
      authority: this.authority!.attestRegistryAnchor(value),
    });
  }

  private requireDurableAuthority(): void {
    if (!this.authority || !this.anchorStore) {
      throw new SpecializedProfileTransitionGateError(
        'Specialized profile registry requires host authority and an external monotone anchor',
      );
    }
  }

  private async verifyAndRecoverAnchoredDocument(
    document: SpecializedProfileRegistryDocument,
    recover: boolean,
  ): Promise<SpecializedProfileRegistryDocument> {
    this.requireDurableAuthority();
    const anchorValue = await this.anchorStore!.load(document.workspaceId);
    if (!anchorValue) {
      throw new SpecializedProfileTransitionGateError(
        'Specialized profile registry has no external monotone anchor',
      );
    }
    const anchor = SpecializedProfileRegistryAnchorSchema.parse(anchorValue);
    if (anchor.workspaceId !== document.workspaceId || !this.authority!.verifyRegistryAnchor(anchor)) {
      throw new SpecializedProfileTransitionGateError(
        'Specialized profile registry external anchor is invalid',
      );
    }
    const current = registryAnchorRef(document);
    if (sameAnchorRef(anchor.pending, current)) {
      const expectedPrevious = anchor.committed?.documentSha256 ?? null;
      if (document.head.previousDocumentSha256 !== expectedPrevious) {
        throw new SpecializedProfileTransitionGateError('Specialized profile registry head chain is broken');
      }
      if (recover) {
        await this.anchorStore!.save(document.workspaceId, this.sealAnchor({
          schemaVersion: 1,
          workspaceId: document.workspaceId,
          committed: current,
          updatedAt: this.now().toISOString(),
        }));
      }
      return document;
    }
    if (sameAnchorRef(anchor.committed, current) && !anchor.pending) return document;
    if (sameAnchorRef(anchor.committed, current) && anchor.pending) {
      if (!recover) {
        throw new SpecializedProfileRegistryBusyError(this.lockPath);
      }
      const pending = this.readPendingDocument();
      if (!sameAnchorRef(anchor.pending, registryAnchorRef(pending))
        || pending.head.previousDocumentSha256 !== current.documentSha256) {
        throw new SpecializedProfileTransitionGateError('Pending specialized profile registry recovery does not match its external anchor');
      }
      this.promotePendingDocument();
      await this.anchorStore!.save(document.workspaceId, this.sealAnchor({
        schemaVersion: 1,
        workspaceId: document.workspaceId,
        committed: registryAnchorRef(pending),
        updatedAt: this.now().toISOString(),
      }));
      return pending;
    }
    throw new SpecializedProfileTransitionGateError(
      'Specialized profile registry replay or unanchored composition detected',
    );
  }

  private readPendingDocument(): SpecializedProfileRegistryDocument {
    let handle: ConfinedRegularFile;
    try {
      handle = openConfinedRegularFile(this.workspaceRoot, this.pendingDocumentPath, { flags: constants.O_RDONLY });
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        throw new SpecializedProfileTransitionGateError('Pending specialized profile registry document is missing');
      }
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
  document: SpecializedProfileRegistryDocument,
  profile: SpecializedProfileRecord,
  from: SpecializedProfileState,
  to: SpecializedProfileState,
  actorId: string,
  evaluationIds: string[],
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
  const currentEntry = profile.transitions.at(-1)!;
  if (receipt.authorizationContext.registryRevision !== document.revision
    || receipt.authorizationContext.registryHeadSha256 !== document.head.documentSha256
    || receipt.authorizationContext.lifecycleEntryTransitionSequence !== currentEntry.sequence
    || receipt.authorizationContext.evaluationIds.length !== evaluationIds.length
    || receipt.authorizationContext.evaluationIds.some((id, index) => id !== evaluationIds[index])) {
    throw new SpecializedProfileTransitionGateError(
      'Human approval receipt is not bound to the exact registry head, lifecycle entry, and evaluation set',
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
  if (profile.transitions.some((transition) =>
    transition.approvalReceipt?.authentication.eventId === receipt.authentication.eventId)) {
    throw new SpecializedProfileTransitionGateError('Human authentication event has already been consumed');
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

function registryAnchorRef(
  document: SpecializedProfileRegistryDocument,
): SpecializedProfileRegistryAnchor['committed'] & {} {
  return {
    revision: document.revision,
    documentSha256: document.head.documentSha256,
  };
}

function sameAnchorRef(
  left: SpecializedProfileRegistryAnchor['committed'] | undefined,
  right: SpecializedProfileRegistryAnchor['committed'] | undefined,
): boolean {
  return left !== null
    && left !== undefined
    && right !== null
    && right !== undefined
    && left.revision === right.revision
    && left.documentSha256 === right.documentSha256;
}
