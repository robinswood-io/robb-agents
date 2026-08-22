import { describe, expect, it } from 'bun:test';
import {
  StructuredEgressDeniedError,
  StructuredEgressFirewall,
  type StructuredEgressPolicy,
} from './structured-egress-firewall.ts';

const policy: StructuredEgressPolicy = {
  schemaVersion: 1,
  policyId: 'tenant-fr-structured-v1',
  allowedOrigins: ['https://api.example.test'],
  purpose: 'Rapprochement financier approuvé',
  unmatchedAction: 'drop',
  piiAction: 'pseudonymize',
  rules: [
    { path: 'invoice.id', classification: 'business-sensitive', action: 'allow' },
    { path: 'invoice.amount', classification: 'business-sensitive', action: 'allow' },
    { path: 'customer.email', classification: 'pii', action: 'pseudonymize' },
  ],
};

function firewall() {
  return new StructuredEgressFirewall({
    signingKey: 'k'.repeat(32),
    now: () => '2026-08-20T12:00:00.000Z',
    generateId: () => 'privacy-receipt-1',
  });
}

describe('StructuredEgressFirewall', () => {
  it('minimizes fields, pseudonymizes French PII deterministically, and signs a value-free receipt', () => {
    const boundary = firewall();
    const input = {
      invoice: { id: 'INV-42', amount: 1200, internalNote: 'do not send' },
      customer: { email: 'alice@example.fr', phone: '+33 6 12 34 56 78' },
    };
    const first = boundary.prepare({ payload: input, destinationOrigin: 'https://api.example.test/v1', policy });
    const second = boundary.prepare({ payload: input, destinationOrigin: 'https://api.example.test', policy });
    expect(first.payload).toEqual({
      invoice: { id: 'INV-42', amount: 1200 },
      customer: {
        email: expect.stringMatching(/^psn_/),
        phone: expect.stringMatching(/^psn_/),
      },
    });
    expect(first.payload.customer).toEqual(second.payload.customer);
    expect(first.vaultEntries).toHaveLength(2);
    const receipt = boundary.issueReceipt({
      prepared: first,
      workspaceId: 'workspace-1', missionId: 'mission-1',
      connectorId: 'com.example.erp', operationId: 'entries.post',
    });
    expect(boundary.verifyReceipt(receipt)).toBe(true);
    expect(receipt).toMatchObject({
      boundaryEvent: 'released-to-transport',
      releasedAt: '2026-08-20T12:00:00.000Z',
    });
    const encoded = JSON.stringify(receipt);
    expect(encoded).not.toContain('alice@example.fr');
    expect(encoded).not.toContain('+33 6');
    expect(receipt.fields.find(({ path }) => path === 'invoice.internalNote')?.action).toBe('drop');
  });

  it.each([
    ['api_token', 'sk-proj-abcdefghijklmnop'],
    ['authorization', 'Bearer harmless-looking-value'],
    ['note', 'ghp_abcdefghijklmnopqrstuvwxyz1234'],
    ['private_key', '-----BEGIN PRIVATE KEY-----'],
  ])('blocks secret canary %s before any egress', (key, value) => {
    let caught: unknown;
    try {
      firewall().prepare({
        payload: { invoice: { id: 'INV-1', amount: 1 }, [key]: value },
        destinationOrigin: 'https://api.example.test', policy,
      });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(StructuredEgressDeniedError);
    expect((caught as StructuredEgressDeniedError).code).toBe('SECRET_DETECTED');
  });

  it('denies an origin outside tenant policy', () => {
    expect(() => firewall().prepare({
      payload: { invoice: { id: 'INV-1', amount: 1 } },
      destinationOrigin: 'https://evil.example', policy,
    })).toThrow('not allowed');
  });

  it('detects receipt tampering', () => {
    const boundary = firewall();
    const prepared = boundary.prepare({
      payload: { invoice: { id: 'INV-1', amount: 1 } },
      destinationOrigin: 'https://api.example.test', policy,
    });
    const receipt = boundary.issueReceipt({
      prepared, workspaceId: 'workspace-1', missionId: 'mission-1',
      connectorId: 'com.example.erp', operationId: 'entries.post',
    });
    expect(boundary.verifyReceipt({ ...receipt, purpose: 'different' })).toBe(false);
  });

  it('rejects cyclic, non-JSON, and non-finite structured values', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const payload of [
      cyclic,
      { invoice: new Date('2026-08-20T00:00:00.000Z') },
      { amount: Number.NaN },
      { callback: () => undefined },
    ]) {
      expect(() => firewall().prepare({
        payload, destinationOrigin: 'https://api.example.test', policy,
      })).toThrow(StructuredEgressDeniedError);
    }
  });
});
