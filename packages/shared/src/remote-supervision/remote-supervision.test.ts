import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import {
  RemoteSupervisionController,
  parseRemoteSupervisionProfile,
  validateEuComplianceManifest,
  validateWorkspaceRecoveryManifest,
  verifySignedRemoteAudit,
  type EuComplianceManifest,
  type RemoteSupervisorIdentity,
  type WorkspaceRecoveryManifest,
} from './remote-supervision';

const admin: RemoteSupervisorIdentity = {
  subjectId: 'admin-1',
  role: 'admin',
  allowedActions: ['task.pause', 'task.cancel', 'approval.resolve'],
};

describe('remote supervision', () => {
  test('is local-only by default and synchronizes only consented fields', () => {
    const controller = new RemoteSupervisionController();
    const snapshot = {
      task: {
        status: 'running',
        progress: 0.5,
        blockers: ['approval'],
        approvals: [{ id: 'approval-1', status: 'pending' }],
        cost: { amount: 1.2, currency: 'EUR' },
      },
    };
    expect(controller.projectTask(snapshot)).toBeNull();
    controller.grantConsent({
      identity: admin,
      consentId: 'consent-1',
      fields: ['task.status', 'task.progress'],
      actions: ['task.pause'],
      purpose: 'Supervision équipe',
      grantedAt: '2026-07-23T10:00:00.000Z',
      expiresAt: '2026-07-24T10:00:00.000Z',
    });
    expect(controller.projectTask(snapshot, '2026-07-23T11:00:00.000Z')).toEqual({
      task: { status: 'running', progress: 0.5 },
    });
  });

  test('requires both consent and user authorization for remote actions', () => {
    const controller = new RemoteSupervisionController();
    controller.grantConsent({
      identity: admin,
      consentId: 'consent-2',
      fields: ['task.status'],
      actions: ['task.pause'],
      purpose: 'Assistance',
      grantedAt: '2026-07-23T10:00:00.000Z',
      expiresAt: '2026-07-24T10:00:00.000Z',
    });
    expect(() => controller.authorizeRemoteAction(admin, 'task.pause', '2026-07-23T11:00:00.000Z'))
      .not.toThrow();
    expect(() => controller.authorizeRemoteAction(admin, 'task.cancel', '2026-07-23T11:00:00.000Z'))
      .toThrow('not authorized');
  });

  test('exports and restores a durable consent profile without widening its scope', () => {
    const controller = new RemoteSupervisionController();
    controller.grantConsent({
      identity: admin,
      consentId: 'consent-durable',
      fields: ['task.status', 'task.blockers'],
      actions: ['task.pause'],
      purpose: 'Operational supervision',
      grantedAt: '2026-07-23T10:00:00.000Z',
      expiresAt: '2026-07-24T10:00:00.000Z',
    });
    const serialized: unknown = JSON.parse(JSON.stringify(controller.exportProfile()));
    const restored = new RemoteSupervisionController(parseRemoteSupervisionProfile(serialized));
    expect(restored.getState()).toEqual(controller.getState());
    expect(restored.projectTask({
      task: {
        status: 'running',
        blockers: ['approval'],
        progress: 0.6,
        cost: { amount: 3, currency: 'EUR' },
      },
    }, '2026-07-23T11:00:00.000Z')).toEqual({
      task: {
        status: 'running',
        blockers: ['approval'],
      },
    });
  });

  test('revokes consent immediately and exports a verifiable audit chain', () => {
    const controller = new RemoteSupervisionController();
    controller.grantConsent({
      identity: admin,
      consentId: 'consent-3',
      fields: ['task.status'],
      actions: ['task.pause'],
      purpose: 'Support',
      grantedAt: '2026-07-23T10:00:00.000Z',
      expiresAt: '2026-07-24T10:00:00.000Z',
    });
    controller.revokeConsent(admin, 'Support terminé', '2026-07-23T12:00:00.000Z');
    expect(controller.getState().mode).toBe('local-only');
    expect(controller.projectTask({ task: { status: 'running' } }, '2026-07-23T12:01:00.000Z')).toBeNull();
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const audit = controller.exportSignedAudit('audit-key-1', privateKey, '2026-07-23T12:02:00.000Z');
    expect(controller.verifyAuditChain()).toBe(true);
    expect(verifySignedRemoteAudit(audit, publicKey)).toBe(true);
    const tampered = {
      ...audit,
      events: audit.events.map((event, index) => index === 0
        ? { ...event, details: { altered: true } }
        : event),
    };
    expect(verifySignedRemoteAudit(tampered, publicKey)).toBe(false);
  });

  test('rejects persisted consent with an unknown remote capability', () => {
    expect(() => parseRemoteSupervisionProfile({
      schemaVersion: 1,
      state: {
        mode: 'remote-metadata',
        consent: {
          consentId: 'consent-invalid',
          grantedBy: 'admin-1',
          grantedAt: '2026-07-23T10:00:00.000Z',
          expiresAt: '2026-07-24T10:00:00.000Z',
          fields: ['task.content'],
          actions: ['task.pause'],
          purpose: 'Invalid capability',
        },
      },
      audit: [],
    })).toThrow('consent is invalid');
  });

  test('validates EU exit guarantees and local recovery without secrets', () => {
    const compliance: EuComplianceManifest = {
      schemaVersion: 1,
      dataResidency: ['device', 'eu-cloud'],
      sovereignModeAvailable: true,
      retentionDays: 30,
      subprocessors: [{
        name: 'EU Hosting',
        country: 'France',
        purpose: 'Optional metadata relay',
        exitNoticeDays: 30,
      }],
      exportFormats: ['json', 'ndjson', 'markdown'],
      deletionSlaDays: 15,
    };
    const recovery: WorkspaceRecoveryManifest = {
      schemaVersion: 1,
      workspaceId: 'workspace-1',
      createdAt: '2026-07-23T10:00:00.000Z',
      storageMode: 'local',
      includes: ['tasks', 'policies', 'playbooks', 'memory', 'audit'],
      excludes: ['secret-values', 'session-tokens'],
      fileChecksums: { 'tasks.ndjson': 'a'.repeat(64) },
    };
    expect(validateEuComplianceManifest(compliance)).toEqual([]);
    expect(validateWorkspaceRecoveryManifest(recovery)).toEqual([]);
  });
});
