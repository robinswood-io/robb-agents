import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authorizeNetworkUrl,
  authorizeResolvedNetworkUrl,
  authorizeSecretLease,
  authorizeWorkspacePath,
  decideMutationRecovery,
  evaluateKillSwitch,
  validateExecutionIsolationPolicy,
  type MutationCheckpoint,
} from './durable-execution.ts';

describe('durable execution guardrails', () => {
  it('blocks lexical and symbolic-link workspace escapes', () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-isolation-'));
    const outside = mkdtempSync(join(tmpdir(), 'robb-outside-'));
    try {
      mkdirSync(join(root, 'allowed'));
      symlinkSync(outside, join(root, 'allowed', 'escape'));

      expect(authorizeWorkspacePath(root, 'allowed/file.txt', ['allowed']).allowed).toBe(true);
      expect(authorizeWorkspacePath(root, '../outside.txt', ['.']).allowed).toBe(false);
      expect(authorizeWorkspacePath(root, 'allowed/escape/secret.txt', ['allowed']).allowed).toBe(false);
      expect(authorizeWorkspacePath(join(root, 'missing-root'), '.', ['.']).allowed).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('blocks private networks and hosts outside an explicit allow-list', () => {
    expect(authorizeNetworkUrl('https://api.example.com/v1', 'allow-list', ['api.example.com']).allowed).toBe(true);
    expect(authorizeNetworkUrl('https://sub.example.com/v1', 'allow-list', ['*.example.com']).allowed).toBe(true);
    expect(authorizeNetworkUrl('http://127.0.0.1/admin', 'allow-list', ['127.0.0.1']).allowed).toBe(false);
    expect(authorizeNetworkUrl('https://evil-example.com', 'allow-list', ['example.com']).allowed).toBe(false);
    expect(authorizeNetworkUrl('https://api.example.com', 'disabled', ['api.example.com']).allowed).toBe(false);
  });

  it('blocks DNS rebinding and private IPv6 answers after host resolution', async () => {
    const publicResolver = async () => [{ address: '203.0.113.8', family: 4 as const }];
    const privateResolver = async () => [{ address: '10.0.0.8', family: 4 as const }];
    const privateIpv6Resolver = async () => [{ address: 'fd00::8', family: 6 as const }];

    expect((await authorizeResolvedNetworkUrl(
      'https://api.example.com/v1',
      'allow-list',
      ['api.example.com'],
      publicResolver,
    )).allowed).toBe(true);
    expect((await authorizeResolvedNetworkUrl(
      'https://api.example.com/v1',
      'allow-list',
      ['api.example.com'],
      privateResolver,
    )).allowed).toBe(false);
    expect((await authorizeResolvedNetworkUrl(
      'https://api.example.com/v1',
      'allow-list',
      ['api.example.com'],
      privateIpv6Resolver,
    )).allowed).toBe(false);
  });

  it('admits only isolation roots, paths, resources, and hosts inside the owned workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-policy-'));
    const outside = mkdtempSync(join(tmpdir(), 'robb-policy-outside-'));
    try {
      mkdirSync(join(root, 'artifacts'));
      const basePolicy = {
        workspaceRoot: root,
        allowedReadPaths: ['.'],
        allowedWritePaths: ['artifacts'],
        networkAccess: 'allow-list' as const,
        allowedHosts: ['api.example.com'],
        maxCpuPercent: 50,
        maxMemoryMb: 512,
        timeoutMs: 60_000,
      };

      expect(validateExecutionIsolationPolicy(basePolicy, root).allowed).toBe(true);
      expect(validateExecutionIsolationPolicy({ ...basePolicy, workspaceRoot: outside }, root).allowed).toBe(false);
      expect(validateExecutionIsolationPolicy({ ...basePolicy, allowedWritePaths: ['../outside'] }, root).allowed).toBe(false);
      expect(validateExecutionIsolationPolicy({ ...basePolicy, allowedHosts: ['localhost'] }, root).allowed).toBe(false);
      expect(validateExecutionIsolationPolicy({ ...basePolicy, maxCpuPercent: 101 }, root).allowed).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('authorizes only unexpired secret leases at the requested scope', () => {
    const lease = {
      leaseId: 'lease-1',
      secretName: 'provider-token',
      workspaceId: 'ws-1',
      missionId: 'mission-1',
      toolName: 'github.create_issue',
      issuedAt: '2026-07-23T10:00:00.000Z',
      expiresAt: '2026-07-23T10:05:00.000Z',
      maxUses: 1,
      uses: 0,
    };
    expect(authorizeSecretLease(lease, {
      workspaceId: 'ws-1',
      missionId: 'mission-1',
      toolName: 'github.create_issue',
      now: '2026-07-23T10:01:00.000Z',
    }).allowed).toBe(true);
    expect(authorizeSecretLease(lease, {
      workspaceId: 'ws-2',
      missionId: 'mission-1',
      toolName: 'github.create_issue',
      now: '2026-07-23T10:01:00.000Z',
    }).allowed).toBe(false);
    expect(authorizeSecretLease(lease, {
      workspaceId: 'ws-1',
      missionId: 'mission-1',
      toolName: 'github.create_issue',
      now: '2026-07-23T10:05:00.000Z',
    }).allowed).toBe(false);
  });

  it('applies global, workspace, and mission kill switches', () => {
    expect(evaluateKillSwitch({ global: true, workspaceIds: [], missionIds: [] }, 'ws', 'mission').allowed).toBe(false);
    expect(evaluateKillSwitch({ global: false, workspaceIds: ['ws'], missionIds: [] }, 'ws', 'mission').allowed).toBe(false);
    expect(evaluateKillSwitch({ global: false, workspaceIds: [], missionIds: ['mission'] }, 'ws', 'mission').allowed).toBe(false);
    expect(evaluateKillSwitch({ global: false, workspaceIds: [], missionIds: [] }, 'ws', 'mission').allowed).toBe(true);
  });

  it('never retries a confirmed or ambiguous in-flight mutation across 1,000 recoveries', () => {
    const checkpoints: MutationCheckpoint[] = Array.from({ length: 1_000 }, (_, index) => ({
      idempotencyKey: `mission:node-${index}`,
      workspaceId: 'ws',
      missionId: 'mission',
      nodeId: `node-${index}`,
      status: index % 4 === 0 ? 'confirmed' : index % 4 === 1 ? 'executing' : index % 4 === 2 ? 'prepared' : 'failed',
      attempts: 1,
      updatedAt: '2026-07-23T10:00:00.000Z',
      ...(index % 4 === 0 ? { proofHash: `proof-${index}` } : {}),
    }));

    const decisions = checkpoints.map((checkpoint) => decideMutationRecovery(checkpoint));
    const unsafeRetries = decisions.filter((decision, index) => {
      const status = checkpoints[index]!.status;
      return decision.action === 'retry' && (status === 'confirmed' || status === 'executing');
    });
    expect(unsafeRetries).toHaveLength(0);
    expect(decisions.filter((decision) => decision.action === 'reuse-confirmed')).toHaveLength(250);
    expect(decisions.filter((decision) => decision.action === 'require-approval')).toHaveLength(250);
  });
});
