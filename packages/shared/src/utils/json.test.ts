import { describe, expect, it } from 'bun:test';
import { omitUndefined, setOptional } from './json.ts';

it('keeps optional fields bound to their discriminated variant', () => {
  type ProviderRequest =
    | { kind: 'google'; service?: 'gmail' }
    | { kind: 'microsoft'; service?: 'outlook' };
  const request: ProviderRequest = omitUndefined<ProviderRequest>({ kind: 'google', service: undefined });
  expect(request.kind).toBe('google');
  expect(Object.hasOwn(request, 'service')).toBe(false);
  const specified: ProviderRequest = omitUndefined<ProviderRequest>({ kind: 'microsoft', service: 'outlook' });
  if (specified.kind === 'microsoft') {
    const service: 'outlook' | undefined = specified.service;
    expect(service).toBe('outlook');
  }
});

describe('plain snapshot omission', () => {
  it('preserves enumerable processing markers while removing cleared symbol keys', () => {
    const revision = Symbol('revision');
    const cleared = Symbol('cleared');
    const original = { status: 'idle', [revision]: 7, [cleared]: undefined };
    const result = omitUndefined(original);
    expect(result[revision]).toBe(7);
    expect(Object.hasOwn(result, cleared)).toBe(false);
    expect(Object.hasOwn(original, cleared)).toBe(true);
    expect(JSON.stringify(result)).toBe('{"status":"idle"}');
  });

  it('clears an overridden old field without retaining stale metadata', () => {
    const previous = { status: 'active', error: 'old failure' };
    const next = { ...previous, error: undefined, retry: 0, enabled: false, label: '', explicit: null };
    expect(omitUndefined(next)).toEqual({ status: 'active', retry: 0, enabled: false, label: '', explicit: null });
    expect(Object.hasOwn(next, 'error')).toBe(true);
    expect(previous.error).toBe('old failure');
  });

  it('reads getters once and preserves own keys that shadow Object properties', () => {
    let reads = 0;
    const snapshot = omitUndefined({
      get value() { reads += 1; return 'observed'; },
      ['__proto__']: 'plain data',
      absent: undefined,
    });
    expect(reads).toBe(1);
    expect(snapshot.value).toBe('observed');
    expect(Object.getOwnPropertyDescriptor(snapshot, '__proto__')?.value as unknown).toBe('plain data');
    expect(Object.hasOwn(snapshot, 'absent')).toBe(false);
  });
});

it('replaces optional fields and clears their own key without losing falsy values', () => {
  const snapshot: { label?: string; count?: number; enabled?: boolean } = { label: 'old' }
  setOptional(snapshot, 'label', undefined)
  expect(Object.hasOwn(snapshot, 'label')).toBe(false)
  setOptional(snapshot, 'count', 0)
  setOptional(snapshot, 'enabled', false)
  setOptional(snapshot, 'label', '')
  expect(snapshot).toEqual({ count: 0, enabled: false, label: '' })
})
