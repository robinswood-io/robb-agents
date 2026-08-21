import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

export const RUNTIME_INTEGRITY_MANIFEST_SCHEMA_VERSION = 1 as const;
export const RUNTIME_INTEGRITY_MANIFEST_ASAR_PATH = 'dist/runtime-integrity-manifest.json';
export const REQUIRED_PACKAGED_EXTERNAL_RUNTIME_PATHS = [
  'app/dist/interceptor.cjs',
  'app/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
  'app/resources/bridge-mcp-server/index.js',
  'app/resources/pi-agent-server/index.js',
  'app/resources/pi-agent-server/vibe-acp-server.js',
  'app/resources/session-mcp-server/index.js',
  'app/webui/index.html',
  'messaging-whatsapp-worker/worker.cjs',
] as const;

export interface RuntimeIntegrityEntry {
  /** POSIX path relative to Electron's process.resourcesPath. */
  path: string;
  size: number;
  sha256: string;
}

export interface RuntimeIntegrityManifest {
  schemaVersion: typeof RUNTIME_INTEGRITY_MANIFEST_SCHEMA_VERSION;
  algorithm: 'sha256';
  entries: RuntimeIntegrityEntry[];
}

export interface RuntimeIntegritySource {
  /** POSIX path relative to Electron's process.resourcesPath. */
  path: string;
  sourcePath: string;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function assertSafeManifestPath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096) {
    throw new Error('Runtime integrity entry path must be a non-empty relative path');
  }
  if (path.includes('\\') || path.startsWith('/') || path.endsWith('/')) {
    throw new Error(`Runtime integrity entry path is not canonical: ${path}`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Runtime integrity entry path escapes its root: ${path}`);
  }
}

function parseEntry(value: unknown): RuntimeIntegrityEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Runtime integrity entry must be an object');
  }
  const record = value as Record<string, unknown>;
  assertSafeManifestPath(record.path);
  if (!Number.isSafeInteger(record.size) || (record.size as number) < 0) {
    throw new Error(`Runtime integrity entry has invalid size: ${record.path}`);
  }
  if (typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.sha256)) {
    throw new Error(`Runtime integrity entry has invalid SHA-256: ${record.path}`);
  }
  return {
    path: record.path,
    size: record.size as number,
    sha256: record.sha256,
  };
}

export function parseRuntimeIntegrityManifest(value: unknown): RuntimeIntegrityManifest {
  const parsedValue = typeof value === 'string' || Buffer.isBuffer(value)
    ? JSON.parse(value.toString()) as unknown
    : value;
  if (!parsedValue || typeof parsedValue !== 'object' || Array.isArray(parsedValue)) {
    throw new Error('Runtime integrity manifest must be an object');
  }
  const record = parsedValue as Record<string, unknown>;
  if (record.schemaVersion !== RUNTIME_INTEGRITY_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported runtime integrity manifest version: ${String(record.schemaVersion)}`);
  }
  if (record.algorithm !== 'sha256') {
    throw new Error(`Unsupported runtime integrity algorithm: ${String(record.algorithm)}`);
  }
  if (!Array.isArray(record.entries) || record.entries.length === 0 || record.entries.length > 10_000) {
    throw new Error('Runtime integrity manifest entries must be a non-empty bounded array');
  }
  const entries = record.entries.map(parseEntry);
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]!.path >= entries[index]!.path) {
      throw new Error('Runtime integrity manifest entries must be unique and sorted by path');
    }
  }
  return {
    schemaVersion: RUNTIME_INTEGRITY_MANIFEST_SCHEMA_VERSION,
    algorithm: 'sha256',
    entries,
  };
}

export function createRuntimeIntegrityManifest(
  sources: readonly RuntimeIntegritySource[],
): RuntimeIntegrityManifest {
  const sortedSources = [...sources].sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ));
  const entries = sortedSources.map(({ path, sourcePath }) => {
    assertSafeManifestPath(path);
    const stat = lstatSync(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Runtime integrity source must be a regular file: ${sourcePath}`);
    }
    return { path, size: stat.size, sha256: sha256File(sourcePath) };
  });
  return parseRuntimeIntegrityManifest({
    schemaVersion: RUNTIME_INTEGRITY_MANIFEST_SCHEMA_VERSION,
    algorithm: 'sha256',
    entries,
  });
}

export function serializeRuntimeIntegrityManifest(manifest: RuntimeIntegrityManifest): string {
  return `${JSON.stringify(parseRuntimeIntegrityManifest(manifest), null, 2)}\n`;
}

export function assertRuntimeIntegrityManifestIncludes(
  manifestValue: unknown,
  requiredPaths: readonly string[],
): RuntimeIntegrityManifest {
  const manifest = parseRuntimeIntegrityManifest(manifestValue);
  const manifestPaths = new Set(manifest.entries.map((entry) => entry.path));
  for (const requiredPath of requiredPaths) {
    assertSafeManifestPath(requiredPath);
    if (!manifestPaths.has(requiredPath)) {
      throw new Error(`Required external runtime is absent from protected manifest: ${requiredPath}`);
    }
  }
  return manifest;
}

export function verifyRuntimeIntegrityManifest(
  resourcesRoot: string,
  manifestValue: unknown,
  requiredPaths: readonly string[] = [],
): string[] {
  const manifest = assertRuntimeIntegrityManifestIncludes(manifestValue, requiredPaths);
  const resolvedRoot = resolve(resourcesRoot);
  const verified: string[] = [];

  for (const entry of manifest.entries) {
    const filePath = resolve(resolvedRoot, ...entry.path.split('/'));
    const relativePath = relative(resolvedRoot, filePath);
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
      throw new Error(`Runtime integrity path escapes resources root: ${entry.path}`);
    }
    let stat;
    try {
      stat = lstatSync(filePath);
    } catch {
      throw new Error(`External runtime file is missing: ${entry.path}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`External runtime path is not a regular file: ${entry.path}`);
    }
    if (stat.size !== entry.size) {
      throw new Error(`External runtime size mismatch: ${entry.path}`);
    }
    if (sha256File(filePath) !== entry.sha256) {
      throw new Error(`External runtime SHA-256 mismatch: ${entry.path}`);
    }
    verified.push(filePath);
  }

  return verified;
}
