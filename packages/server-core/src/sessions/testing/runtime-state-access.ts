import type { SessionRuntimeState } from '../SessionManager/runtime-state.ts';

type MutableSessionRuntimeState = {
  -readonly [Key in keyof SessionRuntimeState]: SessionRuntimeState[Key];
};

/** Private data of a manager or an explicitly constructed prototype fixture. */
export function sessionRuntimeStateForTest(owner: object): MutableSessionRuntimeState {
  const state: unknown = Reflect.get(owner, 'runtimeState');
  if (!state || typeof state !== 'object') throw new Error('Missing session runtime state in fixture');
  return state as MutableSessionRuntimeState;
}

export function requiredTestValue<Value>(value: Value | null | undefined): Value {
  if (value === null || value === undefined) throw new Error('Expected an existing fixture value');
  return value;
}
