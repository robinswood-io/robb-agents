import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  constants,
  ftruncateSync,
  fsyncSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  connectorPackTemplates,
  type PriorityConnectorPack,
} from '@craft-agent/shared/connectors';
import {
  canonicalOperationValue,
  capabilityOperationRequestHash,
  OperationApprovalContextSchema,
  parseSignedExecutionProof,
  type ExecutionProofVerificationDecision,
  type OperationApprovalContext,
  type OperationRiskLevel,
  type SignedExecutionProof,
  type TaskExecutionProofBinding,
} from '@craft-agent/shared/governance';
import {
  canonicalConfinementRoot,
  ensureConfinedDirectory,
  MISSION_ID_RE,
  openConfinedRegularFile,
  unlinkConfinedRegularFile,
  type ConfinedRegularFile,
  type MissionConnectorInvocation,
  type MissionExecutionBinding,
} from '@craft-agent/shared/missions';
import type {
  ConnectorAuthorizationResult,
  ConnectorExecutionRuntime,
  PreparedConnectorInvocation,
} from '../services/connector-execution-runtime.ts';
import type {
  MissionExecutionInput,
  MissionExecutionResult,
  MissionWorkExecutor,
} from './MissionRuntime.ts';

const STATE_SCHEMA_VERSION = 1 as const;
const RECEIPT_SCHEMA_VERSION = 1 as const;
const LOCK_STALE_MS = 5 * 60 * 1_000;

type ConnectorChokePoint = Pick<ConnectorExecutionRuntime,
  'prepare' | 'authorize' | 'invokeAuthorized' | 'resolveApproval'>;

export type MissionConnectorRecoveryResult =
  | { status: 'confirmed'; proof: SignedExecutionProof }
  /** Authoritative negative lookup for this exact idempotency key; never an eventual-consistency miss. */
  | { status: 'absent'; observedAt: string }
  | { status: 'diverged'; reason: string; observedAt: string }
  | { status: 'unknown'; reason: string };

export interface MissionConnectorRecoveryRequest {
  workspaceId: string;
  missionId: string;
  workItemId: string;
  requestHash: string;
  idempotencyKey: string;
  invocation: MissionConnectorInvocation;
}

interface DurableApprovalDecision {
  approvalId: string;
  requestHash: string;
  decision: 'approved' | 'denied';
  resolvedBy: string;
  resolvedAt: string;
  expiresAt: string;
  signature: string;
}

export interface PendingMissionConnectorApproval {
  workspaceId: string;
  missionId: string;
  workItemId: string;
  approvalId: string;
  requestHash: string;
  operationId: string;
  risk: OperationRiskLevel;
  approvalContext: OperationApprovalContext;
  expiresAt: string;
}

interface DurablePendingMissionConnectorApproval extends Omit<PendingMissionConnectorApproval, 'workspaceId'> {
  /** HMAC over requestHash plus every value-free field shown to the approver. */
  bindingSignature: string;
}

interface ConnectorExecutionState {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  revision: number;
  workspaceId: string;
  missionId: string;
  workItemId: string;
  dispatchId: string;
  idempotencyKey: string;
  requestHash: string;
  requestedAt: string;
  operationId: string;
  compensation: MissionConnectorInvocation['compensation'];
  status:
    | 'prepared'
    | 'waiting-approval'
    | 'approved'
    | 'executing'
    | 'executed'
    | 'denied'
    | 'compensation-required';
  pendingApproval?: DurablePendingMissionConnectorApproval;
  approval?: DurableApprovalDecision;
  proof?: SignedExecutionProof;
  receiptUri?: string;
  failureReason?: string;
  updatedAt: string;
}

interface MutationReceipt {
  schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  kind: 'brokered-connector-mutation';
  workspaceId: string;
  missionId: string;
  workItemId: string;
  connectorPack: string;
  operationId: string;
  requestHash: string;
  idempotencyKey: string;
  compensation: MissionConnectorInvocation['compensation'];
  proof: SignedExecutionProof;
  issuedAt: string;
}

export interface BrokeredMissionConnectorExecutorOptions {
  workspaceId: string;
  workspaceRoot: string;
  runtime: ConnectorChokePoint;
  /** Human/service actor on whose behalf the host requests the capability. */
  actorId: string;
  approvalSigningKey: string | Uint8Array;
  verifyExecutionProof: (
    proof: SignedExecutionProof,
    binding: TaskExecutionProofBinding,
  ) => ExecutionProofVerificationDecision;
  /** Provider lookup by idempotency key. It must never mutate provider state. */
  recoverMutation: (request: MissionConnectorRecoveryRequest) => Promise<MissionConnectorRecoveryResult>;
  clientId?: string;
  now?: () => string;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return errorCode(error) !== 'ESRCH'; }
}

function assertStorageSlug(label: 'mission' | 'work item', value: string): void {
  if (!MISSION_ID_RE.test(value)) throw new Error(`Invalid ${label} id "${value}"`);
}

function readConfinedJson(handle: ConfinedRegularFile, label: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(handle.descriptor, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid`, { cause: error });
  }
  handle.assertStillBound();
  return value;
}

function writeConfinedJson(
  handle: ConfinedRegularFile,
  value: unknown,
  options: { truncate?: boolean } = {},
): void {
  const payload = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  handle.assertStillBound();
  if (options.truncate === true) ftruncateSync(handle.descriptor, 0);
  let offset = 0;
  while (offset < payload.byteLength) {
    const written = writeSync(handle.descriptor, payload, offset, payload.byteLength - offset, offset);
    if (written <= 0) throw new Error(`Failed to make progress writing confined file: ${handle.path}`);
    offset += written;
  }
  fsyncSync(handle.descriptor);
  handle.assertStillBound();
}

function removeStaleLock(workspaceRoot: string, path: string): boolean {
  let handle: ConfinedRegularFile;
  try {
    handle = openConfinedRegularFile(workspaceRoot, path, { flags: constants.O_RDONLY });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return true;
    throw error;
  }
  try {
    let ownerDead = false;
    try {
      const value = readConfinedJson(handle, 'Mission connector state lock') as { pid?: unknown };
      ownerDead = typeof value.pid === 'number' && !processAlive(value.pid);
    } catch { /* Lock age is the fallback proof. */ }
    handle.assertStillBound();
    if (!ownerDead && Date.now() - handle.initialStat.mtimeMs <= LOCK_STALE_MS) return false;
    unlinkConfinedRegularFile(handle);
    return true;
  } finally {
    handle.close();
  }
}

function withLock<T>(
  workspaceRoot: string,
  path: string,
  operation: (lock: ConfinedRegularFile) => T,
): T {
  let handle: ConfinedRegularFile | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      handle = openConfinedRegularFile(workspaceRoot, path, {
        flags: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        mode: 0o600,
        allowCreate: true,
      });
      break;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      if (removeStaleLock(workspaceRoot, path)) continue;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
  }
  if (handle === undefined) throw new Error('Mission connector state lock is unavailable');
  try {
    writeConfinedJson(handle, { pid: process.pid, at: new Date().toISOString() });
    return operation(handle);
  } finally {
    try {
      unlinkConfinedRegularFile(handle);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    } finally {
      handle.close();
    }
  }
}

function assertState(value: unknown): ConnectorExecutionState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Mission connector state is invalid');
  const state = value as Partial<ConnectorExecutionState>;
  if (
    state.schemaVersion !== STATE_SCHEMA_VERSION
    || !Number.isInteger(state.revision) || Number(state.revision) < 1
    || typeof state.workspaceId !== 'string'
    || typeof state.missionId !== 'string' || !MISSION_ID_RE.test(state.missionId)
    || typeof state.workItemId !== 'string' || !MISSION_ID_RE.test(state.workItemId)
    || typeof state.dispatchId !== 'string'
    || typeof state.idempotencyKey !== 'string'
    || !/^[a-f0-9]{64}$/.test(String(state.requestHash))
    || typeof state.requestedAt !== 'string' || !Number.isFinite(Date.parse(state.requestedAt))
    || typeof state.operationId !== 'string'
    || !state.compensation || typeof state.compensation !== 'object'
    || !['prepared', 'waiting-approval', 'approved', 'executing', 'executed', 'denied', 'compensation-required'].includes(String(state.status))
    || typeof state.updatedAt !== 'string' || !Number.isFinite(Date.parse(state.updatedAt))
  ) {
    throw new Error('Mission connector state is invalid');
  }
  if (state.pendingApproval && (
    typeof state.pendingApproval.missionId !== 'string' || !MISSION_ID_RE.test(state.pendingApproval.missionId)
    || typeof state.pendingApproval.workItemId !== 'string' || !MISSION_ID_RE.test(state.pendingApproval.workItemId)
    || typeof state.pendingApproval.approvalId !== 'string'
    || !/^[a-f0-9]{64}$/.test(state.pendingApproval.requestHash)
    || typeof state.pendingApproval.operationId !== 'string'
    || !['R0', 'R1', 'W1', 'W2', 'W3'].includes(state.pendingApproval.risk)
    || !OperationApprovalContextSchema.safeParse(state.pendingApproval.approvalContext).success
    || !Number.isFinite(Date.parse(state.pendingApproval.expiresAt))
    || typeof state.pendingApproval.bindingSignature !== 'string'
  )) throw new Error('Mission connector pending approval is invalid');
  if (state.approval && (
    typeof state.approval.approvalId !== 'string'
    || !/^[a-f0-9]{64}$/.test(state.approval.requestHash)
    || !['approved', 'denied'].includes(state.approval.decision)
    || typeof state.approval.resolvedBy !== 'string'
    || !Number.isFinite(Date.parse(state.approval.resolvedAt))
    || !Number.isFinite(Date.parse(state.approval.expiresAt))
    || typeof state.approval.signature !== 'string'
  )) throw new Error('Mission connector approval decision is invalid');
  if (state.status === 'waiting-approval' && !state.pendingApproval) {
    throw new Error('Mission connector waiting state has no approval request');
  }
  if (state.status === 'executed' && (!state.proof || typeof state.receiptUri !== 'string')) {
    throw new Error('Mission connector executed state has no proof receipt');
  }
  if (state.proof) parseSignedExecutionProof(state.proof);
  return state as ConnectorExecutionState;
}

function assertReceipt(value: unknown): MutationReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Mission connector receipt is invalid');
  }
  const receipt = value as Partial<MutationReceipt>;
  if (
    receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION
    || receipt.kind !== 'brokered-connector-mutation'
    || typeof receipt.workspaceId !== 'string'
    || typeof receipt.missionId !== 'string' || !MISSION_ID_RE.test(receipt.missionId)
    || typeof receipt.workItemId !== 'string' || !MISSION_ID_RE.test(receipt.workItemId)
    || typeof receipt.connectorPack !== 'string'
    || typeof receipt.operationId !== 'string'
    || !/^[a-f0-9]{64}$/.test(String(receipt.requestHash))
    || typeof receipt.idempotencyKey !== 'string'
    || !receipt.compensation || typeof receipt.compensation !== 'object'
    || !Number.isFinite(Date.parse(String(receipt.issuedAt)))
    || !receipt.proof
  ) {
    throw new Error('Mission connector receipt is invalid');
  }
  parseSignedExecutionProof(receipt.proof);
  return receipt as MutationReceipt;
}

function sameReceiptMutation(left: MutationReceipt, right: MutationReceipt): boolean {
  const { issuedAt: _leftIssuedAt, ...leftIdentity } = left;
  const { issuedAt: _rightIssuedAt, ...rightIdentity } = right;
  return canonicalOperationValue(leftIdentity) === canonicalOperationValue(rightIdentity);
}

class MissionConnectorStateStore {
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string, private readonly workspaceId: string) {
    this.workspaceRoot = canonicalConfinementRoot(workspaceRoot);
  }

  read(missionId: string, workItemId: string): ConnectorExecutionState | null {
    this.assertIds(missionId, workItemId);
    return this.readStateAtPath(this.statePath(missionId, workItemId), missionId, workItemId);
  }

  initialize(initial: ConnectorExecutionState): ConnectorExecutionState {
    const validated = assertState(initial);
    this.assertStateBinding(validated, initial.missionId, initial.workItemId);
    const path = join(this.ensureDirectory(initial.missionId), `${initial.workItemId}.state.json`);
    return withLock(this.workspaceRoot, `${path}.lock`, (lock) => {
      lock.assertStillBound();
      const existing = this.readStateAtPath(path, initial.missionId, initial.workItemId);
      if (existing) {
        lock.assertStillBound();
        return existing;
      }

      let handle: ConfinedRegularFile;
      try {
        handle = openConfinedRegularFile(this.workspaceRoot, path, {
          flags: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          mode: 0o600,
          allowCreate: true,
        });
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
        const raced = this.readStateAtPath(path, initial.missionId, initial.workItemId);
        if (!raced) throw new Error('Mission connector state creation raced with removal');
        lock.assertStillBound();
        return raced;
      }
      try {
        // If the parent was replaced while the missing leaf was opened, the
        // lock binding fails before any state bytes are written.
        lock.assertStillBound();
        writeConfinedJson(handle, validated);
        lock.assertStillBound();
        return structuredClone(validated);
      } finally {
        handle.close();
      }
    });
  }

  update(
    missionId: string,
    workItemId: string,
    expectedRevision: number,
    update: (state: ConnectorExecutionState) => ConnectorExecutionState,
  ): ConnectorExecutionState {
    this.assertIds(missionId, workItemId);
    const path = join(this.ensureDirectory(missionId), `${workItemId}.state.json`);
    return withLock(this.workspaceRoot, `${path}.lock`, (lock) => {
      let handle: ConfinedRegularFile;
      try {
        handle = openConfinedRegularFile(this.workspaceRoot, path, { flags: constants.O_RDWR });
      } catch (error) {
        if (errorCode(error) === 'ENOENT') throw new Error('Mission connector state is unavailable');
        throw error;
      }
      try {
        const current = this.stateFromHandle(handle, missionId, workItemId);
        if (current.revision !== expectedRevision) throw new Error('Mission connector state changed concurrently');
        const next = assertState({ ...update(structuredClone(current)), revision: current.revision + 1 });
        this.assertStateBinding(next, missionId, workItemId);
        // Read and rewrite the same pinned descriptor. A final-component swap
        // can no longer redirect the truncation/write to an attacker file.
        lock.assertStillBound();
        writeConfinedJson(handle, next, { truncate: true });
        lock.assertStillBound();
        return next;
      } finally {
        handle.close();
      }
    });
  }

  writeReceipt(missionId: string, workItemId: string, receipt: MutationReceipt): string {
    this.assertIds(missionId, workItemId);
    const validated = assertReceipt(receipt);
    this.assertReceiptBinding(validated, missionId, workItemId);
    const path = join(this.ensureDirectory(missionId), `${workItemId}.receipt.json`);
    const uri = relative(this.workspaceRoot, path).split(sep).join('/');
    return withLock(this.workspaceRoot, `${path}.lock`, (lock) => {
      let handle: ConfinedRegularFile;
      try {
        handle = openConfinedRegularFile(this.workspaceRoot, path, {
          flags: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          mode: 0o600,
          allowCreate: true,
        });
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
        const existing = this.readReceiptAtPath(path, missionId, workItemId);
        if (!existing || !sameReceiptMutation(existing, validated)) {
          throw new Error('Mission connector receipt already exists with another mutation identity');
        }
        lock.assertStillBound();
        return uri;
      }
      try {
        lock.assertStillBound();
        writeConfinedJson(handle, validated);
        lock.assertStillBound();
        return uri;
      } finally {
        handle.close();
      }
    });
  }

  readReceipt(missionId: string, workItemId: string): MutationReceipt | null {
    this.assertIds(missionId, workItemId);
    return this.readReceiptAtPath(
      join(this.directory(missionId), `${workItemId}.receipt.json`),
      missionId,
      workItemId,
    );
  }

  private assertIds(missionId: string, workItemId: string): void {
    assertStorageSlug('mission', missionId);
    assertStorageSlug('work item', workItemId);
  }

  private assertStateBinding(state: ConnectorExecutionState, missionId: string, workItemId: string): void {
    if (
      state.workspaceId !== this.workspaceId
      || state.missionId !== missionId
      || state.workItemId !== workItemId
    ) {
      throw new Error('Mission connector state does not match its confined storage path');
    }
  }

  private assertReceiptBinding(receipt: MutationReceipt, missionId: string, workItemId: string): void {
    if (
      receipt.workspaceId !== this.workspaceId
      || receipt.missionId !== missionId
      || receipt.workItemId !== workItemId
    ) {
      throw new Error('Mission connector receipt does not match its confined storage path');
    }
  }

  private stateFromHandle(
    handle: ConfinedRegularFile,
    missionId: string,
    workItemId: string,
  ): ConnectorExecutionState {
    const state = assertState(readConfinedJson(handle, 'Mission connector state'));
    this.assertStateBinding(state, missionId, workItemId);
    return state;
  }

  private readStateAtPath(
    path: string,
    missionId: string,
    workItemId: string,
  ): ConnectorExecutionState | null {
    let handle: ConfinedRegularFile;
    try {
      handle = openConfinedRegularFile(this.workspaceRoot, path, { flags: constants.O_RDONLY });
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
    try {
      return this.stateFromHandle(handle, missionId, workItemId);
    } finally {
      handle.close();
    }
  }

  private readReceiptAtPath(
    path: string,
    missionId: string,
    workItemId: string,
  ): MutationReceipt | null {
    let handle: ConfinedRegularFile;
    try {
      handle = openConfinedRegularFile(this.workspaceRoot, path, { flags: constants.O_RDONLY });
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
    try {
      const receipt = assertReceipt(readConfinedJson(handle, 'Mission connector receipt'));
      this.assertReceiptBinding(receipt, missionId, workItemId);
      return receipt;
    } finally {
      handle.close();
    }
  }

  private ensureDirectory(missionId: string): string {
    assertStorageSlug('mission', missionId);
    return ensureConfinedDirectory(this.workspaceRoot, 'missions', missionId, 'connector-executions');
  }

  private directory(missionId: string): string {
    assertStorageSlug('mission', missionId);
    return join(this.workspaceRoot, 'missions', missionId, 'connector-executions');
  }

  private statePath(missionId: string, workItemId: string): string {
    this.assertIds(missionId, workItemId);
    return join(this.directory(missionId), `${workItemId}.state.json`);
  }
}

function requirePack(value: string): PriorityConnectorPack {
  if (!Object.hasOwn(connectorPackTemplates, value)) throw new Error(`Unknown priority connector pack "${value}"`);
  return value as PriorityConnectorPack;
}

function connectorInvocation(input: MissionExecutionInput): MissionConnectorInvocation {
  assertStorageSlug('mission', input.mission.id);
  assertStorageSlug('work item', input.item.id);
  const invocation = input.item.connectorInvocation;
  if (input.item.effect !== 'external-mutation' || !invocation) {
    throw new Error('Brokered connector executor accepts external-mutation work only');
  }
  return invocation;
}

function idempotencyKey(input: MissionExecutionInput): string {
  const digest = createHash('sha256')
    .update(canonicalOperationValue(connectorInvocation(input)), 'utf8')
    .digest('hex')
    .slice(0, 24);
  return `mission:${input.mission.id}:${input.item.id}:${digest}`;
}

function bindingFor(input: MissionExecutionInput): TaskExecutionProofBinding {
  return {
    workspaceId: '',
    missionId: input.mission.id,
    nodeId: input.item.id,
    idempotencyKey: idempotencyKey(input),
  };
}

function resultProof(output: Record<string, unknown>): SignedExecutionProof {
  if (!('executionProof' in output)) throw new Error('Connector result has no execution proof');
  return parseSignedExecutionProof(output.executionProof);
}

/**
 * External-mutation leaf worker. It never opens a model/tool session: the only
 * mutation boundary is ConnectorExecutionRuntime after a durable WAL record.
 */
export class BrokeredMissionConnectorExecutor implements MissionWorkExecutor {
  private readonly approvalKey: Buffer;
  private readonly store: MissionConnectorStateStore;
  private readonly now: () => string;

  constructor(private readonly options: BrokeredMissionConnectorExecutorOptions) {
    if (!options.workspaceId.trim() || !options.actorId.trim()) {
      throw new Error('Brokered Mission connector executor requires workspace and actor identities');
    }
    this.approvalKey = Buffer.from(options.approvalSigningKey);
    if (this.approvalKey.byteLength < 32) throw new Error('Mission connector approval key must contain at least 32 bytes');
    this.store = new MissionConnectorStateStore(options.workspaceRoot, options.workspaceId);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async prepare(input: MissionExecutionInput): Promise<MissionExecutionBinding> {
    connectorInvocation(input);
    return { executorKind: 'connector-broker', executionId: idempotencyKey(input) };
  }

  async execute(
    input: MissionExecutionInput,
    binding: MissionExecutionBinding,
  ): Promise<MissionExecutionResult> {
    const invocation = connectorInvocation(input);
    const expectedKey = idempotencyKey(input);
    if (binding.executorKind !== 'connector-broker' || binding.executionId !== expectedKey) {
      return this.failed('Mission connector binding mismatch', false);
    }

    let state = this.store.read(input.mission.id, input.item.id);
    if (state && !this.matchesState(state, input, expectedKey)
        && !(state.status === 'executed' && this.matchesCompletedIdentity(state, input, expectedKey))) {
      return this.failed('Durable connector state does not match this Mission dispatch', true);
    }
    if (state?.status === 'executed') return this.submissionFromCompleted(input, state);
    if (state?.status === 'denied') return this.failed(state.failureReason ?? 'Connector approval denied', false);
    if (state?.status === 'compensation-required') {
      return this.failed(state.failureReason ?? 'Provider reconciliation diverged; explicit compensation is required', true);
    }
    if (state?.status === 'executing') {
      const recovered = await this.recover(input, state, invocation);
      if (recovered.result) return recovered.result;
      state = recovered.state;
    }
    const approvalExpired = (
      state?.status === 'waiting-approval'
      && !state.approval
      && Boolean(state.pendingApproval)
      && Date.parse(state.pendingApproval!.expiresAt) <= Date.parse(this.now())
    ) || (
      state?.status === 'approved'
      && state.approval?.decision === 'approved'
      && Date.parse(state.approval.expiresAt) <= Date.parse(this.now())
    );
    if (state?.status === 'waiting-approval' && !state.approval && !approvalExpired) {
      return this.approvalResult(state);
    }

    let prepared: PreparedConnectorInvocation;
    try {
      prepared = this.options.runtime.prepare({
        pack: requirePack(invocation.pack),
        sessionId: binding.executionId,
        operationId: invocation.operationId,
        identity: {
          clientId: this.options.clientId ?? 'robb-agents-mission-host',
          missionId: input.mission.id,
          nodeId: input.item.id,
          agentId: input.profile.id,
          actorId: this.options.actorId,
        },
        autonomy: invocation.autonomy,
        resourceType: invocation.resourceType,
        ...(invocation.resourceId ? { resourceId: invocation.resourceId } : {}),
        payload: structuredClone(invocation.payload),
        idempotencyKey: expectedKey,
        compensation: invocation.compensation,
        requestedAt: approvalExpired ? this.now() : state?.requestedAt ?? this.now(),
      });
    } catch (error) {
      return this.failed(`Connector preparation failed: ${this.errorMessage(error)}`, false);
    }
    const requestHash = capabilityOperationRequestHash(prepared.request);
    if (!state) {
      const createdAt = prepared.request.requestedAt;
      state = this.store.initialize({
        schemaVersion: STATE_SCHEMA_VERSION,
        revision: 1,
        workspaceId: this.options.workspaceId,
        missionId: input.mission.id,
        workItemId: input.item.id,
        dispatchId: input.dispatchId,
        idempotencyKey: expectedKey,
        requestHash,
        requestedAt: createdAt,
        operationId: invocation.operationId,
        compensation: invocation.compensation,
        status: 'prepared',
        updatedAt: this.now(),
      });
      if (state.requestedAt !== createdAt) {
        return this.failed('Connector execution was initialized concurrently; retry recovery', false);
      }
    } else if (approvalExpired) {
      state = this.store.update(input.mission.id, input.item.id, state.revision, (current) => ({
        ...current,
        status: 'prepared',
        requestHash,
        requestedAt: prepared.request.requestedAt,
        pendingApproval: undefined,
        approval: undefined,
        updatedAt: this.now(),
      }));
    }
    if (state.requestHash !== requestHash) {
      return this.failed('Connector request changed after durable preparation; policy or registry drifted', false);
    }

    let authorization: ConnectorAuthorizationResult;
    try {
      authorization = this.options.runtime.authorize(prepared.preparationId);
      if (authorization.status === 'approval-required' && state.approval?.decision === 'approved') {
        if (!this.verifyApproval(state.approval) || state.approval.requestHash !== authorization.requestHash) {
          return this.failed('Durable connector approval is invalid or bound to another request', false);
        }
        const resolved = this.options.runtime.resolveApproval(
          authorization.approval.approvalId,
          'approved',
          state.approval.resolvedBy,
        );
        if (resolved.status !== 'approved') return this.failed(`Capability approval failed: ${resolved.reason}`, false);
        authorization = this.options.runtime.authorize(prepared.preparationId, authorization.approval.approvalId);
      }
    } catch (error) {
      return this.failed(`Connector authorization failed: ${this.errorMessage(error)}`, false);
    }

    if (authorization.status === 'approval-required') {
      if (!authorization.approval.approvalContext) {
        return this.failed('Connector approval has no value-free consent context', false);
      }
      const unsignedPending: Omit<DurablePendingMissionConnectorApproval, 'bindingSignature'> = {
        missionId: input.mission.id,
        workItemId: input.item.id,
        approvalId: authorization.approval.approvalId,
        requestHash: authorization.requestHash,
        operationId: authorization.approval.operationId,
        risk: authorization.approval.risk,
        approvalContext: structuredClone(authorization.approval.approvalContext),
        expiresAt: authorization.approval.expiresAt,
      };
      state = this.store.update(input.mission.id, input.item.id, state.revision, (current) => ({
        ...current,
        status: 'waiting-approval',
        pendingApproval: {
          ...unsignedPending,
          bindingSignature: this.signPendingApproval(unsignedPending),
        },
        updatedAt: this.now(),
      }));
      return this.approvalResult(state);
    }
    if (authorization.status === 'denied') {
      state = this.store.update(input.mission.id, input.item.id, state.revision, (current) => ({
        ...current,
        status: 'denied',
        failureReason: `${authorization.code}: ${authorization.reason}`,
        updatedAt: this.now(),
      }));
      return this.failed(state.failureReason!, false);
    }

    state = this.store.update(input.mission.id, input.item.id, state.revision, (current) => ({
      ...current,
      status: 'executing',
      pendingApproval: undefined,
      updatedAt: this.now(),
    }));
    try {
      const executed = await this.options.runtime.invokeAuthorized(prepared.preparationId);
      return this.complete(input, state, resultProof(executed.output));
    } catch (error) {
      // The durable executing state is deliberately retained. A later attempt
      // must reconcile by idempotency key before it may decide whether to replay.
      return this.failed(`Connector outcome requires recovery reconciliation: ${this.errorMessage(error)}`, true);
    }
  }

  resolveApproval(input: {
    missionId: string;
    workItemId: string;
    approvalId: string;
    requestHash: string;
    decision: 'approved' | 'denied';
    resolvedBy: string;
  }): PendingMissionConnectorApproval {
    if (!input.resolvedBy.trim()) throw new Error('Approver identity is required');
    let state = this.store.read(input.missionId, input.workItemId);
    const pending = state?.pendingApproval;
    if (state?.approval && pending) {
      if (!this.verifyPendingApproval(pending)) {
        throw new Error('Connector approval consent context is not bound to its durable request');
      }
      if (
        !this.verifyApproval(state.approval)
        || state.approval.approvalId !== input.approvalId
        || state.approval.requestHash !== input.requestHash
        || state.approval.decision !== input.decision
        || state.approval.resolvedBy !== input.resolvedBy
      ) {
        throw new Error('Connector approval was already resolved with another durable decision');
      }
      return this.publicPendingApproval(pending);
    }
    if (!state || state.status !== 'waiting-approval' || !pending) throw new Error('Connector approval is not pending');
    if (!this.verifyPendingApproval(pending)) {
      throw new Error('Connector approval consent context is not bound to its durable request');
    }
    if (pending.approvalId !== input.approvalId || pending.requestHash !== input.requestHash) {
      throw new Error('Connector approval does not match the durable request');
    }
    if (Date.parse(pending.expiresAt) <= Date.parse(this.now())) throw new Error('Connector approval expired');
    const unsigned = {
      approvalId: input.approvalId,
      requestHash: input.requestHash,
      decision: input.decision,
      resolvedBy: input.resolvedBy,
      resolvedAt: this.now(),
      expiresAt: pending.expiresAt,
    } as const;
    const approval: DurableApprovalDecision = { ...unsigned, signature: this.signApproval(unsigned) };
    state = this.store.update(input.missionId, input.workItemId, state.revision, (current) => ({
      ...current,
      status: input.decision === 'approved' ? 'approved' : 'denied',
      approval,
      failureReason: input.decision === 'denied' ? `Connector approval denied by ${input.resolvedBy}` : undefined,
      updatedAt: this.now(),
    }));
    return this.publicPendingApproval(pending);
  }

  pendingApproval(missionId: string, workItemId: string): PendingMissionConnectorApproval | null {
    const state = this.store.read(missionId, workItemId);
    if (state?.status !== 'waiting-approval' || !state.pendingApproval) return null;
    if (!this.verifyPendingApproval(state.pendingApproval)) {
      throw new Error('Connector approval consent context is not bound to its durable request');
    }
    return this.publicPendingApproval(state.pendingApproval);
  }

  resolvedApproval(missionId: string, workItemId: string): 'approved' | 'denied' | null {
    const approval = this.store.read(missionId, workItemId)?.approval;
    return approval && this.verifyApproval(approval) ? approval.decision : null;
  }

  approvalExpired(missionId: string, workItemId: string): boolean {
    const state = this.store.read(missionId, workItemId);
    if (state?.status === 'waiting-approval' && state.pendingApproval
        && !this.verifyPendingApproval(state.pendingApproval)) {
      throw new Error('Connector approval consent context is not bound to its durable request');
    }
    return state?.status === 'waiting-approval'
      && !state.approval
      && Boolean(state.pendingApproval)
      && Date.parse(state.pendingApproval!.expiresAt) <= Date.parse(this.now());
  }

  compensationRequirement(missionId: string, workItemId: string): {
    reason: string;
    compensation: MissionConnectorInvocation['compensation'];
  } | null {
    const state = this.store.read(missionId, workItemId);
    if (state?.status !== 'compensation-required') return null;
    // The invocation remains in the signed Mission journal; the state file
    // intentionally stores no raw payload or provider response.
    return {
      reason: state.failureReason ?? 'Provider reconciliation diverged',
      compensation: state.compensation,
    };
  }

  private async recover(
    input: MissionExecutionInput,
    state: ConnectorExecutionState,
    invocation: MissionConnectorInvocation,
  ): Promise<{ state: ConnectorExecutionState; result?: MissionExecutionResult }> {
    let observation: MissionConnectorRecoveryResult;
    try {
      observation = await this.options.recoverMutation({
        workspaceId: this.options.workspaceId,
        missionId: input.mission.id,
        workItemId: input.item.id,
        requestHash: state.requestHash,
        idempotencyKey: state.idempotencyKey,
        invocation,
      });
    } catch (error) {
      return { state, result: this.failed(`Recovery reconciliation unavailable: ${this.errorMessage(error)}`, true) };
    }
    if (observation.status === 'confirmed') {
      return { state, result: this.complete(input, state, observation.proof) };
    }
    if (observation.status === 'absent') {
      const approvalValid = state.approval?.decision === 'approved' && this.verifyApproval(state.approval)
        && Date.parse(state.approval.expiresAt) > Date.parse(this.now());
      const next = this.store.update(input.mission.id, input.item.id, state.revision, (current) => ({
        ...current,
        status: approvalValid ? 'approved' : 'prepared',
        approval: approvalValid ? current.approval : undefined,
        updatedAt: this.now(),
      }));
      return { state: next };
    }
    const reason = observation.status === 'diverged'
      ? `Provider reconciliation diverged: ${observation.reason}`
      : `Provider outcome is unknown: ${observation.reason}`;
    const next = this.store.update(input.mission.id, input.item.id, state.revision, (current) => ({
      ...current,
      status: 'compensation-required',
      failureReason: `${reason}; compensation=${invocation.compensation.strategy}`,
      updatedAt: this.now(),
    }));
    return { state: next, result: this.failed(next.failureReason!, true) };
  }

  private complete(
    input: MissionExecutionInput,
    state: ConnectorExecutionState,
    proofValue: SignedExecutionProof,
  ): MissionExecutionResult {
    const proof = parseSignedExecutionProof(proofValue);
    const verification = this.options.verifyExecutionProof(proof, {
      ...bindingFor(input),
      workspaceId: this.options.workspaceId,
    });
    if (!verification.allowed) {
      const reason = `${verification.code}: ${verification.reason}`;
      const next = this.store.update(input.mission.id, input.item.id, state.revision, (current) => ({
        ...current,
        status: 'compensation-required',
        proof,
        failureReason: `${reason}; compensation=${connectorInvocation(input).compensation.strategy}`,
        updatedAt: this.now(),
      }));
      return this.failed(next.failureReason!, true);
    }
    const invocation = connectorInvocation(input);
    const receipt: MutationReceipt = {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      kind: 'brokered-connector-mutation',
      workspaceId: this.options.workspaceId,
      missionId: input.mission.id,
      workItemId: input.item.id,
      connectorPack: invocation.pack,
      operationId: invocation.operationId,
      requestHash: state.requestHash,
      idempotencyKey: state.idempotencyKey,
      compensation: invocation.compensation,
      proof,
      issuedAt: this.now(),
    };
    const receiptUri = this.store.writeReceipt(input.mission.id, input.item.id, receipt);
    const completed = this.store.update(input.mission.id, input.item.id, state.revision, (current) => ({
      ...current,
      status: 'executed',
      proof,
      receiptUri,
      failureReason: undefined,
      updatedAt: this.now(),
    }));
    return this.submissionFromCompleted(input, completed);
  }

  private submissionFromCompleted(input: MissionExecutionInput, state: ConnectorExecutionState): MissionExecutionResult {
    if (!state.proof || !state.receiptUri) return this.failed('Completed connector state is missing its proof receipt', true);
    const expectedReceipt = `missions/${input.mission.id}/connector-executions/${input.item.id}.receipt.json`;
    if (state.receiptUri !== expectedReceipt) return this.failed('Completed connector receipt path is not canonical', true);
    const verification = this.options.verifyExecutionProof(state.proof, {
      workspaceId: this.options.workspaceId,
      missionId: input.mission.id,
      nodeId: input.item.id,
      idempotencyKey: state.idempotencyKey,
    });
    if (!verification.allowed) return this.failed(`Stored connector proof rejected: ${verification.code}`, true);
    const invocation = connectorInvocation(input);
    const receipt = this.store.readReceipt(input.mission.id, input.item.id);
    if (!receipt) return this.failed('Completed connector proof receipt is unavailable', true);
    if (
      receipt.requestHash !== state.requestHash
      || receipt.idempotencyKey !== state.idempotencyKey
      || receipt.connectorPack !== invocation.pack
      || receipt.operationId !== invocation.operationId
      || canonicalOperationValue(receipt.compensation) !== canonicalOperationValue(invocation.compensation)
      || canonicalOperationValue(receipt.proof) !== canonicalOperationValue(state.proof)
    ) {
      return this.failed('Completed connector proof receipt does not match durable execution state', true);
    }
    return {
      status: 'submission',
      submission: {
        summary: `Host broker executed and reconciled ${invocation.pack}/${invocation.operationId}.`,
        outputRefs: [state.receiptUri],
        evidence: [{
          requirementId: invocation.receiptRequirementId,
          uri: state.receiptUri,
          kind: 'receipt',
          description: 'Host-issued brokered connector execution and reconciliation receipt',
        }],
      },
    };
  }

  private approvalResult(state: ConnectorExecutionState): MissionExecutionResult {
    const pending = state.pendingApproval;
    if (!pending) return this.failed('Durable approval request is unavailable', false);
    if (!this.verifyPendingApproval(pending)) {
      return this.failed('Connector approval consent context is not bound to its durable request', false);
    }
    return {
      status: 'approval-required',
      approvalId: pending.approvalId,
      requestHash: pending.requestHash,
      expiresAt: pending.expiresAt,
      operationId: pending.operationId,
    };
  }

  private matchesState(state: ConnectorExecutionState, input: MissionExecutionInput, key: string): boolean {
    return state.workspaceId === this.options.workspaceId
      && state.missionId === input.mission.id
      && state.workItemId === input.item.id
      && state.dispatchId === input.dispatchId
      && state.idempotencyKey === key
      && state.operationId === connectorInvocation(input).operationId;
  }

  /**
   * A journaled replan may invalidate downstream semantics while keeping the
   * exact connector invocation. Reusing a reconciled proof under the same
   * idempotency key is safe across a new Mission dispatch and, critically,
   * avoids issuing the external mutation twice.
   */
  private matchesCompletedIdentity(
    state: ConnectorExecutionState,
    input: MissionExecutionInput,
    key: string,
  ): boolean {
    return state.workspaceId === this.options.workspaceId
      && state.missionId === input.mission.id
      && state.workItemId === input.item.id
      && state.idempotencyKey === key
      && state.operationId === connectorInvocation(input).operationId;
  }

  private signApproval(value: Omit<DurableApprovalDecision, 'signature'>): string {
    return createHmac('sha256', this.approvalKey)
      .update(canonicalOperationValue(value), 'utf8')
      .digest('base64url');
  }

  private signPendingApproval(
    value: Omit<DurablePendingMissionConnectorApproval, 'bindingSignature'>,
  ): string {
    return createHmac('sha256', this.approvalKey)
      .update(canonicalOperationValue(value), 'utf8')
      .digest('base64url');
  }

  private verifyPendingApproval(value: DurablePendingMissionConnectorApproval): boolean {
    const { bindingSignature, ...unsigned } = value;
    const actual = Buffer.from(bindingSignature, 'base64url');
    const expected = Buffer.from(this.signPendingApproval(unsigned), 'base64url');
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
  }

  private publicPendingApproval(
    pending: DurablePendingMissionConnectorApproval,
  ): PendingMissionConnectorApproval {
    const { bindingSignature: _bindingSignature, ...value } = pending;
    return {
      workspaceId: this.options.workspaceId,
      ...structuredClone(value),
    };
  }

  private verifyApproval(value: DurableApprovalDecision): boolean {
    const { signature, ...unsigned } = value;
    const actual = Buffer.from(signature, 'base64url');
    const expected = Buffer.from(this.signApproval(unsigned), 'base64url');
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
  }

  private failed(reason: string, ambiguousMutation: boolean): MissionExecutionResult {
    return { status: 'failed', reason, retryable: false, ambiguousMutation };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Routes external mutations to the broker worker and all other work to sessions. */
export class EffectRoutingMissionExecutor implements MissionWorkExecutor {
  constructor(
    private readonly ordinary: MissionWorkExecutor,
    readonly connector: BrokeredMissionConnectorExecutor,
  ) {}

  prepare(input: MissionExecutionInput): Promise<MissionExecutionBinding> {
    return input.item.effect === 'external-mutation'
      ? this.connector.prepare(input)
      : this.ordinary.prepare(input);
  }

  execute(
    input: MissionExecutionInput,
    binding: MissionExecutionBinding,
    lifecycle?: Parameters<MissionWorkExecutor['execute']>[2],
  ): Promise<MissionExecutionResult> {
    return input.item.effect === 'external-mutation'
      ? this.connector.execute(input, binding)
      : this.ordinary.execute(input, binding, lifecycle);
  }
}
