import { describe, expect, test } from 'bun:test';
import {
  RemoteEnvelopeAuthenticationError,
  RemoteEnvelopeReplayError,
  RemoteEnvelopeVerifier,
  RemoteSupervisionClient,
  createSignedRemoteEnvelope,
} from './signed-transport';

const keyId = 'remote-key-1';
const sharedSecret = 'remote-shared-secret-0123456789abcdef';
const issuedAt = '2026-07-24T10:00:00.000Z';
const now = () => new Date('2026-07-24T10:00:10.000Z');

describe('signed remote supervision transport', () => {
  test('signs and verifies an envelope with replay protection', () => {
    const verifier = new RemoteEnvelopeVerifier(
      (candidate) => candidate === keyId ? sharedSecret : null,
      { now },
    );
    const envelope = createSignedRemoteEnvelope(keyId, sharedSecret, { workspaceId: 'ws-1' }, {
      issuedAt,
      requestId: '11111111-1111-4111-8111-111111111111',
      nonce: '22222222-2222-4222-8222-222222222222',
    });

    expect(verifier.verify(envelope).payload).toEqual({ workspaceId: 'ws-1' });
    expect(() => verifier.verify(envelope)).toThrow(RemoteEnvelopeReplayError);
  });

  test('rejects tampered envelopes and expired validity windows', () => {
    const verifier = new RemoteEnvelopeVerifier(
      (candidate) => candidate === keyId ? sharedSecret : null,
      { now },
    );
    const envelope = createSignedRemoteEnvelope(keyId, sharedSecret, { workspaceId: 'ws-1' }, {
      issuedAt,
      requestId: '33333333-3333-4333-8333-333333333333',
      nonce: '44444444-4444-4444-8444-444444444444',
    });
    expect(() => verifier.verify({
      ...envelope,
      payload: { workspaceId: 'ws-2' },
    })).toThrow(RemoteEnvelopeAuthenticationError);

    const expired = createSignedRemoteEnvelope(keyId, sharedSecret, { workspaceId: 'ws-1' }, {
      issuedAt: '2026-07-24T09:00:00.000Z',
      requestId: '55555555-5555-4555-8555-555555555555',
      nonce: '66666666-6666-4666-8666-666666666666',
      ttlMs: 1_000,
    });
    expect(() => verifier.verify(expired)).toThrow(RemoteEnvelopeAuthenticationError);
  });

  test('requires strong shared secrets and HTTPS outside loopback', () => {
    expect(() => createSignedRemoteEnvelope(keyId, 'too-short', { ok: true }, { issuedAt }))
      .toThrow('at least 32 bytes');
    expect(() => new RemoteSupervisionClient({
      baseUrl: 'http://example.com',
      keyId,
      sharedSecret,
    })).toThrow('requires HTTPS');
    expect(() => new RemoteSupervisionClient({
      baseUrl: 'http://127.0.0.1:3100',
      keyId,
      sharedSecret,
    })).not.toThrow();
  });
});
