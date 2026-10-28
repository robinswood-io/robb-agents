import { validateSessionExecutionIsolation, type SessionExecutionIsolation } from "@craft-agent/shared/tasks";
import type { ManagedSession } from './managed-session.ts';

export type SessionReviewRole = Pick<ManagedSession, 'delegation' | 'missionRole'>

/** Mission v2 stores terminal reviewers on missionRole rather than the legacy
 * delegation envelope. Both provenances are host-owned and must produce the
 * same read-only routing, objective authority and permission boundary. */
export function isTerminalReviewSession(session: SessionReviewRole): boolean {
  return session.delegation?.role === 'reviewer'
    || session.missionRole === 'reviewer'
    || session.missionRole === 'supervisor'
}

type MissionRecoveryOwnership = SessionReviewRole & Pick<ManagedSession,
  'missionId' | 'missionWorkItemId' | 'missionDispatchId' | 'pendingTurnRecovery'
>;

/** MissionRuntime, not the generic cold-session scheduler, owns recovery of
 * every durably identified Mission turn. Only MissionRuntime can bind the
 * resumed provider work back to the exact journal dispatch and revalidate its
 * route/capability boundary. Restricting this ownership to reviewers lets a
 * worker race the generic restart scheduler and resume outside the journal. */
export function isMissionRuntimeOwnedRecovery(
  session: MissionRecoveryOwnership,
): boolean {
  return !!session.pendingTurnRecovery
    && !!session.missionId
    && !!session.missionWorkItemId
    && !!session.missionDispatchId
}

export function delegatedObjectiveRoleForSession(
  session: SessionReviewRole,
): 'worker' | 'reviewer' | undefined {
  return isTerminalReviewSession(session) ? 'reviewer' : session.delegation?.role
}

/** Rebuild the durable read-only envelope for reviewers created before the
 * Mission role clamp existed. Preserve a valid narrower read scope and its
 * resource bounds, but never carry write authority into a terminal review. */
export function terminalReviewExecutionIsolation(
  existing: SessionExecutionIsolation | undefined,
  workspaceRoot: string,
): SessionExecutionIsolation {
  const validExisting = existing
    && validateSessionExecutionIsolation(existing, workspaceRoot).allowed
    ? existing.policy
    : undefined
  return {
    effect: 'read',
    policy: {
      workspaceRoot: validExisting?.workspaceRoot ?? workspaceRoot,
      allowedReadPaths: [...(validExisting?.allowedReadPaths ?? ['.'])],
      allowedWritePaths: [],
      ...(validExisting?.allowedReadToolInvocations?.length ? {
        allowedReadToolInvocations: validExisting.allowedReadToolInvocations.map(invocation => ({
          toolName: invocation.toolName,
          inputJson: invocation.inputJson,
        })),
      } : {}),
      networkAccess: validExisting?.networkAccess ?? 'disabled',
      allowedHosts: [...(validExisting?.allowedHosts ?? [])],
      maxCpuPercent: validExisting?.maxCpuPercent ?? 100,
      maxMemoryMb: validExisting?.maxMemoryMb ?? 1024,
      timeoutMs: validExisting?.timeoutMs ?? 30 * 60 * 1000,
    },
  }
}
