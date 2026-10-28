import { describe, expect, it } from 'bun:test';
import { isBaileysModule } from '../worker-protocol';

describe('Baileys dynamic SDK contract', () => {
  it('accepts the installed SDK without opening a socket or loading credentials', async () => {
    expect(isBaileysModule(await import('@whiskeysockets/baileys'))).toBe(true);
  });
  it('rejects missing, malformed and non-callable exports', () => {
    for (const value of [null, {}, { makeWASocket: 42 }, { default: 'socket' }]) expect(isBaileysModule(value)).toBe(false);
  });
});
