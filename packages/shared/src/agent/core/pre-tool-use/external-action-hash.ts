import { createHash } from "node:crypto";

function canonicalExternalActionInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalExternalActionInput);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key, entry]) => entry !== undefined && key !== '_intent' && key !== '_displayName')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalExternalActionInput(entry)]));
}

/** Bind a sensitive approval to the exact tool and payload without persisting payload text. */
export function hashSensitiveExternalActionOperation(
  toolName: string,
  input: Record<string, unknown>,
): string {
  return createHash('sha256')
    .update(JSON.stringify([toolName, canonicalExternalActionInput(input)]), 'utf8')
    .digest('hex');
}
