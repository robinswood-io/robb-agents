import { loadWorkspaceConfig } from "@craft-agent/shared/workspaces";
import type { ManagedSession } from "../managed-session.ts";
import { isSourceActivationOriginCurrent, rememberAutoRetryTombstone } from "../source-activation.ts";
import { refreshInheritedSessionSourceSelection } from "../source-selection.ts";

/**
   * Reload sources for a session with an active agent.
   * Called by ConfigWatcher when source files change on disk.
   * If agent is null (session hasn't sent any messages), skip - fresh build happens on next message.
   */
export function refreshInheritedWorkspaceSources(
    managed: ManagedSession,
    workspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath),
  ): boolean {
    return refreshInheritedSessionSourceSelection(
      managed,
      workspaceConfig?.defaults?.enabledSourceSlugs,
    )
  }

/** A persisted source restart is authority only for the exact active root and
   * direct-user revision that minted it. Text, queue position and the origin
   * kind alone are deliberately insufficient. */
export function isExactQueuedSourceActivation(
    managed: ManagedSession,
    item: ManagedSession['messageQueue'][number],
  ): boolean {
    const origin = item.options?.internalOrigin
    if (!item.messageId || item.options?.hidden !== true
      || !isSourceActivationOriginCurrent(managed.activeObjective, origin)) return false
    const matches = managed.messages.filter(message => message.id === item.messageId)
    const saved = matches[0]
    return matches.length === 1 && saved?.role === 'user' && saved.hidden === true
      && saved.isQueued === true && !saved.isPending && !saved.agentDelivery
      && saved.content === item.message
      && saved.internalOrigin?.kind === 'source-activation'
      && saved.internalOrigin.objectiveId === origin.objectiveId
      && saved.internalOrigin.objectiveRevision === origin.objectiveRevision
      && saved.internalOrigin.sourceSlug === origin.sourceSlug
      && saved.internalOrigin.sourceActivationId === origin.sourceActivationId
  }

export function cancelSourceActivationPending(
    managed: ManagedSession,
    pending = managed.autoRetryPending,
  ): boolean {
    if (!pending) return false
    const changed = !pending.cancelled || !pending.committed || pending.dispatchInFlight
      || managed.autoRetryTimer !== undefined
    if (managed.autoRetryTimer) clearTimeout(managed.autoRetryTimer)
    managed.autoRetryTimer = undefined
    pending.cancelled = true
    pending.committed = true
    pending.dispatchInFlight = false
    rememberAutoRetryTombstone(managed, pending.content, Date.now(), pending.tombstoneExpiresAt)
    return changed
  }

export function commitSourceActivationPending(
    managed: ManagedSession,
    dispatchToken: symbol | undefined,
    messageId: string,
  ): boolean {
    const pending = managed.autoRetryPending
    if (!pending || pending.dispatchToken !== dispatchToken || pending.cancelled
      || !pending.dispatchInFlight) return false
    pending.messageId = messageId
    pending.committed = true
    pending.dispatchInFlight = false
    rememberAutoRetryTombstone(managed, pending.content, Date.now(), pending.tombstoneExpiresAt)
    return true
  }

export function releaseSourceActivationClaim(
    managed: ManagedSession,
    dispatchToken: symbol | undefined,
  ): void {
    const pending = managed.autoRetryPending
    if (pending && pending.dispatchToken === dispatchToken && !pending.committed && !pending.cancelled) {
      pending.dispatchInFlight = false
      pending.messageId = undefined
    }
  }
