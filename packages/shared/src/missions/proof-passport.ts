import {
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign as signBytes,
  verify as verifyBytes,
} from 'node:crypto';
import { z } from 'zod';
import { EVIDENCE_KINDS, MISSION_ID_RE } from './schema.ts';

const SHA256_HEX = /^[a-f0-9]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const PUBLIC_KEY_PEM = /^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END PUBLIC KEY-----\r?\n?$/;

export const PROOF_PASSPORT_SCHEMA_VERSION = 1 as const;

/**
 * Public, workspace-scoped identity for a Proof Passport issuer. The
 * fingerprint is SHA-256 over the canonical DER/SPKI bytes represented by
 * `publicKeySpki`; private signing material is intentionally absent.
 */
export const ProofPassportTrustAnchorSchema = z.object({
  schemaVersion: z.literal(1),
  workspaceId: z.string().min(1),
  algorithm: z.literal('Ed25519'),
  publicKeySpki: z.string().regex(BASE64URL),
  publicKeyPem: z.string().regex(PUBLIC_KEY_PEM),
  fingerprintSha256: z.string().regex(SHA256_HEX),
}).strict();

export const ResolvedMissionEvidenceSchema = z.object({
  workItemId: z.string().regex(MISSION_ID_RE),
  requirementId: z.string().regex(MISSION_ID_RE),
  kind: z.enum(EVIDENCE_KINDS),
  /** Redacted, portable locator. Raw host paths and artifact contents are excluded. */
  uri: z.string().min(1),
  sha256: z.string().regex(SHA256_HEX),
  sizeBytes: z.number().int().nonnegative(),
  observedAt: z.string().datetime(),
  provenance: z.enum(['workspace-file', 'connector-receipt', 'execution-proof']),
}).strict();

export const ProofPassportCriterionSchema = z.object({
  workItemId: z.string().regex(MISSION_ID_RE),
  criterionId: z.string().regex(MISSION_ID_RE),
  descriptionSha256: z.string().regex(SHA256_HEX),
  evidenceRequirementIds: z.array(z.string().regex(MISSION_ID_RE)),
}).strict();

export const UnsignedProofPassportSchema = z.object({
  schemaVersion: z.literal(PROOF_PASSPORT_SCHEMA_VERSION),
  passportId: z.string().min(1),
  missionId: z.string().regex(MISSION_ID_RE),
  workspaceId: z.string().min(1),
  outcome: z.literal('pass'),
  completedAt: z.string().datetime(),
  issuedAt: z.string().datetime(),
  missionObjectiveSha256: z.string().regex(SHA256_HEX),
  missionJournalSha256: z.string().regex(SHA256_HEX),
  missionRevision: z.number().int().positive(),
  criteria: z.array(ProofPassportCriterionSchema),
  evidence: z.array(ResolvedMissionEvidenceSchema),
  privacy: z.object({
    redacted: z.literal(true),
    excluded: z.array(z.enum([
      'artifact-content',
      'absolute-paths',
      'credentials',
      'model-messages',
      'provider-responses',
    ])).min(1),
  }).strict(),
}).strict();

export const SignedProofPassportSchema = UnsignedProofPassportSchema.extend({
  signature: z.object({
    algorithm: z.literal('Ed25519'),
    publicKeySpki: z.string().regex(BASE64URL),
    value: z.string().regex(BASE64URL),
  }).strict(),
}).strict();

export type ResolvedMissionEvidence = z.infer<typeof ResolvedMissionEvidenceSchema>;
export type UnsignedProofPassport = z.infer<typeof UnsignedProofPassportSchema>;
export type SignedProofPassport = z.infer<typeof SignedProofPassportSchema>;
export type ProofPassportTrustAnchor = z.infer<typeof ProofPassportTrustAnchorSchema>;

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

export function canonicalProofPassportBytes(value: UnsignedProofPassport): Buffer {
  const parsed = UnsignedProofPassportSchema.parse(value);
  return Buffer.from(canonicalize(parsed), 'utf8');
}

function privateKeyFrom(value: KeyObject | string | Uint8Array): KeyObject {
  if (value instanceof KeyObject) return value;
  if (typeof value === 'string' && value.includes('BEGIN PRIVATE KEY')) return createPrivateKey(value);
  return createPrivateKey({ key: Buffer.from(value), format: 'der', type: 'pkcs8' });
}

/** Signs only the value-free passport envelope; artifact contents never cross this API. */
export function signProofPassport(
  value: UnsignedProofPassport,
  privateKeyValue: KeyObject | string | Uint8Array,
): SignedProofPassport {
  const unsigned = UnsignedProofPassportSchema.parse(value);
  const privateKey = privateKeyFrom(privateKeyValue);
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Proof Passport signing key must be Ed25519');
  }
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const signature = signBytes(null, canonicalProofPassportBytes(unsigned), privateKey);
  return SignedProofPassportSchema.parse({
    ...unsigned,
    signature: {
      algorithm: 'Ed25519',
      publicKeySpki: Buffer.from(publicKey).toString('base64url'),
      value: signature.toString('base64url'),
    },
  });
}

export type ProofPassportVerification =
  | { valid: true; passport: SignedProofPassport }
  | { valid: false; reason: string };

/**
 * Verifies a passport without Robb, network access, or a secret key. Supplying
 * the trusted issuer SPKI additionally authenticates who signed the envelope;
 * without it, the result proves integrity only because the public key is
 * carried by the passport itself.
 */
export function verifyProofPassport(
  value: unknown,
  trustedPublicKeySpki?: string,
): ProofPassportVerification {
  const parsed = SignedProofPassportSchema.safeParse(value);
  if (!parsed.success) return { valid: false, reason: 'Proof Passport shape is invalid' };
  const { signature, ...unsigned } = parsed.data;
  if (trustedPublicKeySpki !== undefined && signature.publicKeySpki !== trustedPublicKeySpki) {
    return { valid: false, reason: 'Proof Passport signer does not match the trusted issuer key' };
  }
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(signature.publicKeySpki, 'base64url'),
      format: 'der',
      type: 'spki',
    });
    const valid = verifyBytes(
      null,
      canonicalProofPassportBytes(unsigned),
      publicKey,
      Buffer.from(signature.value, 'base64url'),
    );
    return valid
      ? { valid: true, passport: parsed.data }
      : { valid: false, reason: 'Proof Passport signature is invalid' };
  } catch {
    return { valid: false, reason: 'Proof Passport public key is invalid' };
  }
}
