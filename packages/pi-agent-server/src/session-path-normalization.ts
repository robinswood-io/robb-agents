import { isAbsolute } from 'node:path';

const SESSION_PATH_TOKEN = '{{SESSION_PATH}}';

function normalizePathString(value: string, sessionPath: string): string {
  const tokenized = value
    .replaceAll(`.${SESSION_PATH_TOKEN}`, sessionPath)
    .replaceAll(SESSION_PATH_TOKEN, sessionPath);

  // A previously malformed portable path could survive as ./Users/... .
  // Repair only this unambiguous macOS absolute-path shape.
  if (tokenized.startsWith('./Users/') && !isAbsolute(tokenized)) {
    return tokenized.slice(1);
  }
  return tokenized;
}

/** Repair portable session-path placeholders before approval and execution. */
export function normalizeSessionPathTokens(
  value: unknown,
  sessionPath: string,
): unknown {
  if (typeof value === 'string') return normalizePathString(value, sessionPath);
  if (Array.isArray(value)) return value.map(child => normalizeSessionPathTokens(child, sessionPath));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => [key, normalizeSessionPathTokens(child, sessionPath)]),
  );
}
