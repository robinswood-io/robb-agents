import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  applyWorkspaceGovernanceUpdate,
  parseWorkspaceGovernanceProfile,
  WorkspaceGovernanceProfileSchema,
  type WorkspaceGovernanceMutable,
  type WorkspaceGovernanceProfile,
} from './workspace-governance.ts';

const STORE_DIRECTORY_MODE = 0o700;
const STORE_FILE_MODE = 0o600;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

export const WorkspaceGovernanceDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  workspaceId: z.string().trim().min(1),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
  updatedBy: z.string().trim().min(1),
  profile: WorkspaceGovernanceProfileSchema,
});

export type WorkspaceGovernanceDocument = z.infer<typeof WorkspaceGovernanceDocumentSchema>;

export class GovernanceRevisionConflictError extends Error {
  readonly code = 'GOVERNANCE_REVISION_CONFLICT';

  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`Governance revision conflict: expected ${expectedRevision}, current revision is ${actualRevision}`);
    this.name = 'GovernanceRevisionConflictError';
  }
}

export class GovernanceStoreBusyError extends Error {
  readonly code = 'GOVERNANCE_STORE_BUSY';

  constructor(lockPath: string) {
    super(`Governance store is busy: ${lockPath}`);
    this.name = 'GovernanceStoreBusyError';
  }
}

export interface WorkspaceGovernanceStoreOptions {
  lockTimeoutMs?: number;
  now?: () => Date;
}

export class WorkspaceGovernanceStore {
  readonly documentPath: string;
  readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly workspaceRoot: string,
    options: WorkspaceGovernanceStoreOptions = {},
  ) {
    this.documentPath = join(workspaceRoot, '.robb', 'governance.json');
    this.lockPath = join(workspaceRoot, '.robb', 'governance.lock');
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
  }

  async load(): Promise<WorkspaceGovernanceDocument | null> {
    try {
      const raw = await readFile(this.documentPath, 'utf8');
      return this.parseDocument(raw);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return null;
      throw error;
    }
  }

  async loadOrCreate(initialProfile: WorkspaceGovernanceProfile): Promise<WorkspaceGovernanceDocument> {
    const existing = await this.load();
    if (existing) return existing;

    return this.withLock(async () => {
      const concurrent = await this.load();
      if (concurrent) return concurrent;
      const parsedProfile = parseWorkspaceGovernanceProfile(initialProfile);
      const initial: WorkspaceGovernanceDocument = {
        schemaVersion: 1,
        workspaceId: parsedProfile.space.id,
        revision: 0,
        updatedAt: this.now().toISOString(),
        updatedBy: parsedProfile.space.createdBy,
        profile: parsedProfile,
      };
      await this.writeDocument(initial);
      return initial;
    });
  }

  async update(
    expectedRevision: number,
    actorId: string,
    mutable: WorkspaceGovernanceMutable,
  ): Promise<WorkspaceGovernanceDocument> {
    return this.withLock(async () => {
      const current = await this.load();
      if (!current) {
        throw new Error(`Governance store does not exist for workspace "${this.workspaceRoot}"`);
      }
      if (current.revision !== expectedRevision) {
        throw new GovernanceRevisionConflictError(expectedRevision, current.revision);
      }

      const timestamp = this.now().toISOString();
      const profile = applyWorkspaceGovernanceUpdate(current.profile, mutable, actorId, timestamp);
      const next: WorkspaceGovernanceDocument = {
        schemaVersion: 1,
        workspaceId: current.workspaceId,
        revision: current.revision + 1,
        updatedAt: timestamp,
        updatedBy: actorId,
        profile,
      };
      await this.writeDocument(next);
      return next;
    });
  }

  private parseDocument(raw: string): WorkspaceGovernanceDocument {
    const document = WorkspaceGovernanceDocumentSchema.parse(JSON.parse(raw) as unknown);
    if (document.workspaceId !== document.profile.space.id) {
      throw new Error('Governance document workspace ID does not match its profile');
    }
    return document;
  }

  private async writeDocument(document: WorkspaceGovernanceDocument): Promise<void> {
    const parsed = WorkspaceGovernanceDocumentSchema.parse(document);
    const directory = dirname(this.documentPath);
    await mkdir(directory, { recursive: true, mode: STORE_DIRECTORY_MODE });
    await chmod(directory, STORE_DIRECTORY_MODE);
    const temporaryPath = `${this.documentPath}.${process.pid}.${randomUUID()}.tmp`;

    try {
      const handle = await open(temporaryPath, 'wx', STORE_FILE_MODE);
      try {
        await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(temporaryPath, STORE_FILE_MODE);
      await rename(temporaryPath, this.documentPath);
      await chmod(this.documentPath, STORE_FILE_MODE);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.lockPath), { recursive: true, mode: STORE_DIRECTORY_MODE });
    const handle = await this.acquireLock();
    try {
      return await operation();
    } finally {
      await handle.close();
      await unlink(this.lockPath).catch(() => undefined);
    }
  }

  private async acquireLock() {
    const createLock = async () => {
      const handle = await open(this.lockPath, 'wx', STORE_FILE_MODE);
      await handle.writeFile(JSON.stringify({
        pid: process.pid,
        acquiredAt: this.now().toISOString(),
      }), 'utf8');
      return handle;
    };

    try {
      return await createLock();
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
    }

    try {
      const lockStat = await stat(this.lockPath);
      if (this.now().getTime() - lockStat.mtimeMs <= this.lockTimeoutMs) {
        throw new GovernanceStoreBusyError(this.lockPath);
      }
      await unlink(this.lockPath);
      return await createLock();
    } catch (error) {
      if (error instanceof GovernanceStoreBusyError) throw error;
      if (isNodeError(error, 'ENOENT')) return createLock();
      throw new GovernanceStoreBusyError(this.lockPath);
    }
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
