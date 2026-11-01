import { describe, expect, it } from 'bun:test';
import { assertDirectoryIdentityPair } from './shared.ts';

describe('physical directory identity', () => {
  const original = { dev: 1n, ino: 42n, birthtimeNs: 100n };

  it('accepts the captured directory without relying on mutable modification times', () => {
    expect(() => assertDirectoryIdentityPair('/qa', 'Directory', original, '1', '42', '100'))
      .not.toThrow();
  });

  it('rejects a replacement that reuses the same device and inode', () => {
    const replacement = { ...original, birthtimeNs: 101n };
    expect(() => assertDirectoryIdentityPair('/qa', 'Directory', replacement, '1', '42', '100'))
      .toThrow('Directory was replaced');
  });

  it('still rejects a missing directory', () => {
    expect(() => assertDirectoryIdentityPair('/qa', 'Directory', undefined, '1', '42', '100'))
      .toThrow('Directory was replaced');
  });

  it('still rejects a different device or inode', () => {
    for (const replacement of [{ ...original, dev: 2n }, { ...original, ino: 43n }]) {
      expect(() => assertDirectoryIdentityPair('/qa', 'Directory', replacement, '1', '42', '100'))
        .toThrow('Directory was replaced');
    }
  });

  it('keeps legacy identities readable without inventing a creation time', () => {
    expect(() => assertDirectoryIdentityPair('/qa', 'Directory', original, '1', '42'))
      .not.toThrow();
  });
});
