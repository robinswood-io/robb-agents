/// <reference path="../../types/incr-regex-package.d.ts" />
/**
 * Centralized Permission Mode Manager
 *
 * Manages agent permission modes for tool execution.
 * Each session has its own mode state - no global state contamination.
 *
 * Available Permission Modes:
 * - 'safe': Read-only exploration mode (blocks writes, never prompts)
 * - 'ask': Ask for permission on dangerous operations (default interactive behavior)
 * - 'allow-all': Skip all permission checks (everything allowed)
 */
import { homedir } from "os";
import { lstatSync, realpathSync } from "fs";
import { debug } from "../../utils/debug.ts";
import { dirname, isAbsolute, relative, resolve } from "path";

// ============================================================
// Path Matching Utilities
// ============================================================

/**
 * Expand ~ to home directory
 */
function expandHome(path: string): string {
  if (path.startsWith('~/') || path === '~') {
    return path.replace(/^~/, homedir());
  }
  return path;
}

/**
 * Convert a simple glob pattern to a regex
 * Supports: ** (recursive), * (single segment), ? (single char)
 */
function globToRegex(pattern: string): RegExp {
  // Expand ~ in pattern
  const expandedPattern = expandHome(pattern);

  // Escape special regex chars except glob wildcards
  let regex = expandedPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape regex special chars
    .replace(/\*\*/g, '\0DOUBLE_STAR\0')   // Temporarily replace **
    .replace(/\*/g, '[^/]*')                // * matches single path segment
    .replace(/\0DOUBLE_STAR\0/g, '.*')      // ** matches anything including /
    .replace(/\?/g, '.');                   // ? matches single char

  return new RegExp(`^${regex}$`);
}

/**
 * Check if a path matches any of the allowed write path patterns
 */
export function matchesAllowedWritePath(filePath: string, allowedPaths: string[]): boolean {
  // Normalize path (expand ~, resolve, and use forward slashes)
  const normalizedPath = normalizeForComparison(expandHome(filePath));

  for (const pattern of allowedPaths) {
    try {
      const regex = globToRegex(pattern);
      if (regex.test(normalizedPath)) {
        debug(`[Mode] Path "${normalizedPath}" matches allowed pattern "${pattern}"`);
        return true;
      }
    } catch (e) {
      debug(`[Mode] Invalid glob pattern "${pattern}":`, e);
    }
  }
  return false;
}

/**
 * Normalize a path for cross-platform comparison.
 * - Resolve to absolute path
 * - Convert backslashes to forward slashes
 * - Lowercase on Windows for case-insensitive comparison
 */
function normalizeForComparison(path: string): string {
  const normalized = resolve(path).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isWithin(base: string, target: string): boolean {
  const normalizedBase = normalizeForComparison(base);
  const normalizedTarget = normalizeForComparison(target);
  const rel = relative(normalizedBase, normalizedTarget);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function filesystemEntryState(path: string): 'exists' | 'missing' | 'inaccessible' {
  try {
    lstatSync(path);
    return 'exists';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'inaccessible';
  }
}

/**
 * Check whether targetPath is inside baseDir (or exactly equal to it).
 *
 * Uses path.relative semantics to avoid sibling-prefix bypasses and then
 * re-validates using real paths to prevent symlink escapes.
 */
export function isPathWithinDirectory(targetPath: string, baseDir: string): boolean {
  const expandedTarget = expandHome(targetPath);
  const expandedBase = expandHome(baseDir);

  const resolvedTarget = resolve(expandedTarget);
  const resolvedBase = resolve(expandedBase);
  if (!isWithin(resolvedBase, resolvedTarget)) {
    return false;
  }

  const baseState = filesystemEntryState(resolvedBase);
  if (baseState === 'inaccessible') return false;
  let realBase = resolvedBase;
  if (baseState === 'exists') {
    try {
      realBase = realpathSync.native(resolvedBase);
    } catch {
      // Includes broken or looping base-directory symlinks.
      return false;
    }
  }

  const targetState = filesystemEntryState(resolvedTarget);
  if (targetState === 'inaccessible') return false;
  if (targetState === 'exists') {
    try {
      const realTarget = realpathSync.native(resolvedTarget);
      return isWithin(realBase, realTarget);
    } catch {
      // A follow-based existence probe misses a broken destination link.
      // lstat above deliberately detects it so it cannot be treated as a new
      // confined file and followed by the eventual writer.
      return false;
    }
  }

  // Target may be a new file path. Validate using nearest existing ancestor
  // to prevent symlink escapes while still allowing legitimate new files.
  let current = dirname(resolvedTarget);
  while (true) {
    const currentState = filesystemEntryState(current);
    if (currentState === 'inaccessible') return false;
    if (currentState === 'exists') {
      try {
        const realCurrent = realpathSync.native(current);
        return isWithin(realBase, realCurrent);
      } catch {
        return false;
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}
