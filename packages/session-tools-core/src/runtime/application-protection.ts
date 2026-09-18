import { existsSync, lstatSync, realpathSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Host-owned policy. There is deliberately no permission-mode or environment opt-out. */
export const APPLICATION_PROTECTION_REASON = 'The installed Robb Agents application is read-only for agents. Edit the source repository, build a complete verified package, and use the application installer. Never patch or re-sign the installed bundle.';

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync.native(absolute); } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonicalPath(parent), absolute.slice(parent.length + (parent === sep ? 0 : 1)));
  }
}

export function protectedApplicationRoots(): string[] {
  if (process.platform !== 'darwin') return [];
  const roots = ['/Applications/Robb Agents.app', join(homedir(), 'Applications', 'Robb Agents.app')];
  // Include relocated and development bundles, using host process identity, never tool input.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  for (const path of [process.execPath, resourcesPath]) {
    const bundle = path?.match(/^(.+?\.app)\/Contents(?:\/|$)/)?.[1];
    if (bundle) roots.push(bundle);
  }
  return [...new Set(roots.flatMap(root => [resolve(root), canonicalPath(root)]))];
}

export function isProtectedApplicationPath(path: string, roots = protectedApplicationRoots()): boolean {
  const candidate = canonicalPath(path);
  return roots.some(root => {
    const protectedRoot = canonicalPath(root);
    return candidate === protectedRoot || candidate.startsWith(`${protectedRoot}${sep}`)
      // Renaming/removing an ancestor would move the protected bundle outside its deny rule.
      || protectedRoot.startsWith(`${candidate}${sep}`);
  });
}

/** A kernel-enforced write deny inherited by children, including shells and interpreters. */
export function buildApplicationProtectionProfile(roots: readonly string[]): string {
  if (roots.length === 0) throw new Error('Application protection requires at least one bundle root');
  const paths = new Set<string>();
  for (const root of roots) {
    if (!root.startsWith('/') || /[\x00-\x1f\x7f]/.test(root) || resolve(root) === '/') {
      throw new Error('Invalid application protection root');
    }
    for (const path of [resolve(root), canonicalPath(root)]) {
      paths.add(path);
      // macOS firmlinks expose the same writable volume through a second spelling.
      const dataPath = `/System/Volumes/Data${path}`;
      if (existsSync(dataPath)) paths.add(dataPath);
    }
  }
  const quote = (path: string) => JSON.stringify(path);
  const rules = [
    '(version 1)', '(allow default)',
    // Do not hand arbitrary execution to an unsandboxed GUI process, launchd job, or debugger.
    '(deny appleevent-send)', '(deny lsopen)', '(deny job-creation)', '(deny mach-priv-task-port)',
    '(deny mach-lookup (global-name "com.apple.coreservices.appleevents") (global-name "com.apple.xpc.launchd"))',
  ];
  const ancestors = new Set<string>();
  for (const path of paths) {
    rules.push(`(deny file-write* (subpath ${quote(path)}))`);
    for (let parent = dirname(path); parent !== '/'; parent = dirname(parent)) ancestors.add(parent);
  }
  for (const parent of ancestors) rules.push(`(deny file-write-unlink (literal ${quote(parent)}))`);
  return rules.join('\n');
}

/**
 * A hard link outside the bundle would give a sandboxed child another path to
 * the same inode and bypass path-based Seatbelt rules. Refuse to start while
 * any protected regular file has more than one link. Inspection errors are
 * fatal too: an unreadable or changing bundle cannot be proven safe.
 */
export function assertNoProtectedApplicationHardlinks(roots: readonly string[]): void {
  const inspectedDirectories = new Set<string>();
  for (const requestedRoot of roots) {
    const root = canonicalPath(requestedRoot);
    let rootExists = true;
    try {
      lstatSync(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') rootExists = false;
      else throw new Error(`Cannot inspect protected application root "${root}". ${APPLICATION_PROTECTION_REASON}`);
    }
    if (!rootExists) continue;

    const pending = [root];
    while (pending.length > 0) {
      const path = pending.pop()!;
      let stats;
      try {
        stats = lstatSync(path);
      } catch {
        throw new Error(`Cannot inspect protected application path "${path}". ${APPLICATION_PROTECTION_REASON}`);
      }
      if (stats.isSymbolicLink()) continue;
      if (stats.isFile() && stats.nlink > 1) {
        throw new Error(`Pre-existing hard link detected for protected application file "${path}" (link count: ${stats.nlink}). ${APPLICATION_PROTECTION_REASON}`);
      }
      if (!stats.isDirectory()) continue;

      let directoryKey: string;
      try {
        directoryKey = realpathSync.native(path);
      } catch {
        throw new Error(`Cannot resolve protected application directory "${path}". ${APPLICATION_PROTECTION_REASON}`);
      }
      if (inspectedDirectories.has(directoryKey)) continue;
      inspectedDirectories.add(directoryKey);

      let names: string[];
      try {
        names = readdirSync(path);
      } catch {
        throw new Error(`Cannot read protected application directory "${path}". ${APPLICATION_PROTECTION_REASON}`);
      }
      for (const name of names) pending.push(join(path, name));
    }
  }
}

function protectedRootsIdentity(roots: readonly string[]): string {
  const identities = roots.map(requestedRoot => {
    const root = canonicalPath(requestedRoot);
    try {
      const stats = lstatSync(root);
      return [root, stats.dev, stats.ino, stats.mtimeMs];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [root, 'missing'];
      throw new Error(`Cannot identify protected application root "${root}". ${APPLICATION_PROTECTION_REASON}`);
    }
  });
  return JSON.stringify(identities.sort(([a], [b]) => String(a).localeCompare(String(b))));
}

export function protectApplicationCommand(command: string, args: readonly string[] = []): { command: string; args: string[] } {
  const roots = protectedApplicationRoots();
  if (roots.length === 0) return { command, args: [...args] };
  if (!existsSync('/usr/bin/sandbox-exec')) throw new Error(`Application protection unavailable. ${APPLICATION_PROTECTION_REASON}`);
  // The protected roots are host-owned and stable for the lifetime of this
  // process. A sandboxed child cannot add a hard link after a successful scan.
  // Root identity is still checked cheaply so replacement or relocation forces
  // a new full verification before another command starts.
  const rootsIdentity = protectedRootsIdentity(roots);
  if (rootsIdentity !== protectedHardlinksVerifiedFor) {
    assertNoProtectedApplicationHardlinks(roots);
    const verifiedIdentity = protectedRootsIdentity(roots);
    if (verifiedIdentity !== rootsIdentity) {
      throw new Error(`Protected application roots changed during verification. ${APPLICATION_PROTECTION_REASON}`);
    }
    protectedHardlinksVerifiedFor = verifiedIdentity;
  }
  assertProtectionWorks();
  // Pass the policy as an argument, not a writable temporary profile. No fallback on spawn failure.
  return { command: '/usr/bin/sandbox-exec', args: ['-p', buildApplicationProtectionProfile(roots), command, ...args] };
}

let protectedHardlinksVerifiedFor: string | undefined;
let protectionVerified = false;
function assertProtectionWorks(): void {
  if (protectionVerified) return;
  const dir = mkdtempSync(join(tmpdir(), 'robb-protection-probe-'));
  const marker = join(dir, 'must-not-exist');
  const launchdMarker = join(dir, 'launchd-must-not-exist');
  const launchdLabel = `io.robinswood.robb-agents.protection-probe.${process.pid}.${randomUUID()}`;
  try {
    // Only a disposable fixture is probed. Never test a write against user data or app.asar.
    const result = spawnSync('/usr/bin/sandbox-exec', [
      '-p', buildApplicationProtectionProfile([dir]), '/bin/sh', '-c',
      'if /usr/bin/touch "$1" 2>/dev/null; then exit 42; else exit 0; fi', 'probe', marker,
    ], { encoding: 'utf8', timeout: 5000 });
    if (result.status !== 0 || existsSync(marker)) {
      throw new Error('macOS application protection failed its startup probe; agent execution is stopped.');
    }

    // A launchd job would escape the child's inherited sandbox. Verify the
    // kernel refuses registration before allowing any agent process to start.
    const launchdResult = spawnSync('/usr/bin/sandbox-exec', [
      '-p', buildApplicationProtectionProfile([dir]), '/bin/launchctl', 'submit',
      '-l', launchdLabel, '--', '/usr/bin/touch', launchdMarker,
    ], { encoding: 'utf8', timeout: 5000 });
    if (launchdResult.error || launchdResult.signal || launchdResult.status === null
      || launchdResult.status === 0 || existsSync(launchdMarker)) {
      throw new Error('macOS application protection did not conclusively deny launchd job creation; agent execution is stopped.');
    }
    protectionVerified = true;
  } finally {
    // Defensive cleanup in case a future policy regression registers the
    // disposable probe job before the fail-closed check above aborts.
    spawnSync('/bin/launchctl', ['remove', launchdLabel], { timeout: 5000 });
    rmSync(dir, { recursive: true, force: true });
  }
}
