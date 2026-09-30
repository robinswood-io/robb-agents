import { createHash } from 'node:crypto';

/** Host-owned audience and permission state, never supplied by a remote tool. */
export interface CollectionCacheScope {
  workspace: string;
  audience: string;
  permissionRevision: string;
  routeRevision: string;
  /** Independent/sensitive verification must also obtain its own synthesis. */
  freshEvidence?: boolean;
}

type Entry = { summary: string; expiresAt: number; workspace: string };
type Pending = { promise: Promise<string | null>; workspace: string };

/**
 * Reuses only a synthesis of the exact, freshly fetched collection and prompt.
 * Does not cache source calls, permissions, instructions, paths or raw payloads.
 * Memory-only storage avoids persisting a second copy of sensitive collections.
 */
export class CollectionSummaryCache {
  private entries = new Map<string, Entry>();
  private pending = new Map<string, Pending>();
  private bytes = 0;

  constructor(
    private readonly maxEntries = 128,
    private readonly maxBytes = 2 * 1024 * 1024,
    private readonly ttlMs = 10 * 60 * 1000,
    private readonly now = Date.now,
  ) {}

  async summarize(scope: CollectionCacheScope | undefined, prompt: string, generate: () => Promise<string | null>): Promise<string | null> {
    if (!scope || scope.freshEvidence || ![scope.workspace, scope.audience, scope.permissionRevision, scope.routeRevision].every(value => typeof value === 'string' && value.length > 0)) {
      return generate();
    }
    const key = createHash('sha256').update(JSON.stringify([
      'collection-summary-v1', scope.workspace, scope.audience, scope.permissionRevision, scope.routeRevision, prompt,
    ])).digest('hex');
    this.prune();
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing.summary;
    }
    const active = this.pending.get(key);
    if (active) return active.promise;
    // A burst must not retain an unbounded number of large pending prompts.
    if (this.pending.size >= this.maxEntries) return generate();
    const record: Pending = { workspace: scope.workspace, promise: Promise.resolve(null) };
    record.promise = Promise.resolve().then(generate).then(summary => {
      // Invalidation during a generation must prevent the result repopulating the cache.
      if (this.pending.get(key) !== record || !summary?.trim()) return summary;
      const size = Buffer.byteLength(summary);
      if (size <= this.maxBytes) {
        this.entries.set(key, { summary, workspace: scope.workspace, expiresAt: this.now() + this.ttlMs });
        this.bytes += size;
        this.prune();
      }
      return summary;
    }).finally(() => {
      if (this.pending.get(key) === record) this.pending.delete(key);
    });
    this.pending.set(key, record);
    return record.promise;
  }

  /** A known write invalidates all collections in this workspace, across families. */
  invalidateWorkspace(workspace: string): void {
    for (const [key, entry] of this.entries) if (entry.workspace === workspace) this.remove(key);
    for (const [key, entry] of this.pending) if (entry.workspace === workspace) this.pending.delete(key);
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= Buffer.byteLength(entry.summary);
    this.entries.delete(key);
  }

  private prune(): void {
    for (const [key, entry] of this.entries) if (entry.expiresAt <= this.now()) this.remove(key);
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const key = this.entries.keys().next().value;
      if (key === undefined) break;
      this.remove(key);
    }
  }
}

export const collectionSummaryCache = new CollectionSummaryCache();
const underlyingCallbacks = new WeakMap<(prompt: string) => Promise<string | null>, (prompt: string) => Promise<string | null>>();

/** Call only on freshly observed content; the full prompt is the content/version key. */
export function createCollectionSummaryCallback(
  getScope: () => CollectionCacheScope | undefined,
  summarize: (prompt: string) => Promise<string | null>,
): (prompt: string) => Promise<string | null> {
  // API and MCP layers can both install a wrapper. Unwrap to avoid an inner
  // lookup awaiting its own in-flight promise, and use the latest host scope.
  const generate = underlyingCallbacks.get(summarize) ?? summarize;
  const callback = (prompt: string) => collectionSummaryCache.summarize(getScope(), prompt, () => generate(prompt));
  underlyingCallbacks.set(callback, generate);
  return callback;
}
