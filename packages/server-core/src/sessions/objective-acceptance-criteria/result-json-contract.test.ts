import { expect, it } from 'bun:test';
import { resultJson } from './result-projection.ts';

it.each([{ value: null }, { value: 1 }, { value: true }, { value: [] }, { value: {} }])('rejects a non-string MCP text payload as evidence: %j', ({ value }) => {
  expect(resultJson(JSON.stringify({ content: [{ type: 'text', text: value }] }))).toBeUndefined();
});

it('preserves direct business values and unwraps one valid MCP JSON text block', () => {
  expect(resultJson('[1,2]')).toEqual([1, 2]);
  expect(resultJson('true')).toBe(true);
  expect(resultJson(JSON.stringify({ content: [{ type: 'text', text: '{"success":true}' }] })))
    .toEqual({ success: true });
});

it('does not extract business JSON from prose or ambiguous MCP blocks', () => {
  expect(resultJson('Before {"success":true} after')).toBeUndefined();
  const ambiguous = { content: [
    { type: 'text', text: '{"success":false}' },
    { type: 'text', text: '{"success":true}' },
  ] };
  expect(resultJson(JSON.stringify(ambiguous))).toEqual(ambiguous);
});
