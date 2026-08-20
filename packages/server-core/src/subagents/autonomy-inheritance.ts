import type { PermissionMode } from '@craft-agent/shared/agent/mode-types';
import type { ExternalActionPolicy } from '@craft-agent/shared/workspaces';

/**
 * Authoritative inputs used when a host creates a child agent session.
 *
 * The parent mode takes precedence over the workspace default. Callers that
 * were given a parent id but cannot resolve that session must pass `safe` for
 * `parentPermissionMode`; silently falling back to the workspace would turn a
 * stale parent reference into a privilege escalation.
 */
export interface SubagentAutonomyContext {
  workspacePermissionMode?: PermissionMode;
  parentPermissionMode?: PermissionMode;
  externalActionPolicy?: ExternalActionPolicy;
}

export interface ResolveSubagentAutonomyInput extends SubagentAutonomyContext {
  /** Explicit child/profile request. Omission inherits only a fully opted-in Execute parent. */
  requestedPermissionMode?: PermissionMode;
}

export interface SubagentAutonomyDecision {
  /** Parent when present, otherwise workspace, otherwise the fail-closed default. */
  authorityPermissionMode: PermissionMode;
  permissionMode: PermissionMode;
  /**
   * True only for the deliberate two-key opt-in. Callers may use the ordinary
   * session tool surface (rather than the restrictive Task isolation envelope)
   * only while this flag is true.
   */
  grantsFullToolAndNetworkAccess: boolean;
  reason:
    | 'explicit-safe'
    | 'parent-safe'
    | 'explicit-ask'
    | 'parent-ask'
    | 'external-actions-confirmed'
    | 'inherited-full-autonomy'
    | 'strict-default';
}

/**
 * Resolve child autonomy without ever escalating above its effective parent.
 *
 * Full autonomy has two independent keys:
 *   1. parent/workspace authority is Execute (`allow-all`), and
 *   2. the workspace explicitly opts into `allow-in-execute` external actions.
 *
 * An explicit child `safe`/`ask` remains stricter than its parent. Missing
 * configuration is `safe`, including a missing external-action policy.
 */
export function resolveSubagentAutonomy(
  input: ResolveSubagentAutonomyInput,
): SubagentAutonomyDecision {
  const authorityPermissionMode =
    input.parentPermissionMode ?? input.workspacePermissionMode ?? 'safe';

  if (input.requestedPermissionMode === 'safe') {
    return {
      authorityPermissionMode,
      permissionMode: 'safe',
      grantsFullToolAndNetworkAccess: false,
      reason: 'explicit-safe',
    };
  }
  if (input.requestedPermissionMode === undefined) {
    if (
      authorityPermissionMode === 'allow-all'
      && input.externalActionPolicy === 'allow-in-execute'
    ) {
      return {
        authorityPermissionMode,
        permissionMode: 'allow-all',
        grantsFullToolAndNetworkAccess: true,
        reason: 'inherited-full-autonomy',
      };
    }
    return {
      authorityPermissionMode,
      permissionMode: 'safe',
      grantsFullToolAndNetworkAccess: false,
      reason: 'strict-default',
    };
  }
  if (authorityPermissionMode === 'safe') {
    return {
      authorityPermissionMode,
      permissionMode: 'safe',
      grantsFullToolAndNetworkAccess: false,
      reason: 'parent-safe',
    };
  }
  if (input.requestedPermissionMode === 'ask') {
    return {
      authorityPermissionMode,
      permissionMode: 'ask',
      grantsFullToolAndNetworkAccess: false,
      reason: 'explicit-ask',
    };
  }
  if (authorityPermissionMode === 'ask') {
    return {
      authorityPermissionMode,
      permissionMode: 'ask',
      grantsFullToolAndNetworkAccess: false,
      reason: 'parent-ask',
    };
  }
  if (input.externalActionPolicy !== 'allow-in-execute') {
    return {
      authorityPermissionMode,
      permissionMode: input.requestedPermissionMode === 'allow-all' ? 'ask' : 'safe',
      grantsFullToolAndNetworkAccess: false,
      reason: input.requestedPermissionMode === 'allow-all'
        ? 'external-actions-confirmed'
        : 'strict-default',
    };
  }

  return {
    authorityPermissionMode,
    permissionMode: 'allow-all',
    grantsFullToolAndNetworkAccess: true,
    reason: 'inherited-full-autonomy',
  };
}
