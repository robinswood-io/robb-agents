import { createHash, sign, verify, type KeyObject } from 'node:crypto';

export type ConnectorPackCategory =
  | 'productivity'
  | 'collaboration'
  | 'crm'
  | 'erp';

export type ConnectorOperationEffect = 'read' | 'write' | 'external-mutation';
export type ConnectorApprovalMode = 'never' | 'risk-based' | 'always';

export interface ConnectorPackOperation {
  id: string;
  title: string;
  effect: ConnectorOperationEffect;
  requiredScopes: string[];
  approval: ConnectorApprovalMode;
  idempotent: boolean;
  compensation?: {
    strategy: 'inverse-operation' | 'restore-snapshot' | 'manual';
    operationId?: string;
  };
}

export interface ConnectorPackDefinition {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  category: ConnectorPackCategory;
  publisher: {
    id: string;
    name: string;
    website: string;
  };
  authentication: {
    type: 'oauth2' | 'api-key' | 'service-account';
    secretReferenceFields: string[];
    requiredScopes: string[];
    optionalScopes: string[];
  };
  healthCheck: {
    operationId: string;
    timeoutMs: number;
  };
  rateLimit: {
    requests: number;
    windowMs: number;
    maxConcurrency: number;
  };
  operations: ConnectorPackOperation[];
}

export interface ConnectorPackSignature {
  algorithm: 'ed25519';
  keyId: string;
  signedAt: string;
  value: string;
}

export interface SignedConnectorPackManifest extends ConnectorPackDefinition {
  signature: ConnectorPackSignature;
}

export interface ConnectorPackValidation {
  valid: boolean;
  errors: string[];
  manifestHash: string;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function connectorPackSigningPayload(definition: ConnectorPackDefinition): string {
  return JSON.stringify(stableValue(definition));
}

export function connectorPackManifestHash(definition: ConnectorPackDefinition): string {
  return createHash('sha256').update(connectorPackSigningPayload(definition), 'utf8').digest('hex');
}

export function signConnectorPackManifest(
  definition: ConnectorPackDefinition,
  keyId: string,
  privateKey: KeyObject,
  signedAt = new Date().toISOString(),
): SignedConnectorPackManifest {
  const value = sign(null, Buffer.from(connectorPackSigningPayload(definition), 'utf8'), privateKey).toString('base64');
  return {
    ...definition,
    signature: { algorithm: 'ed25519', keyId, signedAt, value },
  };
}

export function validateConnectorPackDefinition(definition: ConnectorPackDefinition): ConnectorPackValidation {
  const errors: string[] = [];
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(definition.id)) {
    errors.push('id must use a namespaced lowercase identifier');
  }
  if (!definition.version.trim()) errors.push('version is required');
  if (!definition.publisher.id.trim() || !definition.publisher.website.startsWith('https://')) {
    errors.push('publisher identity and HTTPS website are required');
  }
  if (definition.authentication.secretReferenceFields.length === 0) {
    errors.push('authentication must use at least one secret reference field');
  }
  if (definition.healthCheck.timeoutMs <= 0) errors.push('health check timeout must be positive');
  if (
    definition.rateLimit.requests <= 0
    || definition.rateLimit.windowMs <= 0
    || definition.rateLimit.maxConcurrency <= 0
  ) {
    errors.push('rate limits must be positive');
  }

  const operationIds = new Set<string>();
  const declaredScopes = new Set([
    ...definition.authentication.requiredScopes,
    ...definition.authentication.optionalScopes,
  ]);
  for (const operation of definition.operations) {
    if (operationIds.has(operation.id)) errors.push(`duplicate operation id: ${operation.id}`);
    operationIds.add(operation.id);
    for (const scope of operation.requiredScopes) {
      if (!declaredScopes.has(scope)) errors.push(`${operation.id} uses undeclared scope ${scope}`);
    }
    if (operation.effect === 'read' && operation.approval === 'always') {
      errors.push(`${operation.id} read operation cannot force approval`);
    }
    if (operation.effect !== 'read' && operation.approval === 'never') {
      errors.push(`${operation.id} mutating operation must require an approval policy`);
    }
    if (operation.effect === 'external-mutation' && !operation.compensation) {
      errors.push(`${operation.id} external mutation requires a compensation strategy`);
    }
  }
  if (!operationIds.has(definition.healthCheck.operationId)) {
    errors.push('health check must reference a declared operation');
  }

  return {
    valid: errors.length === 0,
    errors,
    manifestHash: connectorPackManifestHash(definition),
  };
}

export function verifyConnectorPackManifest(
  manifest: SignedConnectorPackManifest,
  publicKey: KeyObject,
): ConnectorPackValidation {
  const { signature, ...definition } = manifest;
  const validation = validateConnectorPackDefinition(definition);
  const validSignature = verify(
    null,
    Buffer.from(connectorPackSigningPayload(definition), 'utf8'),
    publicKey,
    Buffer.from(signature.value, 'base64'),
  );
  return validSignature
    ? validation
    : { ...validation, valid: false, errors: [...validation.errors, 'invalid publisher signature'] };
}

export interface InstalledConnectorPack {
  manifest: SignedConnectorPackManifest;
  manifestHash: string;
  installedAt: string;
  status: 'active' | 'revoked';
  revokedAt?: string;
  revocationReason?: string;
}

export class ConnectorPackRegistry {
  private readonly packs = new Map<string, InstalledConnectorPack>();

  constructor(private readonly resolvePublisherKey: (keyId: string) => KeyObject | null) {}

  install(manifest: SignedConnectorPackManifest): InstalledConnectorPack {
    const publicKey = this.resolvePublisherKey(manifest.signature.keyId);
    if (!publicKey) throw new Error(`Untrusted publisher key: ${manifest.signature.keyId}`);
    const validation = verifyConnectorPackManifest(manifest, publicKey);
    if (!validation.valid) throw new Error(`Invalid connector pack: ${validation.errors.join('; ')}`);
    const installed: InstalledConnectorPack = {
      manifest,
      manifestHash: validation.manifestHash,
      installedAt: new Date().toISOString(),
      status: 'active',
    };
    this.packs.set(manifest.id, installed);
    return installed;
  }

  revoke(packId: string, reason: string): InstalledConnectorPack {
    const existing = this.packs.get(packId);
    if (!existing) throw new Error(`Connector pack ${packId} is not installed`);
    const revoked: InstalledConnectorPack = {
      ...existing,
      status: 'revoked',
      revokedAt: new Date().toISOString(),
      revocationReason: reason,
    };
    this.packs.set(packId, revoked);
    return revoked;
  }

  assertOperationAllowed(packId: string, operationId: string): ConnectorPackOperation {
    const installed = this.packs.get(packId);
    if (!installed || installed.status !== 'active') {
      throw new Error(`Connector pack ${packId} is not active`);
    }
    const operation = installed.manifest.operations.find((candidate) => candidate.id === operationId);
    if (!operation) throw new Error(`Unknown connector operation ${operationId}`);
    return operation;
  }
}

export interface ConnectorPackDriver {
  healthCheck(): Promise<{ healthy: boolean; latencyMs: number }>;
  invoke(operationId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export async function runConnectorPackContract(
  manifest: ConnectorPackDefinition,
  driver: ConnectorPackDriver,
): Promise<{
  passed: boolean;
  failures: string[];
  healthLatencyMs: number;
}> {
  const validation = validateConnectorPackDefinition(manifest);
  const failures = [...validation.errors];
  const health = await driver.healthCheck();
  if (!health.healthy) failures.push('driver health check failed');
  if (health.latencyMs > manifest.healthCheck.timeoutMs) {
    failures.push(`driver health check exceeded ${manifest.healthCheck.timeoutMs} ms`);
  }
  for (const operation of manifest.operations) {
    const response = await driver.invoke(operation.id, { contractProbe: true });
    if (response.operationId !== operation.id) failures.push(`${operation.id} contract probe did not echo operationId`);
  }
  return { passed: failures.length === 0, failures, healthLatencyMs: health.latencyMs };
}

function packTemplate(input: {
  id: string;
  name: string;
  category: ConnectorPackCategory;
  scopes: string[];
  readOperation: string;
  writeOperation: string;
}): ConnectorPackDefinition {
  return {
    schemaVersion: 1,
    id: input.id,
    name: input.name,
    version: '1.0.0',
    category: input.category,
    publisher: {
      id: 'io.robb-agents',
      name: 'Robb Agents',
      website: 'https://robinswood.io',
    },
    authentication: {
      type: 'oauth2',
      secretReferenceFields: ['oauthClientSecretRef'],
      requiredScopes: [input.scopes[0] ?? 'read'],
      optionalScopes: input.scopes.slice(1),
    },
    healthCheck: { operationId: 'health.read', timeoutMs: 5_000 },
    rateLimit: { requests: 100, windowMs: 60_000, maxConcurrency: 4 },
    operations: [
      {
        id: 'health.read',
        title: 'Health check',
        effect: 'read',
        requiredScopes: [input.scopes[0] ?? 'read'],
        approval: 'never',
        idempotent: true,
      },
      {
        id: input.readOperation,
        title: 'Read records',
        effect: 'read',
        requiredScopes: [input.scopes[0] ?? 'read'],
        approval: 'never',
        idempotent: true,
      },
      {
        id: input.writeOperation,
        title: 'Create or update record',
        effect: 'external-mutation',
        requiredScopes: input.scopes,
        approval: 'always',
        idempotent: false,
        compensation: { strategy: 'manual' },
      },
    ],
  };
}

export const connectorPackTemplates = {
  microsoft365: packTemplate({
    id: 'io.robb-agents.microsoft-365',
    name: 'Microsoft 365',
    category: 'productivity',
    scopes: ['Files.Read', 'Files.ReadWrite'],
    readOperation: 'files.list',
    writeOperation: 'files.update',
  }),
  googleWorkspace: packTemplate({
    id: 'io.robb-agents.google-workspace',
    name: 'Google Workspace',
    category: 'productivity',
    scopes: ['drive.readonly', 'drive.file'],
    readOperation: 'drive.list',
    writeOperation: 'drive.update',
  }),
  slackTeams: packTemplate({
    id: 'io.robb-agents.slack-teams',
    name: 'Slack & Teams',
    category: 'collaboration',
    scopes: ['channels.history', 'chat.write'],
    readOperation: 'messages.list',
    writeOperation: 'messages.send',
  }),
  crm: packTemplate({
    id: 'io.robb-agents.crm',
    name: 'CRM',
    category: 'crm',
    scopes: ['crm.objects.read', 'crm.objects.write'],
    readOperation: 'records.list',
    writeOperation: 'records.upsert',
  }),
  erp: packTemplate({
    id: 'io.robb-agents.erp',
    name: 'ERP',
    category: 'erp',
    scopes: ['erp.records.read', 'erp.records.write'],
    readOperation: 'entries.list',
    writeOperation: 'entries.post',
  }),
} satisfies Record<string, ConnectorPackDefinition>;
