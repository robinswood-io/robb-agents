import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import {
  ConnectorPackRegistry,
  connectorPackTemplates,
  runConnectorPackContract,
  signConnectorPackManifest,
  validateConnectorPackDefinition,
  verifyConnectorPackManifest,
  type ConnectorPackDefinition,
} from './pack-manifest';

describe('connector pack contract', () => {
  test('validates the five least-privilege starter templates', () => {
    const validations = Object.values(connectorPackTemplates).map(validateConnectorPackDefinition);
    expect(validations).toHaveLength(5);
    expect(validations.every((validation) => validation.valid)).toBe(true);
  });

  test('rejects unsafe external mutations and undeclared scopes', () => {
    const unsafe: ConnectorPackDefinition = {
      ...connectorPackTemplates.crm,
      operations: [{
        id: 'contacts.delete',
        title: 'Delete contact',
        effect: 'external-mutation',
        risk: 'W3',
        requiredScopes: ['crm.admin'],
        allowedOrigins: ['https://crm.example.com'],
        targetResourceTypes: ['crm-record'],
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        approval: 'never',
        idempotent: false,
        reconciliation: { required: false, receiptFields: [] },
      }],
      healthCheck: { operationId: 'contacts.delete', timeoutMs: 1_000 },
    };
    const validation = validateConnectorPackDefinition(unsafe);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain('contacts.delete uses undeclared scope crm.admin');
    expect(validation.errors).toContain('contacts.delete mutating operation must require an approval policy');
    expect(validation.errors).toContain('contacts.delete external mutation requires a compensation strategy');
    expect(validation.errors).toContain('contacts.delete external mutation requires reconciliation');
  });

  test('verifies publisher signatures and revokes installed packs', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const signed = signConnectorPackManifest(
      connectorPackTemplates.googleWorkspace,
      'publisher-key-1',
      privateKey,
      '2026-07-23T10:00:00.000Z',
    );
    expect(verifyConnectorPackManifest(signed, publicKey).valid).toBe(true);
    const registry = new ConnectorPackRegistry((keyId) => keyId === 'publisher-key-1' ? publicKey : null);
    expect(registry.install(signed).status).toBe('active');
    expect(registry.assertOperationAllowed(signed.id, 'drive.list').effect).toBe('read');
    registry.revoke(signed.id, 'Publisher key rotation');
    expect(() => registry.assertOperationAllowed(signed.id, 'drive.list')).toThrow('not active');
  });

  test('runs the same contract against mock SaaS and ERP drivers', async () => {
    const driver = {
      healthCheck: async () => ({ healthy: true, latencyMs: 25 }),
      invoke: async (operationId: string) => ({ operationId }),
    };
    const saas = await runConnectorPackContract(connectorPackTemplates.microsoft365, driver);
    const erp = await runConnectorPackContract(connectorPackTemplates.erp, driver);
    expect([saas.passed, erp.passed]).toEqual([true, true]);
  });
});
