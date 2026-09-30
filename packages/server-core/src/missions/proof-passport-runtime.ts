import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { getCredentialManager, type CredentialId, type StoredCredential } from '@craft-agent/shared/credentials';
import { MissionProofPassportService } from './MissionProofPassportService.ts';

const PROOF_PASSPORT_KEY_PURPOSE = 'proof-passport-ed25519-v1';

interface CredentialStore {
  getOrCreate(id: CredentialId, create: () => StoredCredential): Promise<StoredCredential>;
}

export async function loadMissionProofPassportService(
  workspaceId: string,
  workspaceRoot: string,
  store: CredentialStore = getCredentialManager(),
): Promise<MissionProofPassportService> {
  const credential = await store.getOrCreate(
    { type: 'governance_signing_key', workspaceId, name: PROOF_PASSPORT_KEY_PURPOSE },
    () => {
      const { privateKey } = generateKeyPairSync('ed25519');
      const der = privateKey.export({ format: 'der', type: 'pkcs8' });
      return { value: Buffer.from(der).toString('base64url') };
    },
  );
  const privateKey = createPrivateKey({
    key: Buffer.from(credential.value, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  });
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`Proof Passport signing key is invalid for workspace ${workspaceId}`);
  }
  return new MissionProofPassportService({ workspaceId, workspaceRoot, privateKey });
}
