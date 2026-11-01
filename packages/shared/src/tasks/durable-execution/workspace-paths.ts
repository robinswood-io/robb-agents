/**
 * Durable execution guardrails shared by the Task runner and future connector
 * workers. This module intentionally stores metadata only: secret values never
 * belong in a checkpoint, run log, or dead-letter record.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { GuardDecision } from './contracts.ts';

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function nearestExistingAncestor(candidate: string): string {
  let current = candidate;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

/**
 * Reject lexical traversal and existing symlink escapes. For a path that does
 * not exist yet, its nearest existing ancestor is canonicalized first.
 */
export function authorizeWorkspacePath(
  workspaceRoot: string,
  candidatePath: string,
  allowedPaths: readonly string[],
): GuardDecision {
  if (candidatePath.includes('\0')) {
    return { allowed: false, reason: 'Path contains a null byte' };
  }

  const lexicalRoot = resolve(workspaceRoot);
  if (!existsSync(lexicalRoot)) {
    return { allowed: false, reason: 'Workspace root does not exist' };
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(lexicalRoot);
  } catch {
    return { allowed: false, reason: 'Workspace root cannot be canonicalized' };
  }
  const lexicalCandidate = isAbsolute(candidatePath)
    ? resolve(candidatePath)
    : resolve(lexicalRoot, candidatePath);
  if (!isInside(lexicalRoot, lexicalCandidate)) {
    return { allowed: false, reason: 'Path escapes the workspace root' };
  }

  let ancestor: string;
  try {
    ancestor = realpathSync(nearestExistingAncestor(lexicalCandidate));
  } catch {
    return { allowed: false, reason: 'Path cannot be canonicalized' };
  }
  if (!isInside(canonicalRoot, ancestor)) {
    return { allowed: false, reason: 'Path escapes the workspace through a symbolic link' };
  }

  const allowed = allowedPaths.some((allowedPath) => {
    const allowedAbsolute = isAbsolute(allowedPath)
      ? resolve(allowedPath)
      : resolve(lexicalRoot, allowedPath);
    if (!isInside(lexicalRoot, allowedAbsolute)) return false;
    return isInside(allowedAbsolute, lexicalCandidate);
  });

  return allowed
    ? { allowed: true }
    : { allowed: false, reason: 'Path is outside the configured allow-list' };
}
