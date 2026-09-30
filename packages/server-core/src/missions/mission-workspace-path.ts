import { resolve } from 'node:path';
import { authorizeWorkspacePath } from '@craft-agent/shared/tasks';

/**
 * Resolve a Mission path against its workspace, then apply the existing
 * lexical-containment and symlink-escape contract to that exact projection.
 */
export function canonicalMissionWorkspacePath(
  workspaceRoot: string,
  candidatePath: string | undefined,
  label: string,
): string {
  const canonical = resolve(workspaceRoot, candidatePath ?? '.');
  const decision = authorizeWorkspacePath(workspaceRoot, canonical, ['.']);
  if (!decision.allowed) {
    throw new Error(`Mission ${label} is not authorized: ${decision.reason}`);
  }
  return canonical;
}

export function canonicalMissionWorkingDirectory(
  workspaceRoot: string,
  missionCwd?: string,
): string {
  return canonicalMissionWorkspacePath(workspaceRoot, missionCwd, 'working directory');
}
