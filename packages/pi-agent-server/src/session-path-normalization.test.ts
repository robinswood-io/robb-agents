import { describe, expect, test } from 'bun:test';
import { normalizeSessionPathTokens } from './session-path-normalization.ts';

describe('normalizeSessionPathTokens', () => {
  const sessionPath = '/Users/test/.craft-agent/workspaces/w/sessions/s';

  test('expands direct and dot-prefixed placeholders recursively', () => {
    expect(normalizeSessionPathTokens({
      path: '.{{SESSION_PATH}}/long_responses/result.txt',
      inputFiles: ['{{SESSION_PATH}}/long_responses/data.json'],
    }, sessionPath)).toEqual({
      path: `${sessionPath}/long_responses/result.txt`,
      inputFiles: [`${sessionPath}/long_responses/data.json`],
    });
  });

  test('repairs the legacy ./Users absolute-path form', () => {
    expect(normalizeSessionPathTokens('./Users/test/result.txt', sessionPath))
      .toBe('/Users/test/result.txt');
  });
});
