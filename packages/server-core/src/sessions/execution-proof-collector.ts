import {
  SignedExecutionProofSchema,
  operationValueHash,
  type SignedExecutionProof,
} from '@craft-agent/shared/governance'

export interface SessionExecutionBinding {
  sessionId: string
  workspaceId: string
  missionId: string
  nodeId: string
}

/**
 * Private host-side mailbox for connector proofs. It deliberately has no
 * renderer, RPC, prompt, or model-text ingestion path.
 */
export class ExecutionProofCollector {
  private readonly proofs = new Map<string, SignedExecutionProof>()

  record(binding: SessionExecutionBinding, value: unknown): SignedExecutionProof {
    const proof = SignedExecutionProofSchema.parse(value)
    if (
      proof.workspaceId !== binding.workspaceId
      || proof.missionId !== binding.missionId
      || proof.nodeId !== binding.nodeId
    ) {
      throw new Error('Execution proof does not match the bound session identity')
    }
    const existing = this.proofs.get(binding.sessionId)
    if (existing && operationValueHash(existing) !== operationValueHash(proof)) {
      throw new Error('Conflicting execution proofs were recorded for one session turn')
    }
    this.proofs.set(binding.sessionId, proof)
    return proof
  }

  take(sessionId: string): SignedExecutionProof | undefined {
    const proof = this.proofs.get(sessionId)
    this.proofs.delete(sessionId)
    return proof
  }

  discard(sessionId: string): void {
    this.proofs.delete(sessionId)
  }
}
