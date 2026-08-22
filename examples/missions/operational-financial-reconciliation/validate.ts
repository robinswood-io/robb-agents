import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  connectorPackTemplates,
  validateConnectorPackDefinition,
  type PriorityConnectorPack,
} from '@craft-agent/shared/connectors';
import {
  CapabilityPolicySchema,
  StructuredEgressFirewall,
  StructuredEgressPolicySchema,
  type StructuredEgressPolicy,
} from '@craft-agent/shared/governance';
import {
  MissionSpecSchema,
  type MissionSpec,
  type MissionWorkItem,
} from '@craft-agent/shared/missions';

const PACK_ROOT = dirname(fileURLToPath(import.meta.url));

interface PackVariant {
  id: string;
  missionSpec: string;
  capabilityPolicy: string;
  documentaryPack: string;
  documentaryOperation: string;
  documentaryOrigin: string;
}

interface PackManifest {
  schemaVersion: number;
  id: string;
  version: string;
  qualificationLevel: string;
  realTenantQualified: boolean;
  legacyTask: {
    path: string;
    status: string;
    runtime: string;
    executableByMissionV2: boolean;
  };
  variants: PackVariant[];
  commonConnectors: Array<{ pack: string; operation: string; egressPolicy: string }>;
  documentaryEgressPolicies: Record<string, string>;
  contractMocks: string;
  qualificationGates: {
    local: Record<string, boolean | number>;
    tenant: { required: boolean; status: string; checks: string[] };
  };
  kpis: Record<string, number>;
}

interface MockContracts {
  schemaVersion: number;
  operations: Array<{
    pack: string;
    operationId: string;
    resourceType: string;
    resourceId: string;
    providerStatus: number;
    providerRequestId: string;
    providerState: Record<string, unknown>;
    reconciliation: string;
  }>;
  faults: Record<string, unknown>;
}

export interface FinancialPackQualificationReport {
  packId: string;
  version: string;
  qualificationLevel: 'contract-offline';
  realTenantQualified: false;
  variants: Array<{
    id: string;
    missionId: string;
    workItemCount: number;
    externalMutationCount: number;
  }>;
  connectorPacks: string[];
  mutationCount: number;
  networkCalls: 0;
  tenantGates: 'not-run';
}

function packPath(path: string): string {
  const candidate = resolve(PACK_ROOT, path);
  const rel = relative(PACK_ROOT, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`Pack path escapes its root: ${path}`);
  }
  return candidate;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(packPath(path), 'utf8')) as T;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function requirePriorityPack(value: string): PriorityConnectorPack {
  assert(Object.hasOwn(connectorPackTemplates, value), `Unknown connector pack ${value}`);
  return value as PriorityConnectorPack;
}

function externalMutations(spec: MissionSpec): MissionWorkItem[] {
  return spec.workItems.filter((item) => item.effect === 'external-mutation');
}

function egressPolicyPath(manifest: PackManifest, variant: PackVariant, pack: string): string {
  const common = manifest.commonConnectors.find((entry) => entry.pack === pack)?.egressPolicy;
  if (common) return common;
  const documentary = manifest.documentaryEgressPolicies[variant.documentaryPack];
  assert(pack === variant.documentaryPack && documentary, `Missing egress policy for ${pack}`);
  return documentary;
}

function validateMutation(
  item: MissionWorkItem,
  policyValue: unknown,
  mocks: MockContracts,
): { pack: PriorityConnectorPack; policy: StructuredEgressPolicy } {
  const invocation = item.connectorInvocation;
  assert(invocation, `${item.id} has no connectorInvocation`);
  assert(!item.execution, `${item.id} must not use the generic session execution envelope`);
  const pack = requirePriorityPack(invocation.pack);
  const manifest = connectorPackTemplates[pack];
  const operation = manifest.operations.find(({ id }) => id === invocation.operationId);
  assert(operation, `${item.id} references unknown operation ${invocation.operationId}`);
  assert(operation.effect === 'external-mutation', `${item.id} operation is not an external mutation`);
  assert(operation.approval === 'always', `${item.id} operation must always require host approval`);
  assert(operation.reconciliation.required, `${item.id} operation must require reconciliation`);
  assert(operation.targetResourceTypes.includes(invocation.resourceType), `${item.id} resource type is denied`);
  assert(
    operation.compensation?.strategy === invocation.compensation.strategy,
    `${item.id} compensation differs from the installed connector manifest`,
  );
  assert(
    item.requiredEvidence.some(({ id, kind }) => id === invocation.receiptRequirementId && kind === 'receipt'),
    `${item.id} has no matching receipt requirement`,
  );
  const mock = mocks.operations.find(({ pack: mockPack, operationId }) =>
    mockPack === pack && operationId === invocation.operationId);
  assert(mock, `${item.id} has no contractual provider mock`);
  assert(mock.resourceType === invocation.resourceType, `${item.id} mock resource type differs`);
  assert(mock.resourceId === invocation.resourceId, `${item.id} mock resource id differs`);
  assert(mock.providerStatus >= 200 && mock.providerStatus < 300, `${item.id} mock is not successful`);
  assert(mock.providerRequestId.length > 0, `${item.id} mock lacks provider request id`);
  assert(mock.reconciliation === 'confirmed', `${item.id} happy-path mock is not reconciled`);

  const policy = StructuredEgressPolicySchema.parse(policyValue);
  const origin = operation.allowedOrigins[0];
  assert(origin && policy.allowedOrigins.includes(origin), `${item.id} egress policy denies connector origin`);
  const firewall = new StructuredEgressFirewall({
    signingKey: Buffer.alloc(32, 17),
    now: () => '2026-08-20T12:00:00.000Z',
    generateId: () => `validation-${item.id}`,
  });
  firewall.prepare({ payload: invocation.payload, destinationOrigin: origin, policy });
  return { pack, policy };
}

export function validateFinancialReconciliationPack(): FinancialPackQualificationReport {
  const manifest = readJson<PackManifest>('pack.manifest.json');
  assert(manifest.schemaVersion === 1, 'Unsupported pack manifest version');
  assert(manifest.id === 'io.robb-agents.vertical.financial-reconciliation', 'Unexpected pack id');
  assert(manifest.version === '1.0.0', 'Unexpected pack version');
  assert(manifest.qualificationLevel === 'contract-offline', 'Pack must remain contract-offline');
  assert(manifest.realTenantQualified === false, 'Offline validation cannot claim tenant qualification');
  assert(manifest.legacyTask.status === 'legacy-reference-only', 'Legacy Task status must be explicit');
  assert(manifest.legacyTask.executableByMissionV2 === false, 'Legacy Task cannot be a Mission V2 input');
  assert(manifest.variants.length === 2, 'Exactly two documentary variants are required');
  assert(new Set(manifest.variants.map(({ id }) => id)).size === 2, 'Variant ids must be unique');
  assert(manifest.qualificationGates.tenant.required, 'Real tenant qualification gates are mandatory');
  assert(manifest.qualificationGates.tenant.status === 'not-run', 'Tenant status must not be overstated');
  assert(manifest.qualificationGates.tenant.checks.length >= 8, 'Tenant gate checklist is incomplete');
  for (const [gate, value] of Object.entries(manifest.qualificationGates.local)) {
    const isZeroGate = gate === 'networkCalls' || gate === 'duplicateMutationCount';
    assert(
      isZeroGate ? value === 0 : value === true,
      `Local qualification gate ${gate} is not closed`,
    );
  }
  assert(manifest.kpis.duplicateMutationCount === 0, 'Duplicate mutation KPI must be zero');
  assert(manifest.kpis.unreconciledMutationCount === 0, 'Unreconciled mutation KPI must be zero');
  assert(manifest.kpis.requiredEvidenceCoveragePercent === 100, 'Evidence coverage KPI must be 100%');
  assert(manifest.kpis.approvalCoveragePercent === 100, 'Approval coverage KPI must be 100%');
  assert(manifest.kpis.proofVerificationPercent === 100, 'Proof verification KPI must be 100%');
  assert(manifest.kpis.privacyReceiptCoveragePercent === 100, 'Privacy receipt KPI must be 100%');

  const mocks = readJson<MockContracts>(manifest.contractMocks);
  assert(mocks.schemaVersion === 1, 'Unsupported mock contract version');
  assert(Object.hasOwn(mocks.faults, 'crashAfterProviderMutation'), 'Crash recovery mock is missing');
  assert(Object.hasOwn(mocks.faults, 'providerStateDivergence'), 'Divergence mock is missing');

  const connectorPacks = new Set<string>();
  let mutationCount = 0;
  const variants = manifest.variants.map((variant) => {
    const spec = MissionSpecSchema.parse(readJson<unknown>(variant.missionSpec));
    assert(spec.id.endsWith(variant.id), `${variant.id} Mission id is not variant-bound`);
    const mutations = externalMutations(spec);
    assert(mutations.length === 3, `${variant.id} must contain exactly three brokered mutations`);
    const expectedMutationContracts = new Set([
      'crm/records.upsert',
      'erp/entries.post',
      `${variant.documentaryPack}/${variant.documentaryOperation}`,
    ]);
    const actualMutationContracts = new Set(mutations.map((item) =>
      `${item.connectorInvocation!.pack}/${item.connectorInvocation!.operationId}`));
    assert(
      actualMutationContracts.size === expectedMutationContracts.size
      && [...expectedMutationContracts].every((contract) => actualMutationContracts.has(contract)),
      `${variant.id} mutation set differs from the qualified contract`,
    );
    assert(
      mutations.some((item) => item.connectorInvocation?.pack === variant.documentaryPack
        && item.connectorInvocation.operationId === variant.documentaryOperation),
      `${variant.id} documentary mutation does not match its manifest`,
    );
    const documentaryOperation = connectorPackTemplates[requirePriorityPack(variant.documentaryPack)].operations
      .find(({ id }) => id === variant.documentaryOperation);
    assert(
      documentaryOperation?.allowedOrigins.includes(variant.documentaryOrigin),
      `${variant.id} documentary origin differs from the connector contract`,
    );
    for (const item of mutations) {
      const policyPath = egressPolicyPath(manifest, variant, item.connectorInvocation!.pack);
      const { pack } = validateMutation(item, readJson<unknown>(policyPath), mocks);
      connectorPacks.add(pack);
      mutationCount += 1;
    }

    const capability = CapabilityPolicySchema.parse(readJson<unknown>(variant.capabilityPolicy));
    assert(capability.enabled, `${variant.id} capability policy is disabled`);
    assert(capability.workspaceId === 'qualification-workspace', `${variant.id} policy is not qualification-scoped`);
    assert(capability.approvalRequiredFor.includes('W2'), `${variant.id} policy does not approve W2`);
    assert(capability.approvalRequiredFor.includes('W3'), `${variant.id} policy does not approve W3`);
    for (const item of mutations) {
      const invocation = item.connectorInvocation!;
      const operation = connectorPackTemplates[requirePriorityPack(invocation.pack)].operations
        .find(({ id }) => id === invocation.operationId)!;
      assert(capability.allowedOperations.includes(invocation.operationId), `${variant.id} policy denies ${invocation.operationId}`);
      assert(capability.allowedOrigins.includes(operation.allowedOrigins[0]!), `${variant.id} policy denies ${operation.allowedOrigins[0]}`);
      assert(capability.allowedResourceTypes.includes(invocation.resourceType), `${variant.id} policy denies ${invocation.resourceType}`);
    }

    return {
      id: variant.id,
      missionId: spec.id,
      workItemCount: spec.workItems.length,
      externalMutationCount: mutations.length,
    };
  });

  for (const pack of connectorPacks) {
    const validation = validateConnectorPackDefinition(connectorPackTemplates[requirePriorityPack(pack)]);
    assert(validation.valid, `${pack} connector manifest is invalid: ${validation.errors.join('; ')}`);
  }

  return {
    packId: manifest.id,
    version: manifest.version,
    qualificationLevel: 'contract-offline',
    realTenantQualified: false,
    variants,
    connectorPacks: [...connectorPacks].sort(),
    mutationCount,
    networkCalls: 0,
    tenantGates: 'not-run',
  };
}

if (import.meta.main) {
  try {
    const report = validateFinancialReconciliationPack();
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
