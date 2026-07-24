import {
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { z } from 'zod';
import type {
  RemoteAction,
  RemoteTaskProjection,
} from './remote-supervision.ts';

const DEFAULT_ENVELOPE_TTL_MS = 60_000;
const DEFAULT_CLOCK_SKEW_MS = 30_000;
const MAX_ENVELOPE_TTL_MS = 5 * 60_000;
const MIN_SHARED_SECRET_BYTES = 32;

const SignedEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  keyId: z.string().trim().min(1),
  requestId: z.string().uuid(),
  nonce: z.string().uuid(),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  payload: z.unknown(),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
});

export interface RemoteSupervisionSignedEnvelope<T> {
  schemaVersion: 1;
  keyId: string;
  requestId: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  payload: T;
  signature: string;
}

export interface RemoteProjectionRequest {
  workspaceId: string;
  snapshot: RemoteTaskProjection;
}

export interface RemoteProjectionResponse {
  requestId: string;
  projection: RemoteTaskProjection | null;
}

export interface RemoteActionRequest {
  workspaceId: string;
  action: RemoteAction;
  targetId?: string;
}

export interface RemoteActionResponse {
  requestId: string;
  action: RemoteAction;
  accepted: true;
  executedAt: string;
}

export interface SignedEnvelopeOptions {
  requestId?: string;
  nonce?: string;
  issuedAt?: string;
  ttlMs?: number;
}

export type RemoteSecretResolver = (keyId: string) => string | null;

export class RemoteEnvelopeAuthenticationError extends Error {
  readonly code = 'REMOTE_ENVELOPE_AUTHENTICATION_FAILED';

  constructor(message = 'Remote supervision envelope authentication failed') {
    super(message);
    this.name = 'RemoteEnvelopeAuthenticationError';
  }
}

export class RemoteEnvelopeReplayError extends Error {
  readonly code = 'REMOTE_ENVELOPE_REPLAY';

  constructor() {
    super('Remote supervision envelope nonce has already been used');
    this.name = 'RemoteEnvelopeReplayError';
  }
}

export function createSignedRemoteEnvelope<T>(
  keyId: string,
  sharedSecret: string,
  payload: T,
  options: SignedEnvelopeOptions = {},
): RemoteSupervisionSignedEnvelope<T> {
  validateSharedSecret(sharedSecret);
  const issuedAt = options.issuedAt ?? new Date().toISOString();
  const ttlMs = options.ttlMs ?? DEFAULT_ENVELOPE_TTL_MS;
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_ENVELOPE_TTL_MS) {
    throw new Error(`Remote supervision envelope TTL must be between 1 and ${MAX_ENVELOPE_TTL_MS} ms`);
  }
  const unsigned = {
    schemaVersion: 1 as const,
    keyId: keyId.trim(),
    requestId: options.requestId ?? randomUUID(),
    nonce: options.nonce ?? randomUUID(),
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + ttlMs).toISOString(),
    payload,
  };
  if (!unsigned.keyId || !Number.isFinite(Date.parse(issuedAt))) {
    throw new Error('Remote supervision envelope metadata is invalid');
  }
  return {
    ...unsigned,
    signature: signUnsignedEnvelope(unsigned, sharedSecret),
  };
}

export class RemoteEnvelopeVerifier {
  private readonly seenNonces = new Map<string, number>();

  constructor(
    private readonly resolveSecret: RemoteSecretResolver,
    private readonly options: {
      now?: () => Date;
      maxClockSkewMs?: number;
    } = {},
  ) {}

  verify<T = unknown>(value: unknown): RemoteSupervisionSignedEnvelope<T> {
    const parsed = SignedEnvelopeSchema.parse(value);
    const envelope = parsed as RemoteSupervisionSignedEnvelope<T>;
    const secret = this.resolveSecret(envelope.keyId);
    if (!secret) throw new RemoteEnvelopeAuthenticationError();
    validateSharedSecret(secret);

    const now = (this.options.now ?? (() => new Date()))().getTime();
    const issuedAt = Date.parse(envelope.issuedAt);
    const expiresAt = Date.parse(envelope.expiresAt);
    const maxClockSkewMs = this.options.maxClockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
    if (
      issuedAt > now + maxClockSkewMs
      || expiresAt <= now
      || expiresAt <= issuedAt
      || expiresAt - issuedAt > MAX_ENVELOPE_TTL_MS
    ) {
      throw new RemoteEnvelopeAuthenticationError('Remote supervision envelope is outside its validity window');
    }

    const { signature, ...unsigned } = envelope;
    const expected = Buffer.from(signUnsignedEnvelope(unsigned, secret), 'hex');
    const received = Buffer.from(signature, 'hex');
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw new RemoteEnvelopeAuthenticationError();
    }

    this.pruneSeenNonces(now);
    const nonceKey = `${envelope.keyId}:${envelope.nonce}`;
    if (this.seenNonces.has(nonceKey)) throw new RemoteEnvelopeReplayError();
    this.seenNonces.set(nonceKey, expiresAt);
    return envelope;
  }

  private pruneSeenNonces(now: number): void {
    for (const [nonce, expiresAt] of this.seenNonces) {
      if (expiresAt <= now) this.seenNonces.delete(nonce);
    }
  }
}

export interface RemoteSupervisionClientOptions {
  baseUrl: string;
  keyId: string;
  sharedSecret: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  now?: () => Date;
}

export class RemoteSupervisionClient {
  private readonly baseUrl: URL;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly responseVerifier: RemoteEnvelopeVerifier;

  constructor(private readonly options: RemoteSupervisionClientOptions) {
    this.baseUrl = validateRemoteBaseUrl(options.baseUrl);
    validateSharedSecret(options.sharedSecret);
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.responseVerifier = new RemoteEnvelopeVerifier(
      (keyId) => keyId === options.keyId ? options.sharedSecret : null,
      { now: options.now },
    );
  }

  async projectTask(request: RemoteProjectionRequest): Promise<RemoteProjectionResponse> {
    const response = await this.post('/v1/remote-supervision/project', request);
    return parseProjectionResponse(response);
  }

  async executeAction(request: RemoteActionRequest): Promise<RemoteActionResponse> {
    const response = await this.post('/v1/remote-supervision/action', request);
    return parseActionResponse(response);
  }

  private async post(pathname: string, payload: unknown): Promise<unknown> {
    const issuedAt = (this.options.now ?? (() => new Date()))().toISOString();
    const envelope = createSignedRemoteEnvelope(
      this.options.keyId,
      this.options.sharedSecret,
      payload,
      { issuedAt },
    );
    const response = await this.fetchImplementation(new URL(pathname, this.baseUrl), {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        'x-robb-remote-key-id': this.options.keyId,
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
    });
    if (!response.ok) {
      throw new Error(`Remote supervision request failed with HTTP ${response.status}`);
    }
    const body: unknown = await response.json();
    return this.responseVerifier.verify(body).payload;
  }
}

function signUnsignedEnvelope(
  unsigned: Omit<RemoteSupervisionSignedEnvelope<unknown>, 'signature'>,
  sharedSecret: string,
): string {
  return createHmac('sha256', sharedSecret)
    .update(canonicalJson(unsigned), 'utf8')
    .digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Remote supervision envelopes require finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error(`Remote supervision envelopes cannot encode ${typeof value}`);
}

function validateSharedSecret(secret: string): void {
  if (Buffer.byteLength(secret, 'utf8') < MIN_SHARED_SECRET_BYTES) {
    throw new Error(`Remote supervision shared secret must contain at least ${MIN_SHARED_SECRET_BYTES} bytes`);
  }
}

function validateRemoteBaseUrl(value: string): URL {
  const url = new URL(value);
  const loopback = url.hostname === '127.0.0.1'
    || url.hostname === 'localhost'
    || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Remote supervision requires HTTPS except for loopback test servers');
  }
  url.pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseProjectionResponse(value: unknown): RemoteProjectionResponse {
  if (!isRecord(value) || typeof value.requestId !== 'string') {
    throw new Error('Remote projection response is invalid');
  }
  if (value.projection !== null && !isRecord(value.projection)) {
    throw new Error('Remote projection response is invalid');
  }
  return {
    requestId: value.requestId,
    projection: value.projection as RemoteTaskProjection | null,
  };
}

function parseActionResponse(value: unknown): RemoteActionResponse {
  if (
    !isRecord(value)
    || typeof value.requestId !== 'string'
    || value.accepted !== true
    || (value.action !== 'task.pause' && value.action !== 'task.cancel' && value.action !== 'approval.resolve')
    || typeof value.executedAt !== 'string'
    || !Number.isFinite(Date.parse(value.executedAt))
  ) {
    throw new Error('Remote action response is invalid');
  }
  return {
    requestId: value.requestId,
    action: value.action,
    accepted: true,
    executedAt: value.executedAt,
  };
}
