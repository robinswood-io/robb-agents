import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalOperationValue } from './capability-broker.ts';

const SHA256_HEX = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const EgressFieldRuleSchema = z.object({
  path: z.string().min(1),
  classification: z.enum(['public', 'business-sensitive', 'pii', 'secret']),
  action: z.enum(['allow', 'drop', 'pseudonymize', 'block']),
}).strict();

export const StructuredEgressPolicySchema = z.object({
  schemaVersion: z.literal(1),
  policyId: z.string().min(1),
  allowedOrigins: z.array(z.string().url()).min(1),
  purpose: z.string().min(1),
  unmatchedAction: z.enum(['allow', 'drop', 'block']).default('block'),
  piiAction: z.enum(['drop', 'pseudonymize', 'block']).default('pseudonymize'),
  rules: z.array(EgressFieldRuleSchema).default([]),
}).strict();

const EgressReceiptFieldSchema = z.object({
  path: z.string().min(1),
  classification: z.enum(['public', 'business-sensitive', 'pii', 'secret', 'unclassified']),
  action: z.enum(['allow', 'drop', 'pseudonymize']),
  sourceFingerprint: z.string().regex(SHA256_HEX),
  transmittedFingerprint: z.string().regex(SHA256_HEX).optional(),
}).strict();

const UnsignedPrivacyReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  receiptId: z.string().min(1),
  policyId: z.string().min(1),
  workspaceId: z.string().min(1),
  missionId: z.string().min(1),
  connectorId: z.string().min(1),
  operationId: z.string().min(1),
  destinationOrigin: z.string().url(),
  purpose: z.string().min(1),
  boundaryEvent: z.literal('released-to-transport'),
  releasedAt: z.string().datetime(),
  sourcePayloadHash: z.string().regex(SHA256_HEX),
  transmittedPayloadHash: z.string().regex(SHA256_HEX),
  fields: z.array(EgressReceiptFieldSchema),
}).strict();

export const PrivacyReceiptSchema = UnsignedPrivacyReceiptSchema.extend({
  token: z.string().regex(TOKEN),
}).strict();

export type StructuredEgressPolicy = z.infer<typeof StructuredEgressPolicySchema>;
export type PrivacyReceipt = z.infer<typeof PrivacyReceiptSchema>;

interface FieldDecision {
  path: string;
  classification: 'public' | 'business-sensitive' | 'pii' | 'secret' | 'unclassified';
  action: 'allow' | 'drop' | 'pseudonymize';
  sourceFingerprint: string;
  transmittedFingerprint?: string;
}

export interface EgressVaultEntry {
  path: string;
  pseudonym: string;
  /** Host-only. Persist in the encrypted tenant vault, never telemetry. */
  originalValue: string;
}

export interface PreparedStructuredEgress {
  payload: Record<string, unknown>;
  sourcePayloadHash: string;
  transmittedPayloadHash: string;
  fields: FieldDecision[];
  vaultEntries: EgressVaultEntry[];
  policy: StructuredEgressPolicy;
  destinationOrigin: string;
}

export class StructuredEgressDeniedError extends Error {
  constructor(
    readonly code: 'ORIGIN_DENIED' | 'SECRET_DETECTED' | 'FIELD_BLOCKED' | 'OPAQUE_PAYLOAD',
    readonly paths: string[],
    message: string,
  ) {
    super(message);
    this.name = 'StructuredEgressDeniedError';
  }
}

const SECRET_KEY = /(?:^|[_-])(password|passwd|secret|token|api[_-]?key|private[_-]?key|authorization|cookie|credential)(?:$|[_-])/i;
const SECRET_VALUE = /(?:\bsk-[A-Za-z0-9_-]{16,}|\bgh[opsu]_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const FR_PHONE = /(?:\+33|0)[1-9](?:[ .-]?\d{2}){4}\b/;
const FR_IBAN = /\bFR\d{2}[A-Z0-9]{23}\b/i;
const FR_NIR = /\b[12][ ]?\d{2}[ ]?(?:0[1-9]|1[0-2]|[2-9]\d)[ ]?\d{2}[ ]?\d{3}[ ]?\d{3}[ ]?\d{2}\b/;
const IP_ADDRESS = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/;
const PII_KEY = /^(?:firstName|lastName|fullName|email|phone|mobile|postalAddress|nom|prenom|courriel|telephone)$/i;

function pathMatches(pattern: string, path: string): boolean {
  const wanted = pattern.split('.');
  const actual = path.split('.');
  return wanted.length === actual.length
    && wanted.every((part, index) => part === '*' || part === actual[index]);
}

function automaticClassification(path: string, value: unknown): 'secret' | 'pii' | null {
  const key = path.split('.').at(-1) ?? '';
  if (SECRET_KEY.test(key)) return 'secret';
  if (PII_KEY.test(key)) return 'pii';
  if (typeof value !== 'string') return null;
  if (SECRET_VALUE.test(value)) return 'secret';
  if (EMAIL.test(value) || FR_PHONE.test(value) ||
      FR_IBAN.test(value.replaceAll(' ', '')) || FR_NIR.test(value) || IP_ADDRESS.test(value)) return 'pii';
  return null;
}

const OMIT = Symbol('omit');

/** Policy-first structured egress boundary. Opaque byte/string payloads are deliberately unsupported. */
export class StructuredEgressFirewall {
  private readonly key: Buffer;
  private readonly now: () => string;
  private readonly generateId: () => string;

  constructor(input: { signingKey: string | Uint8Array; now?: () => string; generateId?: () => string }) {
    this.key = Buffer.from(input.signingKey);
    if (this.key.byteLength < 32) throw new Error('Structured egress signing key must contain at least 32 bytes');
    this.now = input.now ?? (() => new Date().toISOString());
    this.generateId = input.generateId ?? randomUUID;
  }

  prepare(input: {
    payload: Record<string, unknown>;
    destinationOrigin: string;
    policy: StructuredEgressPolicy;
  }): PreparedStructuredEgress {
    if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
      throw new StructuredEgressDeniedError('OPAQUE_PAYLOAD', [], 'Only structured object payloads may cross this egress boundary');
    }
    const policy = StructuredEgressPolicySchema.parse(input.policy);
    const destination = new URL(input.destinationOrigin).origin;
    if (!policy.allowedOrigins.map((value) => new URL(value).origin).includes(destination)) {
      throw new StructuredEgressDeniedError('ORIGIN_DENIED', [], `Destination origin is not allowed by ${policy.policyId}`);
    }
    const fields: FieldDecision[] = [];
    const vaultEntries: EgressVaultEntry[] = [];
    const blocked: Array<{ path: string; secret: boolean }> = [];
    const ancestors = new WeakSet<object>();
    let fieldCount = 0;

    const visit = (value: unknown, path: string, depth = 0): unknown | typeof OMIT => {
      if (depth > 32 || fieldCount > 10_000) {
        throw new StructuredEgressDeniedError('OPAQUE_PAYLOAD', [path], 'Structured payload exceeds safety bounds');
      }
      if (Array.isArray(value)) {
        if (ancestors.has(value)) throw new StructuredEgressDeniedError('OPAQUE_PAYLOAD', [path], 'Cyclic payloads are forbidden');
        ancestors.add(value);
        const output = value.map((child, index) => visit(child, `${path}.${index}`, depth + 1)).filter((child) => child !== OMIT);
        ancestors.delete(value);
        return output;
      }
      if (value && typeof value === 'object') {
        if (Object.getPrototypeOf(value) !== Object.prototype || ancestors.has(value)) {
          throw new StructuredEgressDeniedError('OPAQUE_PAYLOAD', [path], 'Only acyclic JSON objects may cross this egress boundary');
        }
        ancestors.add(value);
        const output: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          fieldCount += 1;
          const childPath = path ? `${path}.${key}` : key;
          const transformed = visit(child, childPath, depth + 1);
          if (transformed !== OMIT) output[key] = transformed;
        }
        ancestors.delete(value);
        return output;
      }
      if (
        value !== null
        && typeof value !== 'string'
        && typeof value !== 'boolean'
        && !(typeof value === 'number' && Number.isFinite(value))
      ) {
        throw new StructuredEgressDeniedError('OPAQUE_PAYLOAD', [path], 'Only JSON scalar values may cross this egress boundary');
      }
      const automatic = automaticClassification(path, value);
      const rule = policy.rules.find((candidate) => pathMatches(candidate.path, path));
      const classification = automatic ?? rule?.classification ?? 'unclassified';
      let action: 'allow' | 'drop' | 'pseudonymize' | 'block';
      if (automatic === 'secret') action = 'block';
      else if (automatic === 'pii') action = policy.piiAction;
      else action = rule?.action ?? policy.unmatchedAction;
      if (action === 'block') {
        blocked.push({ path, secret: classification === 'secret' });
        return OMIT;
      }
      const sourceFingerprint = this.fingerprint(value);
      if (action === 'drop') {
        fields.push({ path, classification, action, sourceFingerprint });
        return OMIT;
      }
      let transmitted = value;
      if (action === 'pseudonymize') {
        const originalValue = String(value ?? '');
        const pseudonym = `psn_${this.fingerprint(originalValue).slice(0, 24)}`;
        transmitted = pseudonym;
        vaultEntries.push({ path, pseudonym, originalValue });
      }
      fields.push({
        path,
        classification,
        action,
        sourceFingerprint,
        transmittedFingerprint: this.fingerprint(transmitted),
      });
      return transmitted;
    };

    const payload = visit(input.payload, '') as Record<string, unknown>;
    if (blocked.length > 0) {
      const secret = blocked.some((field) => field.secret);
      throw new StructuredEgressDeniedError(
        secret ? 'SECRET_DETECTED' : 'FIELD_BLOCKED',
        blocked.map(({ path }) => path),
        secret ? 'A secret canary was detected in the structured payload' : 'One or more egress fields are blocked by policy',
      );
    }
    return {
      payload,
      sourcePayloadHash: this.fingerprint(input.payload),
      transmittedPayloadHash: this.fingerprint(payload),
      fields,
      vaultEntries,
      policy,
      destinationOrigin: destination,
    };
  }

  issueReceipt(input: {
    prepared: PreparedStructuredEgress;
    workspaceId: string;
    missionId: string;
    connectorId: string;
    operationId: string;
  }): PrivacyReceipt {
    const unsigned = UnsignedPrivacyReceiptSchema.parse({
      schemaVersion: 1,
      receiptId: this.generateId(),
      policyId: input.prepared.policy.policyId,
      workspaceId: input.workspaceId,
      missionId: input.missionId,
      connectorId: input.connectorId,
      operationId: input.operationId,
      destinationOrigin: input.prepared.destinationOrigin,
      purpose: input.prepared.policy.purpose,
      boundaryEvent: 'released-to-transport',
      releasedAt: this.now(),
      sourcePayloadHash: input.prepared.sourcePayloadHash,
      transmittedPayloadHash: input.prepared.transmittedPayloadHash,
      fields: input.prepared.fields,
    });
    return PrivacyReceiptSchema.parse({ ...unsigned, token: this.sign(unsigned) });
  }

  verifyReceipt(value: unknown): boolean {
    const parsed = PrivacyReceiptSchema.safeParse(value);
    if (!parsed.success) return false;
    const { token, ...unsigned } = parsed.data;
    const actual = Buffer.from(token, 'base64url');
    const expected = Buffer.from(this.sign(unsigned), 'base64url');
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
  }

  private fingerprint(value: unknown): string {
    return createHmac('sha256', this.key).update(canonicalOperationValue(value), 'utf8').digest('hex');
  }

  private sign(value: z.infer<typeof UnsignedPrivacyReceiptSchema>): string {
    return createHmac('sha256', this.key).update(canonicalOperationValue(value), 'utf8').digest('base64url');
  }
}
