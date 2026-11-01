/** Checks only the object envelope; callers validate their domain fields. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse an object envelope without letting JSON.parse propagate an unchecked type. */
export function parseJsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isJsonObject(value)) throw new TypeError('Expected a JSON object');
  return value;
}

/** Array.isArray otherwise loses the element type at an untrusted boundary. */
export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

type DefinedRecord<T extends object> = T extends unknown ? {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
} : never;

export type SnapshotInput<T extends object> = {
  [K in keyof T]: T[K] | ({} extends Pick<T, K> ? undefined : never);
};

/** Build a plain snapshot with the same omission semantics as JSON serialization. */
export function omitUndefined<T extends object>(value: SnapshotInput<T>): DefinedRecord<T> {
  const result: Record<PropertyKey, unknown> = { ...value };
  for (const key of Reflect.ownKeys(result)) {
    const entry: unknown = Reflect.get(result, key);
    if (entry === undefined) Reflect.deleteProperty(result, key);
  }
  return result as DefinedRecord<T>;
}

/** Replace an optional snapshot field, removing a cleared value before persistence. */
type OptionalKey<T extends object> = {
  [K in keyof T]-?: {} extends Pick<T, K> ? K : never
}[keyof T]

export function setOptional<T extends object, K extends OptionalKey<T>>(
  target: T,
  key: K,
  value: T[K],
): void {
  if (value === undefined) delete target[key]
  else target[key] = value
}
