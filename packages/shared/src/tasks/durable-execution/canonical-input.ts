
const MAX_ISOLATED_TOOL_INPUT_BYTES = 64 * 1024;

const MAX_ISOLATED_TOOL_INPUT_DEPTH = 12;

const MAX_ISOLATED_TOOL_INPUT_FIELDS = 512;

export const MAX_ISOLATED_READ_TOOL_INVOCATIONS = 16;

const INERT_TOOL_INPUT_KEYS = new Set(['_intent', '_displayName']);

const FORBIDDEN_TOOL_INPUT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function canonicalToolInputValue(
  value: unknown,
  depth: number,
  counter: { fields: number },
): unknown | undefined {
  if (depth > MAX_ISOLATED_TOOL_INPUT_DEPTH) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value) {
      const canonical = canonicalToolInputValue(item, depth + 1, counter);
      if (canonical === undefined) return undefined;
      result.push(canonical);
    }
    return result;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    return undefined;
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (depth === 0 && INERT_TOOL_INPUT_KEYS.has(key)) continue;
    if (!key || key.length > 128 || FORBIDDEN_TOOL_INPUT_KEYS.has(key)) return undefined;
    counter.fields += 1;
    if (counter.fields > MAX_ISOLATED_TOOL_INPUT_FIELDS) return undefined;
    const canonical = canonicalToolInputValue(
      Object.getOwnPropertyDescriptor(value, key)?.value,
      depth + 1,
      counter,
    );
    if (canonical === undefined) return undefined;
    result[key] = canonical;
  }
  return result;
}

/** Canonical, bounded JSON identity for one exact host-preflighted tool input. */
export function canonicalExecutionIsolationToolInput(
  input: Record<string, unknown>,
): string | undefined {
  const canonical = canonicalToolInputValue(input, 0, { fields: 0 });
  if (!canonical || typeof canonical !== 'object' || Array.isArray(canonical)) return undefined;
  const encoded = JSON.stringify(canonical);
  return Buffer.byteLength(encoded, 'utf8') <= MAX_ISOLATED_TOOL_INPUT_BYTES
    ? encoded
    : undefined;
}
