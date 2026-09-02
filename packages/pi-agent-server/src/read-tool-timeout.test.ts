import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_READ_TOOL_TIMEOUT_MS,
  ReadToolTimeoutError,
  resolveReadToolTimeoutMs,
  withReadToolTimeout,
} from './read-tool-timeout.ts';

describe('read tool timeout', () => {
  it('bounds only the built-in Read tool', async () => {
    await expect(withReadToolTimeout('Read', new Promise(() => {}), 10))
      .rejects.toBeInstanceOf(ReadToolTimeoutError);
    await expect(withReadToolTimeout('Edit', Promise.resolve('ok'), 10)).resolves.toBe('ok');
  });

  it('preserves successful reads', async () => {
    await expect(withReadToolTimeout('Read', Promise.resolve('content'), 10))
      .resolves.toBe('content');
  });

  it('normalizes configuration to a safe range', () => {
    expect(resolveReadToolTimeoutMs(undefined)).toBe(DEFAULT_READ_TOOL_TIMEOUT_MS);
    expect(resolveReadToolTimeoutMs('100')).toBe(5_000);
    expect(resolveReadToolTimeoutMs('900000')).toBe(600_000);
  });
});
