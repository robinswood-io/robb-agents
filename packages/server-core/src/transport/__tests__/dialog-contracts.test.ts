import { describe, expect, it } from 'bun:test';
import { ConfirmDialogSpecSchema, FileDialogSpecSchema, type FileDialogSpec } from '../capabilities.ts';

describe('native dialog capability contracts', () => {
  it('preserves confirmation text, buttons and button indices', () => {
    const input = { title: 'QA', message: 'Confirm?', detail: 'Ephemeral test',
      buttons: ['Cancel', 'Confirm'], defaultId: 1, cancelId: 0 };
    const parsed = ConfirmDialogSpecSchema.parse(input);
    expect(parsed).toEqual(input);
    expect(Object.hasOwn(parsed, 'type')).toBe(false);
  });

  it('preserves supported picker properties and extension filters', () => {
    const input = { title: 'QA files', defaultPath: '/qa', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Reports', extensions: ['md', 'pdf'] }] } satisfies FileDialogSpec;
    expect(FileDialogSpecSchema.parse(input)).toEqual(input);
    expect(FileDialogSpecSchema.parse({})).toEqual({});
  });

  for (const input of [null, [], {}, { title: 'QA', message: 'Confirm?', buttons: [1] },
    { title: 'QA', message: 'Confirm?', buttons: ['OK'], defaultId: '1' },
    { title: 'QA', message: 'Confirm?', buttons: ['OK'], unexpected: true }]) {
    it(`rejects malformed confirmation input: ${JSON.stringify(input)}`, () => {
      expect(() => ConfirmDialogSpecSchema.parse(input)).toThrow();
    });
  }

  for (const input of [null, [], { properties: ['unsupported-property'] },
    { filters: [{ name: 'Reports', extensions: [1] }] }, { defaultPath: 42 }, { unexpected: true }]) {
    it(`rejects malformed picker input: ${JSON.stringify(input)}`, () => {
      expect(() => FileDialogSpecSchema.parse(input)).toThrow();
    });
  }
});
