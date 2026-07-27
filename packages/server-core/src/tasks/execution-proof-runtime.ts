import { randomBytes } from 'node:crypto'
import { getCredentialManager, type CredentialId, type StoredCredential } from '@craft-agent/shared/credentials'
import { ExecutionProofIssuer } from '@craft-agent/shared/governance'

const EXECUTION_PROOF_KEY_PURPOSE = 'execution-proof-v1'

export interface GovernanceCredentialStore {
  getOrCreate(id: CredentialId, create: () => StoredCredential): Promise<StoredCredential>
}

export async function loadWorkspaceGovernanceSigningKey(
  workspaceId: string,
  purpose: string,
  store: GovernanceCredentialStore = getCredentialManager(),
): Promise<Buffer> {
  if (!workspaceId.trim()) throw new Error('Governance signing key workspace is required')
  if (!purpose.trim()) throw new Error('Governance signing key purpose is required')
  const credential = await store.getOrCreate(
    {
      type: 'governance_signing_key',
      workspaceId,
      name: purpose,
    },
    () => ({ value: randomBytes(32).toString('base64url') }),
  )
  const signingKey = Buffer.from(credential.value, 'base64url')
  if (signingKey.byteLength !== 32) {
    throw new Error(`Governance signing key ${purpose} is invalid for workspace ${workspaceId}`)
  }
  return signingKey
}

/**
 * Loads the workspace proof key from the encrypted host credential store,
 * creating it atomically once. The key never enters mission messages, connector
 * responses, renderer events, or exported reports.
 */
export async function loadWorkspaceExecutionProofIssuer(
  workspaceId: string,
  store: GovernanceCredentialStore = getCredentialManager(),
): Promise<ExecutionProofIssuer> {
  const signingKey = await loadWorkspaceGovernanceSigningKey(
    workspaceId,
    EXECUTION_PROOF_KEY_PURPOSE,
    store,
  )
  return new ExecutionProofIssuer({ signingKey })
}
