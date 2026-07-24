import { createHash, sign, verify, type KeyObject } from 'node:crypto';

export type RemoteSyncField =
  | 'task.status'
  | 'task.progress'
  | 'task.blockers'
  | 'task.approvals'
  | 'task.cost'
  | 'task.timestamps';

export type RemoteAction = 'task.pause' | 'task.cancel' | 'approval.resolve';

export interface RemoteSupervisorIdentity {
  subjectId: string;
  role: 'owner' | 'admin' | 'operator' | 'validator' | 'reader';
  allowedActions: RemoteAction[];
}

export interface RemoteSupervisionConsent {
  consentId: string;
  grantedBy: string;
  grantedAt: string;
  expiresAt: string;
  fields: RemoteSyncField[];
  actions: RemoteAction[];
  purpose: string;
}

export interface RemoteSupervisionState {
  mode: 'local-only' | 'remote-metadata';
  consent: RemoteSupervisionConsent | null;
  revokedAt?: string;
  revocationReason?: string;
}

export interface RemoteSupervisionProfile {
  schemaVersion: 1;
  state: RemoteSupervisionState;
  audit: RemoteAuditEvent[];
}

export interface RemoteTaskProjection {
  task: {
    status?: string;
    progress?: number;
    blockers?: string[];
    approvals?: Array<{ id: string; status: string }>;
    cost?: { amount: number; currency: string };
    timestamps?: { createdAt?: string; updatedAt?: string };
  };
}

export interface RemoteAuditEvent {
  sequence: number;
  occurredAt: string;
  subjectId: string;
  operation: string;
  outcome: 'accepted' | 'denied';
  details: Record<string, unknown>;
  previousHash: string;
  hash: string;
}

export interface SignedRemoteAuditExport {
  schemaVersion: 1;
  exportedAt: string;
  keyId: string;
  events: RemoteAuditEvent[];
  signature: string;
}

function hashAuditEvent(event: Omit<RemoteAuditEvent, 'hash'>): string {
  return createHash('sha256').update(JSON.stringify(event), 'utf8').digest('hex');
}

function exportPayload(input: Omit<SignedRemoteAuditExport, 'signature'>): string {
  return JSON.stringify(input);
}

export class RemoteSupervisionController {
  private state: RemoteSupervisionState = { mode: 'local-only', consent: null };
  private readonly auditEvents: RemoteAuditEvent[] = [];

  constructor(profile: RemoteSupervisionProfile = createDefaultRemoteSupervisionProfile()) {
    this.state = cloneRemoteSupervisionState(profile.state);
    this.auditEvents.push(...profile.audit.map((event) => ({
      ...event,
      details: { ...event.details },
    })));
    if (!this.verifyAuditChain()) {
      throw new Error('Remote supervision audit chain is invalid');
    }
  }

  getState(): RemoteSupervisionState {
    return cloneRemoteSupervisionState(this.state);
  }

  exportProfile(): RemoteSupervisionProfile {
    return {
      schemaVersion: 1,
      state: this.getState(),
      audit: this.auditEvents.map((event) => ({
        ...event,
        details: { ...event.details },
      })),
    };
  }

  grantConsent(input: {
    identity: RemoteSupervisorIdentity;
    consentId: string;
    fields: RemoteSyncField[];
    actions: RemoteAction[];
    purpose: string;
    expiresAt: string;
    grantedAt?: string;
  }): RemoteSupervisionState {
    if (!['owner', 'admin'].includes(input.identity.role)) {
      this.appendAudit(input.identity.subjectId, 'remote.consent.grant', 'denied', { role: input.identity.role });
      throw new Error('Only an owner or admin can enable remote supervision');
    }
    const grantedAt = input.grantedAt ?? new Date().toISOString();
    if (Date.parse(input.expiresAt) <= Date.parse(grantedAt)) {
      throw new Error('Remote supervision consent must expire in the future');
    }
    const fields = [...new Set(input.fields)];
    const actions = [...new Set(input.actions)];
    if (fields.length === 0) {
      throw new Error('Remote supervision requires at least one metadata field');
    }
    if (actions.length === 0) {
      throw new Error('Remote supervision requires at least one remote action');
    }
    if (input.purpose.trim() === '') {
      throw new Error('Remote supervision purpose is required');
    }
    this.state = {
      mode: 'remote-metadata',
      consent: {
        consentId: input.consentId,
        grantedBy: input.identity.subjectId,
        grantedAt,
        expiresAt: input.expiresAt,
        fields,
        actions,
        purpose: input.purpose.trim(),
      },
    };
    this.appendAudit(input.identity.subjectId, 'remote.consent.grant', 'accepted', { fields, actions });
    return this.getState();
  }

  revokeConsent(identity: RemoteSupervisorIdentity, reason: string, revokedAt = new Date().toISOString()): RemoteSupervisionState {
    if (!['owner', 'admin'].includes(identity.role)) {
      this.appendAudit(identity.subjectId, 'remote.consent.revoke', 'denied', { role: identity.role });
      throw new Error('Only an owner or admin can revoke remote supervision');
    }
    this.state = {
      mode: 'local-only',
      consent: null,
      revokedAt,
      revocationReason: reason,
    };
    this.appendAudit(identity.subjectId, 'remote.consent.revoke', 'accepted', { reason });
    return this.getState();
  }

  projectTask(snapshot: RemoteTaskProjection, now = new Date().toISOString()): RemoteTaskProjection | null {
    const consent = this.activeConsent(now);
    if (!consent) return null;
    const task: RemoteTaskProjection['task'] = {};
    for (const field of consent.fields) {
      if (field === 'task.status' && snapshot.task.status !== undefined) task.status = snapshot.task.status;
      if (field === 'task.progress' && snapshot.task.progress !== undefined) task.progress = snapshot.task.progress;
      if (field === 'task.blockers' && snapshot.task.blockers !== undefined) task.blockers = [...snapshot.task.blockers];
      if (field === 'task.approvals' && snapshot.task.approvals !== undefined) {
        task.approvals = snapshot.task.approvals.map((approval) => ({ ...approval }));
      }
      if (field === 'task.cost' && snapshot.task.cost !== undefined) task.cost = { ...snapshot.task.cost };
      if (field === 'task.timestamps' && snapshot.task.timestamps !== undefined) {
        task.timestamps = { ...snapshot.task.timestamps };
      }
    }
    return { task };
  }

  authorizeRemoteAction(
    identity: RemoteSupervisorIdentity,
    action: RemoteAction,
    now = new Date().toISOString(),
  ): void {
    const consent = this.activeConsent(now);
    const allowed = consent?.actions.includes(action) === true && identity.allowedActions.includes(action);
    this.appendAudit(identity.subjectId, action, allowed ? 'accepted' : 'denied', {
      consentId: consent?.consentId ?? null,
    });
    if (!allowed) throw new Error(`Remote action ${action} is not authorized`);
  }

  exportSignedAudit(keyId: string, privateKey: KeyObject, exportedAt = new Date().toISOString()): SignedRemoteAuditExport {
    const unsigned: Omit<SignedRemoteAuditExport, 'signature'> = {
      schemaVersion: 1,
      exportedAt,
      keyId,
      events: this.auditEvents.map((event) => ({ ...event, details: { ...event.details } })),
    };
    return {
      ...unsigned,
      signature: sign(null, Buffer.from(exportPayload(unsigned), 'utf8'), privateKey).toString('base64'),
    };
  }

  verifyAuditChain(): boolean {
    let previousHash = 'GENESIS';
    return this.auditEvents.every((event, index) => {
      const { hash, ...unsigned } = event;
      const valid = event.sequence === index + 1
        && event.previousHash === previousHash
        && hash === hashAuditEvent(unsigned);
      previousHash = event.hash;
      return valid;
    });
  }

  private activeConsent(now: string): RemoteSupervisionConsent | null {
    if (this.state.mode !== 'remote-metadata' || !this.state.consent) return null;
    return Date.parse(this.state.consent.expiresAt) > Date.parse(now) ? this.state.consent : null;
  }

  private appendAudit(
    subjectId: string,
    operation: string,
    outcome: RemoteAuditEvent['outcome'],
    details: Record<string, unknown>,
  ): void {
    const previousHash = this.auditEvents.at(-1)?.hash ?? 'GENESIS';
    const unsigned: Omit<RemoteAuditEvent, 'hash'> = {
      sequence: this.auditEvents.length + 1,
      occurredAt: new Date().toISOString(),
      subjectId,
      operation,
      outcome,
      details,
      previousHash,
    };
    this.auditEvents.push({ ...unsigned, hash: hashAuditEvent(unsigned) });
  }
}

export function verifySignedRemoteAudit(audit: SignedRemoteAuditExport, publicKey: KeyObject): boolean {
  const { signature, ...unsigned } = audit;
  return verifyRemoteAuditEvents(unsigned.events) && verify(
    null,
    Buffer.from(exportPayload(unsigned), 'utf8'),
    publicKey,
    Buffer.from(signature, 'base64'),
  );
}

export function createDefaultRemoteSupervisionProfile(): RemoteSupervisionProfile {
  return {
    schemaVersion: 1,
    state: {
      mode: 'local-only',
      consent: null,
    },
    audit: [],
  };
}

function cloneRemoteSupervisionState(state: RemoteSupervisionState): RemoteSupervisionState {
  return {
    ...state,
    consent: state.consent
      ? {
          ...state.consent,
          fields: [...state.consent.fields],
          actions: [...state.consent.actions],
        }
      : null,
  };
}

export function verifyRemoteAuditEvents(events: readonly RemoteAuditEvent[]): boolean {
  let previousHash = 'GENESIS';
  return events.every((event, index) => {
    const { hash, ...unsigned } = event;
    const valid = event.sequence === index + 1
      && event.previousHash === previousHash
      && hash === hashAuditEvent(unsigned);
    previousHash = event.hash;
    return valid;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRemoteSyncField(value: unknown): value is RemoteSyncField {
  return value === 'task.status'
    || value === 'task.progress'
    || value === 'task.blockers'
    || value === 'task.approvals'
    || value === 'task.cost'
    || value === 'task.timestamps';
}

function isRemoteAction(value: unknown): value is RemoteAction {
  return value === 'task.pause'
    || value === 'task.cancel'
    || value === 'approval.resolve';
}

function parseRemoteConsent(value: unknown): RemoteSupervisionConsent {
  if (!isRecord(value)) {
    throw new Error('Remote supervision consent must be an object');
  }
  const {
    consentId,
    grantedBy,
    grantedAt,
    expiresAt,
    fields,
    actions,
    purpose,
  } = value;
  if (
    typeof consentId !== 'string'
    || consentId.trim() === ''
    || typeof grantedBy !== 'string'
    || grantedBy.trim() === ''
    || typeof grantedAt !== 'string'
    || !Number.isFinite(Date.parse(grantedAt))
    || typeof expiresAt !== 'string'
    || !Number.isFinite(Date.parse(expiresAt))
    || Date.parse(expiresAt) <= Date.parse(grantedAt)
    || !Array.isArray(fields)
    || fields.length === 0
    || !fields.every(isRemoteSyncField)
    || !Array.isArray(actions)
    || actions.length === 0
    || !actions.every(isRemoteAction)
    || typeof purpose !== 'string'
    || purpose.trim() === ''
  ) {
    throw new Error('Remote supervision consent is invalid');
  }
  return {
    consentId,
    grantedBy,
    grantedAt,
    expiresAt,
    fields: [...new Set(fields)],
    actions: [...new Set(actions)],
    purpose,
  };
}

function parseRemoteAuditEvent(value: unknown): RemoteAuditEvent {
  if (!isRecord(value)) {
    throw new Error('Remote supervision audit event must be an object');
  }
  const {
    sequence,
    occurredAt,
    subjectId,
    operation,
    outcome,
    details,
    previousHash,
    hash,
  } = value;
  if (
    typeof sequence !== 'number'
    || !Number.isInteger(sequence)
    || sequence < 1
    || typeof occurredAt !== 'string'
    || !Number.isFinite(Date.parse(occurredAt))
    || typeof subjectId !== 'string'
    || subjectId.trim() === ''
    || typeof operation !== 'string'
    || operation.trim() === ''
    || (outcome !== 'accepted' && outcome !== 'denied')
    || !isRecord(details)
    || typeof previousHash !== 'string'
    || typeof hash !== 'string'
    || !/^(GENESIS|[a-f0-9]{64})$/.test(previousHash)
    || !/^[a-f0-9]{64}$/.test(hash)
  ) {
    throw new Error('Remote supervision audit event is invalid');
  }
  return {
    sequence,
    occurredAt,
    subjectId,
    operation,
    outcome,
    details: { ...details },
    previousHash,
    hash,
  };
}

export function parseRemoteSupervisionProfile(value: unknown): RemoteSupervisionProfile {
  if (!isRecord(value)) {
    throw new Error('Remote supervision profile must be an object');
  }
  const { schemaVersion, state, audit } = value;
  if (schemaVersion !== 1 || !isRecord(state) || !Array.isArray(audit)) {
    throw new Error('Remote supervision profile has an invalid envelope');
  }
  const { mode, consent, revokedAt, revocationReason } = state;
  if (mode !== 'local-only' && mode !== 'remote-metadata') {
    throw new Error('Remote supervision mode is invalid');
  }
  if (mode === 'local-only' && consent !== null) {
    throw new Error('Local-only supervision cannot retain active consent');
  }
  if (revokedAt !== undefined && (typeof revokedAt !== 'string' || !Number.isFinite(Date.parse(revokedAt)))) {
    throw new Error('Remote supervision revocation timestamp is invalid');
  }
  if (revocationReason !== undefined && typeof revocationReason !== 'string') {
    throw new Error('Remote supervision revocation reason is invalid');
  }
  const parsedAudit = audit.map(parseRemoteAuditEvent);
  if (!verifyRemoteAuditEvents(parsedAudit)) {
    throw new Error('Remote supervision audit chain is invalid');
  }
  const parsedConsent = mode === 'remote-metadata'
    ? parseRemoteConsent(consent)
    : null;
  return {
    schemaVersion: 1,
    state: {
      mode,
      consent: parsedConsent,
      ...(revokedAt !== undefined && { revokedAt }),
      ...(revocationReason !== undefined && { revocationReason }),
    },
    audit: parsedAudit,
  };
}

export interface EuComplianceManifest {
  schemaVersion: 1;
  dataResidency: Array<'device' | 'eu-cloud'>;
  sovereignModeAvailable: boolean;
  retentionDays: number;
  subprocessors: Array<{
    name: string;
    country: string;
    purpose: string;
    exitNoticeDays: number;
  }>;
  exportFormats: Array<'json' | 'ndjson' | 'markdown'>;
  deletionSlaDays: number;
}

export function validateEuComplianceManifest(manifest: EuComplianceManifest): string[] {
  const errors: string[] = [];
  if (!manifest.dataResidency.includes('device')) errors.push('device residency must remain available');
  if (manifest.retentionDays < 0) errors.push('retentionDays cannot be negative');
  if (manifest.deletionSlaDays <= 0 || manifest.deletionSlaDays > 30) {
    errors.push('deletion SLA must be between 1 and 30 days');
  }
  if (!manifest.exportFormats.includes('json')) errors.push('JSON exit export is required');
  for (const subprocessor of manifest.subprocessors) {
    if (!subprocessor.name || !subprocessor.country || !subprocessor.purpose) {
      errors.push('subprocessors require name, country, and purpose');
    }
    if (subprocessor.exitNoticeDays < 0) errors.push(`${subprocessor.name} exit notice cannot be negative`);
  }
  return errors;
}

export interface WorkspaceRecoveryManifest {
  schemaVersion: 1;
  workspaceId: string;
  createdAt: string;
  storageMode: 'local';
  includes: Array<'tasks' | 'policies' | 'playbooks' | 'memory' | 'audit'>;
  excludes: Array<'secret-values' | 'session-tokens'>;
  fileChecksums: Record<string, string>;
}

export function validateWorkspaceRecoveryManifest(manifest: WorkspaceRecoveryManifest): string[] {
  const errors: string[] = [];
  if (manifest.storageMode !== 'local') errors.push('recovery manifest must preserve local storage mode');
  if (!manifest.excludes.includes('secret-values')) errors.push('secret values must be excluded from backups');
  if (!manifest.excludes.includes('session-tokens')) errors.push('session tokens must be excluded from backups');
  if (!manifest.includes.includes('audit')) errors.push('audit history is required for recovery');
  for (const [file, checksum] of Object.entries(manifest.fileChecksums)) {
    if (!file || !/^[a-f0-9]{64}$/.test(checksum)) errors.push(`invalid checksum for ${file || '<empty>'}`);
  }
  return errors;
}
