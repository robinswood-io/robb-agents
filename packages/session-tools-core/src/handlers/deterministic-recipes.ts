import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isPathWithinDirectory, isPathWithinDirectoryForCreation } from '../runtime/path-security.ts';
import { isProtectedApplicationPath, APPLICATION_PROTECTION_REASON } from '../runtime/application-protection.ts';

export interface DeterministicRecipe {
  name: 'json-records-v1';
  recordsPath?: string[];
  select?: string[];
  filter?: { field: string; equals: string | number | boolean | null };
  aggregate?: { groupBy?: string; sums?: string[] };
}

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_ROWS = 100_000;
const MAX_CACHE_ENTRIES = 64;
const MAX_CACHE_ENTRY_BYTES = 512 * 1024;
// Never persisted or exported. Tool subprocesses get their own key; editing a
// writable receipt and its checksum cannot manufacture a host-verified result.
const RECEIPT_AUTH_KEY = randomBytes(32);

function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function receiptMac(key: string, data: string): Buffer {
  return createHmac('sha256', RECEIPT_AUTH_KEY).update(JSON.stringify(['recipe-receipt-v1', key, data])).digest();
}
function authenticReceipt(key: string, data: string, mac: unknown): boolean {
  return typeof mac === 'string' && /^[a-f0-9]{64}$/.test(mac)
    && timingSafeEqual(receiptMac(key, data), Buffer.from(mac, 'hex'));
}
function own(record: unknown, key: string): unknown {
  return record && typeof record === 'object' && Object.hasOwn(record, key)
    ? (record as Record<string, unknown>)[key] : undefined;
}
function isRecord(row: unknown): row is Record<string, unknown> {
  return row !== null && typeof row === 'object' && !Array.isArray(row);
}

/** No script execution, network, environment, clock or model call in a recipe. */
export function applyDeterministicRecipe(input: unknown, recipe: DeterministicRecipe): unknown[] {
  let source = input;
  for (const segment of recipe.recordsPath ?? []) source = own(source, segment);
  if (!Array.isArray(source) || source.length > MAX_ROWS || !source.every(isRecord)) {
    throw new Error(`recordsPath must identify an array of at most ${MAX_ROWS} JSON records`);
  }
  const filtered = recipe.filter
    ? source.filter(row => own(row, recipe.filter!.field) === recipe.filter!.equals)
    : source;
  if (!recipe.aggregate) {
    return recipe.select
      ? filtered.map(row => Object.fromEntries(recipe.select!.map(field => {
        if (!Object.hasOwn(row, field)) throw new Error(`Missing selected field: ${field}`);
        return [field, own(row, field)];
      })))
      : filtered;
  }
  const groups = new Map<string, { group: unknown; count: number; sums: Record<string, number> }>();
  for (const row of filtered) {
    const group = recipe.aggregate.groupBy ? own(row, recipe.aggregate.groupBy) : null;
    if (group === undefined || (group !== null && !['string', 'number', 'boolean'].includes(typeof group))) {
      throw new Error('groupBy must reference an existing scalar field');
    }
    const key = JSON.stringify(group);
    const aggregate = groups.get(key) ?? { group, count: 0, sums: Object.create(null) as Record<string, number> };
    aggregate.count++;
    for (const field of new Set(recipe.aggregate.sums ?? [])) {
      const value = own(row, field);
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Non-numeric or missing sum field: ${field}`);
      const sum = (aggregate.sums[field] ?? 0) + value;
      if (!Number.isFinite(sum) || (Number.isInteger(sum) && !Number.isSafeInteger(sum))) throw new Error(`Sum overflow or unsafe integer: ${field}`);
      aggregate.sums[field] = sum;
    }
    groups.set(key, aggregate);
  }
  return [...groups.values()];
}

function atomicWrite(path: string, content: string, dataDir: string): void {
  if (isProtectedApplicationPath(path)) throw new Error(APPLICATION_PROTECTION_REASON);
  if (!isPathWithinDirectoryForCreation(path, dataDir)) throw new Error('Recipe output escapes session data directory');
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* Renamed successfully, or nothing was created. */ }
  }
}

export interface RecipeFileResult {
  input: string;
  inputSha256?: string;
  status: 'ok' | 'error';
  reused?: boolean;
  rowCount?: number;
  rows?: unknown[];
  error?: string;
}

/**
 * Inputs have already passed transform_data's session/skill path checks. Every
 * retry rereads and hashes each source; only successful, authenticated results
 * from this host process resume. After restart, deterministic work is recomputed.
 * The cache is session-local: cross-session access never bypasses file authority.
 */
export function runDeterministicRecipe(
  inputs: string[], output: string, dataDir: string, recipe: DeterministicRecipe,
): { files: RecipeFileResult[]; succeeded: number; failed: number; reused: number } {
  if (recipe.name !== 'json-records-v1') throw new Error('Unknown deterministic recipe version');
  if (inputs.length === 0 || inputs.length > 32) throw new Error('A recipe requires 1 to 32 input files');
  const cacheDir = join(dataDir, '.transform-recipes');
  if (!isPathWithinDirectoryForCreation(cacheDir, dataDir)) throw new Error('Recipe cache escapes session data directory');
  // Stop before any work when the batch itself exceeds its memory budget.
  const totalBytes = inputs.reduce((total, path) => {
    try { return total + statSync(path).size; } catch { return total; }
  }, 0);
  if (totalBytes > MAX_TOTAL_INPUT_BYTES) throw new Error('Recipe batch exceeds 32 MiB');
  // Count interrupted temporary writes as well, so crashes cannot evade the cap.
  let cacheCount = existsSync(cacheDir) ? readdirSync(cacheDir).length : 0;
  const files: RecipeFileResult[] = inputs.map(input => {
    let inputSha256: string | undefined;
    try {
      const stat = statSync(input);
      if (!stat.isFile()) throw new Error('Input must be a regular file');
      if (stat.size > MAX_INPUT_BYTES) throw new Error('Input exceeds 8 MiB');
      const bytes = readFileSync(input);
      if (bytes.byteLength > MAX_INPUT_BYTES) throw new Error('Input grew beyond 8 MiB');
      inputSha256 = hash(bytes);
      const key = hash(JSON.stringify(['transform-recipe-cache-v1', recipe, inputSha256]));
      const cachePath = join(cacheDir, `${key}.json`);
      let rows: unknown[] | undefined;
      let reused = false;
      if (existsSync(cachePath) && isPathWithinDirectory(cachePath, dataDir) && statSync(cachePath).size <= MAX_CACHE_ENTRY_BYTES) {
        try {
          const entry = JSON.parse(readFileSync(cachePath, 'utf8')) as { key: string; data: string; sha256: string; mac?: string };
          if (entry.key === key && typeof entry.data === 'string' && hash(entry.data) === entry.sha256
            && authenticReceipt(key, entry.data, entry.mac)) {
            const parsed: unknown = JSON.parse(entry.data);
            if (Array.isArray(parsed) && parsed.length <= MAX_ROWS) { rows = parsed; reused = true; }
          }
        } catch { /* A damaged receipt is recomputed, never treated as successful. */ }
      }
      if (!rows) {
        const parsed: unknown = JSON.parse(bytes.toString('utf8'), (_key, value: unknown) => {
          if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
            throw new Error('Input contains a non-finite or unsafe integer; use strings for exact large identifiers');
          }
          return value;
        });
        rows = applyDeterministicRecipe(parsed, recipe);
        const data = JSON.stringify(rows);
        const receipt = JSON.stringify({ key, data, sha256: hash(data), mac: receiptMac(key, data).toString('hex') });
        const replacing = existsSync(cachePath);
        if ((replacing || cacheCount < MAX_CACHE_ENTRIES) && Buffer.byteLength(receipt) <= MAX_CACHE_ENTRY_BYTES) {
          try { atomicWrite(cachePath, receipt, dataDir); if (!replacing) cacheCount++; } catch { /* Cache failure must not lose the valid transformation. */ }
        }
      }
      return { input, inputSha256, status: 'ok', reused, rowCount: rows.length, rows };
    } catch (error) {
      return { input, inputSha256, status: 'error', error: error instanceof Error ? error.message : String(error) };
    }
  });
  const report = { files, succeeded: files.filter(file => file.status === 'ok').length, failed: files.filter(file => file.status === 'error').length, reused: files.filter(file => file.reused).length };
  atomicWrite(output, JSON.stringify({ recipe, ...report }, null, 2), dataDir);
  return report;
}
