import { describe, expect, it } from 'bun:test';
import { parsePreferences } from '../preferences-form-data.ts';

describe('preferences form input', () => {
  it('preserves valid strings without putting unrelated metadata into form fields', () => {
    expect(parsePreferences(JSON.stringify({ name: 'QA', timezone: 'Europe/Paris',
      location: { city: 'Amiens', country: 'France' }, notes: 'Line one\nLine two', extra: false })))
      .toEqual({ name: 'QA', timezone: 'Europe/Paris', city: 'Amiens', country: 'France', notes: 'Line one\nLine two' });
  });

  it('keeps valid fields and rejects non-string values from malformed saved preferences', () => {
    expect(parsePreferences(JSON.stringify({ name: false, timezone: 42,
      location: { city: {}, country: 'France' }, notes: ['invalid'] })))
      .toEqual({ name: '', timezone: '', city: '', country: 'France', notes: '' });
    for (const value of ['null', '[]', '1', 'malformed-json']) {
      expect(parsePreferences(value)).toEqual({ name: '', timezone: '', city: '', country: '', notes: '' });
    }
  });
});
