import { SecretLeaseBroker } from "@craft-agent/shared/credentials";
import { CapabilityBroker, StructuredEgressFirewall, DurableUseLedger, ExecutionProofIssuer } from "@craft-agent/shared/governance";
import { loadWorkspaceGovernanceSigningKey } from "../../tasks/execution-proof-runtime";
import type { CreateWorkspaceConnectorExecutionRuntimeInput } from './contracts.ts';
import { CAPABILITY_KEY_PURPOSE, EXECUTION_PROOF_KEY_PURPOSE, SECRET_LEASE_KEY_PURPOSE, STRUCTURED_EGRESS_KEY_PURPOSE } from './contracts.ts';
import { ConnectorExecutionRuntime } from './execution.ts';

export async function createWorkspaceConnectorExecutionRuntime(
  input: CreateWorkspaceConnectorExecutionRuntimeInput,
): Promise<ConnectorExecutionRuntime> {
  if (input.policy.workspaceId !== input.workspaceId) {
    throw new Error('Connector runtime policy workspace does not match')
  }
  const [capabilityKey, leaseKey, proofKey, egressKey] = await Promise.all([
    loadWorkspaceGovernanceSigningKey(input.workspaceId, CAPABILITY_KEY_PURPOSE, input.credentialStore),
    loadWorkspaceGovernanceSigningKey(input.workspaceId, SECRET_LEASE_KEY_PURPOSE, input.credentialStore),
    loadWorkspaceGovernanceSigningKey(input.workspaceId, EXECUTION_PROOF_KEY_PURPOSE, input.credentialStore),
    loadWorkspaceGovernanceSigningKey(input.workspaceId, STRUCTURED_EGRESS_KEY_PURPOSE, input.credentialStore),
  ])
  const nowMs = input.nowMs ?? Date.now
  const generation = input.registry.snapshot().generation
  const broker = new CapabilityBroker({
    policy: { ...input.policy, authorizationGeneration: generation },
    signingKey: capabilityKey,
    nowMs,
    generateId: input.generateId,
  })
  const secretLeaseBroker = new SecretLeaseBroker({
    signingKey: leaseKey,
    currentAuthorizationGeneration: () => input.registry.snapshot().generation,
    nowMs,
    generateId: input.generateId,
  })
  const proofIssuer = new ExecutionProofIssuer({
    signingKey: proofKey,
    now: () => new Date(nowMs()).toISOString(),
    generateId: input.generateId,
  })
  return new ConnectorExecutionRuntime({
    workspaceId: input.workspaceId,
    registry: input.registry,
    broker,
    secretLeaseBroker,
    proofIssuer,
    capabilityUseLedger: new DurableUseLedger(
      input.capabilityUseLedgerPath,
      () => new Date(nowMs()),
    ),
    connectors: input.connectors,
    transport: input.transport,
    resolveSecretValue: input.resolveSecretValue,
    reconcileMutation: input.reconcileMutation,
    recordExecutionProof: input.recordExecutionProof,
    egressFirewall: new StructuredEgressFirewall({
      signingKey: egressKey,
      now: () => new Date(nowMs()).toISOString(),
      generateId: input.generateId,
    }),
    recordPrivacyReceipt: input.recordPrivacyReceipt,
    storeEgressVaultEntries: input.storeEgressVaultEntries,
    nowMs,
    generateId: input.generateId,
  })
}
