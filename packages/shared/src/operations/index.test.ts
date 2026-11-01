import { afterEach, describe, expect, it } from 'bun:test';
import {
  clearRobbOperationsExtension,
  getRobbOperationsExtension,
  registerRobbOperationsExtension,
  type RobbOperationsExtension,
} from './index.ts';

function extension(id = 'operations-test'): RobbOperationsExtension {
  return {
    apiVersion: 1,
    id,
    edition: 'commercial',
    beforeTurn: () => ({ decision: 'allow' }),
    beforeTool: () => ({ decision: 'allow' }),
    onRuntimeEvent: () => undefined,
  };
}

afterEach(async () => clearRobbOperationsExtension());

describe('Robb Operations extension registry', () => {
  it('registers one valid commercial extension', () => {
    const candidate = extension();
    registerRobbOperationsExtension(candidate);
    expect(getRobbOperationsExtension()).toBe(candidate);
  });

  it('fails closed on replacement', () => {
    registerRobbOperationsExtension(extension('first'));
    expect(() => registerRobbOperationsExtension(extension('second')))
      .toThrow('already registered');
  });
});
