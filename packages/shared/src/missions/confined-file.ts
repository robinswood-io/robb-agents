import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  type Stats,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export interface ConfinedRegularFile {
  readonly descriptor: number;
  readonly path: string;
  readonly root: string;
  readonly initialStat: Stats;
  assertStillBound(): Stats;
  close(): void;
}

export interface OpenConfinedRegularFileOptions {
  flags: number;
  mode?: number;
  allowCreate?: boolean;
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertSingleLink(stat: Stats, path: string): void {
  if (stat.nlink !== 1) {
    throw new Error(`Confined regular file must have exactly one hard link: ${path}`);
  }
}

export function pathIsWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function canonicalConfinementRoot(root: string): string {
  const canonical = realpathSync(root);
  const stat = lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Confinement root is not a real directory: ${root}`);
  }
  return canonical;
}

function assertCandidateWithinRoot(root: string, candidate: string, lexicalRoot = root): string {
  let absolute: string;
  if (!isAbsolute(candidate)) {
    absolute = resolve(root, candidate);
  } else {
    const supplied = resolve(candidate);
    if (pathIsWithinRoot(root, supplied)) {
      absolute = supplied;
    } else {
      const lexical = resolve(lexicalRoot);
      if (!pathIsWithinRoot(lexical, supplied)) {
        throw new Error(`Confined path escapes its root: ${candidate}`);
      }
      absolute = resolve(root, relative(lexical, supplied));
    }
  }
  if (!pathIsWithinRoot(root, absolute)) {
    throw new Error(`Confined path escapes its root: ${candidate}`);
  }
  return absolute;
}

/**
 * Reject every symlink/reparse-point component and return the leaf's pre-open stat.
 * A missing leaf is accepted only for an explicitly requested atomic creation.
 */
function inspectPathComponents(root: string, candidate: string, allowMissingLeaf: boolean): Stats | undefined {
  const rel = relative(root, candidate);
  const components = rel === '' ? [] : rel.split(sep).filter(Boolean);
  let cursor = root;
  let leafStat: Stats | undefined;

  for (let index = 0; index < components.length; index += 1) {
    cursor = resolve(cursor, components[index]!);
    const isLeaf = index === components.length - 1;
    let stat: Stats;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      if (isLeaf && allowMissingLeaf && errnoCode(error) === 'ENOENT') return undefined;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Confined path contains a symbolic link: ${cursor}`);
    }
    if (!isLeaf && !stat.isDirectory()) {
      throw new Error(`Confined path component is not a directory: ${cursor}`);
    }
    if (isLeaf) leafStat = stat;
  }
  return leafStat;
}

function assertDirectoryBinding(path: string, descriptor: number | undefined, initial: Stats): void {
  const current = lstatSync(path);
  if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(initial, current)) {
    throw new Error(`Confined parent directory changed while in use: ${path}`);
  }
  if (descriptor !== undefined) {
    const pinned = fstatSync(descriptor);
    if (!pinned.isDirectory() || !sameIdentity(initial, pinned)) {
      throw new Error(`Confined parent descriptor changed while in use: ${path}`);
    }
  }
}

function noFollowFlag(): number {
  // O_NOFOLLOW is not a portable Windows flag. On Windows, the pre-open
  // lstat + post-open descriptor identity checks below are the fail-closed
  // fallback; unknown or unstable identities are rejected.
  return process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
}

function openParentDirectory(path: string): number | undefined {
  if (process.platform === 'win32') return undefined;
  return openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}

/**
 * Open a regular file under a canonical root and bind all subsequent I/O to
 * that descriptor. The pre-open lstat identity closes path-swap races for
 * existing files; O_NOFOLLOW closes the final-component race on POSIX.
 *
 * Node does not expose openat(2). For a missing leaf, an adversarial parent
 * swap can therefore cause open(2) to create an empty file before the binding
 * checks reject it. Callers must not write until this function returns; the
 * returned handle is already post-checked and all later I/O stays descriptor-bound.
 */
export function openConfinedRegularFile(
  rootInput: string,
  candidateInput: string,
  options: OpenConfinedRegularFileOptions,
): ConfinedRegularFile {
  const root = canonicalConfinementRoot(rootInput);
  const candidate = assertCandidateWithinRoot(root, candidateInput, rootInput);
  if (basename(candidate) === '.' || basename(candidate) === '..') {
    throw new Error(`Confined path must identify a file: ${candidateInput}`);
  }

  const preOpenStat = inspectPathComponents(root, candidate, options.allowCreate === true);
  if (preOpenStat && (!preOpenStat.isFile() || preOpenStat.isSymbolicLink())) {
    throw new Error(`Confined path is not a regular file: ${candidate}`);
  }
  if (preOpenStat) assertSingleLink(preOpenStat, candidate);

  const parentPath = dirname(candidate);
  const parentInitial = lstatSync(parentPath);
  if (!parentInitial.isDirectory() || parentInitial.isSymbolicLink()) {
    throw new Error(`Confined parent is not a real directory: ${parentPath}`);
  }
  const canonicalParent = realpathSync(parentPath);
  if (!pathIsWithinRoot(root, canonicalParent) || canonicalParent !== parentPath) {
    throw new Error(`Confined parent escapes its root or contains an alias: ${parentPath}`);
  }

  let parentDescriptor: number | undefined;
  let descriptor: number | undefined;
  try {
    parentDescriptor = openParentDirectory(parentPath);
    assertDirectoryBinding(parentPath, parentDescriptor, parentInitial);
    descriptor = openSync(candidate, options.flags | noFollowFlag(), options.mode);
    const initialStat = fstatSync(descriptor);
    if (!initialStat.isFile()) throw new Error(`Confined path is not a regular file: ${candidate}`);
    assertSingleLink(initialStat, candidate);
    if (preOpenStat && !sameIdentity(preOpenStat, initialStat)) {
      throw new Error(`Confined file changed between validation and open: ${candidate}`);
    }

    let closed = false;
    const assertStillBound = (): Stats => {
      if (closed || descriptor === undefined) throw new Error(`Confined file descriptor is closed: ${candidate}`);
      assertDirectoryBinding(parentPath, parentDescriptor, parentInitial);
      inspectPathComponents(root, candidate, false);
      const currentPathStat = lstatSync(candidate);
      const currentDescriptorStat = fstatSync(descriptor);
      assertSingleLink(currentPathStat, candidate);
      assertSingleLink(currentDescriptorStat, candidate);
      if (
        currentPathStat.isSymbolicLink() ||
        !currentPathStat.isFile() ||
        !currentDescriptorStat.isFile() ||
        !sameIdentity(initialStat, currentDescriptorStat) ||
        !sameIdentity(currentPathStat, currentDescriptorStat)
      ) {
        throw new Error(`Confined file path changed while its descriptor was in use: ${candidate}`);
      }
      const canonicalPath = realpathSync(candidate);
      if (!pathIsWithinRoot(root, canonicalPath) || canonicalPath !== candidate) {
        throw new Error(`Confined file escaped its root while in use: ${candidate}`);
      }
      return currentDescriptorStat;
    };

    assertStillBound();
    const handle: ConfinedRegularFile = {
      descriptor,
      path: candidate,
      root,
      initialStat,
      assertStillBound,
      close(): void {
        if (closed) return;
        closed = true;
        closeSync(descriptor!);
        descriptor = undefined;
        if (parentDescriptor !== undefined) closeSync(parentDescriptor);
        parentDescriptor = undefined;
      },
    };
    return handle;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (parentDescriptor !== undefined) closeSync(parentDescriptor);
    throw error;
  }
}

/** Create directory components without accepting a symlink at any level. */
export function ensureConfinedDirectory(rootInput: string, ...components: string[]): string {
  const root = canonicalConfinementRoot(rootInput);
  let cursor = root;
  for (const component of components) {
    if (!component || component === '.' || component === '..' || component.includes('/') || component.includes('\\')) {
      throw new Error(`Invalid confined directory component: ${component}`);
    }
    cursor = assertCandidateWithinRoot(root, resolve(cursor, component));
    try {
      mkdirSync(cursor, { mode: 0o700 });
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') throw error;
    }
    const stat = lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Confined directory is not a real directory: ${cursor}`);
    }
    const canonical = realpathSync(cursor);
    if (!pathIsWithinRoot(root, canonical) || canonical !== cursor) {
      throw new Error(`Confined directory escapes its root or contains an alias: ${cursor}`);
    }
  }
  return cursor;
}

/**
 * Unlink only the pathname that is still bound to this exact open descriptor.
 * The descriptor remains open during unlink on POSIX; Windows closes it first.
 */
export function unlinkConfinedRegularFile(handle: ConfinedRegularFile): void {
  const expected = handle.assertStillBound();
  const path = handle.path;
  const root = handle.root;
  if (process.platform === 'win32') handle.close();
  const current = lstatSync(path);
  const canonical = realpathSync(path);
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    !sameIdentity(expected, current) ||
    !pathIsWithinRoot(root, canonical) ||
    canonical !== path
  ) {
    throw new Error(`Refusing to unlink a changed confined file: ${path}`);
  }
  unlinkSync(path);
}
