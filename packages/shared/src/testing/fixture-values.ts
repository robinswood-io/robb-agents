/** Fail explicitly when a fixture value required by an assertion is absent. */
export function requiredTestValue<Value>(value: Value | null | undefined): Value {
  if (value === null || value === undefined) throw new Error('Expected an existing fixture value');
  return value;
}
