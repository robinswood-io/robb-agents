import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  SpecializedProfileRegistryAnchorSchema,
  type SpecializedProfileRegistryAnchor,
  type SpecializedProfileRegistryAnchorStore,
} from '@craft-agent/shared/specialized-profiles';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Host-state anchor store. Its root must live outside every workspace (the
 * production caller injects the isolated Robb config profile directory).
 */
export class FileSpecializedProfileRegistryAnchorStore
implements SpecializedProfileRegistryAnchorStore {
  private readonly root: string;

  constructor(root: string) {
    if (!root.trim()) throw new Error('Specialized profile anchor directory is required');
    this.root = resolve(root);
  }

  async load(workspaceId: string): Promise<SpecializedProfileRegistryAnchor | null> {
    const path = this.pathFor(workspaceId);
    let descriptor: number;
    try {
      descriptor = openSync(path, constants.O_RDONLY | noFollowFlag());
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return null;
      throw error;
    }
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new Error(`Unsafe specialized profile registry anchor: ${path}`);
      }
      return SpecializedProfileRegistryAnchorSchema.parse(
        JSON.parse(readFileSync(descriptor, 'utf8')) as unknown,
      );
    } finally {
      closeSync(descriptor);
    }
  }

  async save(workspaceId: string, value: SpecializedProfileRegistryAnchor): Promise<void> {
    const anchor = SpecializedProfileRegistryAnchorSchema.parse(value);
    if (anchor.workspaceId !== workspaceId) {
      throw new Error('Specialized profile registry anchor workspace mismatch');
    }
    this.ensureRoot();
    const destination = this.pathFor(workspaceId);
    assertSafeFileOrAbsent(destination);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
        FILE_MODE,
      );
      const payload = Buffer.from(`${JSON.stringify(anchor, null, 2)}\n`, 'utf8');
      let offset = 0;
      while (offset < payload.length) {
        offset += writeSync(descriptor, payload, offset, payload.length - offset);
      }
      fsyncSync(descriptor);
      if (process.platform !== 'win32') fchmodSync(descriptor, FILE_MODE);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, destination);
      const directory = openSync(this.root, constants.O_RDONLY | directoryFlag() | noFollowFlag());
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  private pathFor(workspaceId: string): string {
    if (!workspaceId.trim()) throw new Error('Specialized profile anchor workspace is required');
    return join(this.root, `${createHash('sha256').update(workspaceId).digest('hex')}.json`);
  }

  private ensureRoot(): void {
    mkdirSync(this.root, { recursive: true, mode: DIRECTORY_MODE });
    const stat = lstatSync(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Unsafe specialized profile anchor directory: ${this.root}`);
    }
    if (process.platform !== 'win32') {
      const descriptor = openSync(this.root, constants.O_RDONLY | directoryFlag() | noFollowFlag());
      try { fchmodSync(descriptor, DIRECTORY_MODE); } finally { closeSync(descriptor); }
    }
  }
}

function assertSafeFileOrAbsent(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error(`Unsafe specialized profile registry anchor: ${path}`);
    }
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
}

function noFollowFlag(): number {
  return process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
}

function directoryFlag(): number {
  return process.platform === 'win32' ? 0 : constants.O_DIRECTORY;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
