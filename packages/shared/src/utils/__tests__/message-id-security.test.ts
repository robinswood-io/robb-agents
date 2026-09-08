import { describe, expect, it, spyOn } from 'bun:test';
import { generateMessageId } from '@craft-agent/core';

describe('message ID secure randomness (CodeQL #70)', () => {
  it('keeps IDs distinct even with a frozen clock and predictable Math.random', () => {
    const clock = spyOn(Date, 'now').mockReturnValue(1788860000000);
    const random = spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const ids = Array.from({ length: 256 }, () => generateMessageId());
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every((id) => /^msg-1788860000000-[0-9a-f]{32}$/.test(id))).toBe(true);
      expect(random).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
      clock.mockRestore();
    }
  });

  it('does not use Math.random for identifiers reaching permission checks', () => {
    const random = spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('insecure randomness must not be used');
    });
    try {
      expect(() => generateMessageId()).not.toThrow();
    } finally {
      random.mockRestore();
    }
  });

  it('fails closed when the cryptographic random source fails', () => {
    const secureRandom = spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(() => {
      throw new Error('secure randomness unavailable');
    });
    const random = spyOn(Math, 'random');
    try {
      expect(() => generateMessageId()).toThrow('secure randomness unavailable');
      expect(random).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
      secureRandom.mockRestore();
    }
  });
});
