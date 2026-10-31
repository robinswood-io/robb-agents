import { isUnknownArray } from '../../utils/json.ts';
import { KeyObject, createHash, createPrivateKey, sign as signBytes } from "node:crypto";
import type { LearningEventSigner, UnsignedLearningEvent, VerifiedLearningEvent } from './contracts.ts';
import { VerifiedLearningEventSchema } from './contracts.ts';

export function signEvent(
  event: UnsignedLearningEvent,
  signer: LearningEventSigner,
): VerifiedLearningEvent {
  if (!signer.actorId.trim() || !signer.keyId.trim() || signer.actorId !== event.actorId) throw new Error('Learning signer binding is invalid');
  const privateKey = keyObject(signer.privateKey);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Learning signing key must be Ed25519');
  const unsigned = { ...event, signature: { algorithm: 'Ed25519' as const, keyId: signer.keyId, value: '' } };
  const signed = {
    ...unsigned,
    signature: {
      ...unsigned.signature,
      value: signBytes(null, eventSigningBytes(unsigned), privateKey).toString('base64url'),
    },
  };
  return VerifiedLearningEventSchema.parse(signed);
}

export function eventSigningBytes(event: UnsignedLearningEvent & {
  signature: { algorithm: 'Ed25519'; keyId: string; value: string };
}): Buffer {
  const { signature, ...unsigned } = event;
  return Buffer.from(canonicalJson({ ...unsigned, signature: { algorithm: signature.algorithm, keyId: signature.keyId } }), 'utf8');
}

function keyObject(value: KeyObject | string | Uint8Array): KeyObject {
  if (value instanceof KeyObject) return value;
  if (typeof value === 'string') return createPrivateKey(value);
  return createPrivateKey({ key: Buffer.from(value), format: 'der', type: 'pkcs8' });
}

export function hashEvent(event: VerifiedLearningEvent): string { return sha256(canonicalJson(event)); }

export function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }

export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (isUnknownArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
}
