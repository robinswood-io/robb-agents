import { expect, it } from 'bun:test';
import { WsRpcClient } from '../client.ts';

it('clears the previous transport failure and backoff after a successful handshake', () => {
  const client = new WsRpcClient('ws://127.0.0.1:1', { autoReconnect: false });
  try {
    client.setConnectionState({
      status: 'reconnecting', attempt: 3, nextRetryInMs: 4000,
      lastError: { kind: 'unknown', message: 'Old failure', code: 'OLD_FAILURE' },
      lastClose: { code: 1006, reason: 'Old disconnect', wasClean: false },
    });
    expect(client.getConnectionState().lastError?.message).toBe('Old failure');
    client.onMessage(JSON.stringify({ id: 'handshake', type: 'handshake_ack', clientId: 'fresh-client' }));
    const connected = client.getConnectionState();
    expect(connected.status).toBe('connected');
    expect(connected.attempt).toBe(0);
    expect(connected.nextRetryInMs).toBeUndefined();
    expect(connected.lastError).toBeUndefined();
    expect(connected.lastClose).toBeUndefined();
    expect(Object.hasOwn(connected, 'lastError')).toBe(false);
  } finally {
    client.destroy();
  }
});
