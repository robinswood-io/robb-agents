import type { TaskSpec } from "../schema.ts";
import type { NodeOutput } from "../refs.ts";
import type { RunLogEntry } from "../storage.ts";
import type { ExecutionProofVerificationDecision, SignedExecutionProof, TaskExecutionProofBinding } from "../../governance/execution-proof.ts";
import type { MissionReplayNodePlan, MissionReplayPlan } from './contracts.ts';

export function planMissionReplay(
  spec: TaskSpec,
  sourceRunId: string,
  log: RunLogEntry[],
  loadOutput: (nodeId: string) => NodeOutput | null,
  options: {
    approveExternalMutations?: boolean;
    workspaceId?: string;
    verifyExecutionProof?: (
      proof: SignedExecutionProof,
      binding: TaskExecutionProofBinding,
    ) => ExecutionProofVerificationDecision;
  } = {},
): MissionReplayPlan {
  const confirmed = new Map<string, string | undefined>();
  const ambiguous = new Set<string>();
  const externalMutationIds = new Set(
    spec.nodes.filter((node) => node.effect === 'external-mutation').map((node) => node.id),
  );
  for (const entry of log) {
    if (entry.kind !== 'node-checkpoint') continue;
    if (entry.status === 'executing') ambiguous.add(entry.nodeId);
    else if (entry.status === 'confirmed') {
      if (externalMutationIds.has(entry.nodeId)) {
        const decision = entry.executionProof && options.workspaceId && options.verifyExecutionProof
          ? options.verifyExecutionProof(entry.executionProof, {
              workspaceId: options.workspaceId,
              missionId: spec.id,
              nodeId: entry.nodeId,
              idempotencyKey: entry.idempotencyKey,
            })
          : undefined;
        if (!decision?.allowed) {
          confirmed.delete(entry.nodeId);
          ambiguous.add(entry.nodeId);
          continue;
        }
      }
      ambiguous.delete(entry.nodeId);
      confirmed.set(entry.nodeId, entry.proofHash);
    }
  }
  const nodes = spec.nodes.map((node): MissionReplayNodePlan => {
    if (confirmed.has(node.id) && loadOutput(node.id)) {
      return { nodeId: node.id, action: 'reuse', reason: 'Confirmed output is reusable without executing the node.', effect: node.effect };
    }
    if (ambiguous.has(node.id)) {
      return {
        nodeId: node.id,
        action: 'block',
        reason: 'Execution began but was not confirmed; provider state must be reconciled first.',
        effect: node.effect,
      };
    }
    if (node.effect === 'external-mutation' && !options.approveExternalMutations) {
      return {
        nodeId: node.id,
        action: 'block',
        reason: 'External mutations are disabled for replay until explicitly approved.',
        effect: node.effect,
      };
    }
    return { nodeId: node.id, action: 'retry', reason: 'No confirmed output is available.', effect: node.effect };
  });
  const blockedNodeIds = nodes.filter((node) => node.action === 'block').map((node) => node.nodeId);
  return {
    sourceRunId,
    safeByDefault: !options.approveExternalMutations,
    nodes,
    requiresApproval: nodes.some((node) => node.effect === 'external-mutation' && node.action !== 'reuse'),
    blockedNodeIds,
  };
}
