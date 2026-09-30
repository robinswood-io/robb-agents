import { opendir } from 'node:fs/promises';
import { join } from 'node:path';

interface ContextDirectoryEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface ProjectContextFileListing {
  files: string[];
  /** False means the agent must discover additional applicable instructions itself. */
  complete: boolean;
}

const EXCLUDED_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'vendor',
  '.cache', '.turbo', 'out', '.output',
]);

async function* readDirectory(path: string): AsyncIterable<ContextDirectoryEntry> {
  // opendir streams entries without materializing a huge directory in memory.
  // Its async iterator closes the handle, including when the scan stops early.
  const directory = await opendir(path);
  yield* directory;
}

interface DiscoveryOptions {
  readDirectory?: (path: string) => AsyncIterable<ContextDirectoryEntry>;
  maxFiles?: number;
  maxDirectories?: number;
  maxEntries?: number;
  maxDepth?: number;
  timeoutMs?: number;
  maxConcurrentScans?: number;
  maxCacheEntries?: number;
  cacheTtlMs?: number;
}

/**
 * Optional prompt index, never a synchronous filesystem walk. Bounds apply while
 * discovering files, not after a potentially enormous glob has already finished.
 */
export class ProjectContextFileDiscovery {
  private readonly options: Required<DiscoveryOptions>;
  private readonly cache = new Map<string, { listing: ProjectContextFileListing; timestamp: number }>();
  private readonly pending = new Map<string, Promise<ProjectContextFileListing>>();
  private activeScans = 0;
  private revision = 0;

  constructor(options: DiscoveryOptions = {}) {
    this.options = {
      readDirectory, maxFiles: 30, maxDirectories: 256, maxEntries: 10_000,
      maxDepth: 8, timeoutMs: 750, maxConcurrentScans: 2,
      maxCacheEntries: 64, cacheTtlMs: 5 * 60_000, ...options,
    };
  }

  getCached(directory: string): ProjectContextFileListing | undefined {
    return this.cache.get(directory)?.listing;
  }

  invalidate(directory?: string): void {
    this.revision++;
    if (directory) this.cache.delete(directory);
    else this.cache.clear();
  }

  discover(directory: string): Promise<ProjectContextFileListing> {
    const cached = this.cache.get(directory);
    if (cached && Date.now() - cached.timestamp < this.options.cacheTtlMs) {
      return Promise.resolve(cached.listing);
    }
    const pending = this.pending.get(directory);
    if (pending) return pending;

    const revision = this.revision;
    const promise = this.scan(directory).then(listing => {
      if (revision === this.revision) {
        this.cache.delete(directory);
        this.cache.set(directory, { listing, timestamp: Date.now() });
        while (this.cache.size > this.options.maxCacheEntries) {
          this.cache.delete(this.cache.keys().next().value!);
        }
      }
      return listing;
    }).finally(() => {
      if (this.pending.get(directory) === promise) this.pending.delete(directory);
    });
    this.pending.set(directory, promise);
    return promise;
  }

  private async scan(root: string): Promise<ProjectContextFileListing> {
    // A filesystem permission check may remain pending in the OS after the
    // deadline. Do not accumulate an unbounded number of such operations.
    if (this.activeScans >= this.options.maxConcurrentScans) {
      return { files: [], complete: false };
    }
    this.activeScans++;
    const files: string[] = [];
    let complete = true;
    let stopped = false;
    let directoryCount = 0;
    let entryCount = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const queue: Array<{ path: string; relative: string; depth: number }> = [
      { path: root, relative: '', depth: 0 },
    ];

    const work = (async () => {
      while (queue.length && !stopped) {
        if (directoryCount >= this.options.maxDirectories) { complete = false; break; }
        const current = queue.shift()!;
        directoryCount++;
        const children: typeof queue = [];
        try {
          for await (const entry of this.options.readDirectory(current.path)) {
            if (stopped) break;
            if (++entryCount > this.options.maxEntries) { complete = false; stopped = true; break; }
            const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
            if (entry.isFile() && /^(agents|claude)\.md$/i.test(entry.name)) {
              files.push(relative);
              if (files.length >= this.options.maxFiles) { complete = false; stopped = true; break; }
            } else if (entry.isDirectory() && !entry.name.startsWith('.') && !EXCLUDED_DIRECTORIES.has(entry.name)) {
              if (current.depth >= this.options.maxDepth || directoryCount + queue.length + children.length >= this.options.maxDirectories) {
                complete = false;
              } else {
                children.push({ path: join(current.path, entry.name), relative, depth: current.depth + 1 });
              }
            }
          }
        } catch { complete = false; }
        // Breadth first preserves root / shallow instruction priority.
        children.sort((a, b) => a.relative.localeCompare(b.relative));
        queue.push(...children);
      }
    })().finally(() => { this.activeScans--; });

    try {
      await Promise.race([
        work,
        new Promise<void>(resolve => {
          timer = setTimeout(() => { complete = false; stopped = true; resolve(); }, this.options.timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    // Copy: an OS operation finishing after the deadline cannot mutate a prompt
    // or replace the cache after invalidation.
    return {
      files: [...files].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)),
      complete,
    };
  }
}

export const projectContextFileDiscovery = new ProjectContextFileDiscovery();
