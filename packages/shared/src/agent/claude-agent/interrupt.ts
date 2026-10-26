// Centralized PreToolUse pipeline
// Centralized PreToolUse pipeline
import { hasContextualGmailInFlightForRuntime, invalidateContextualGmailSessionState } from "../core/pre-tool-use.ts";
// Import and re-export AbortReason and RecoveryMessage from core module (single source of truth)
// Re-exported for backwards compatibility with existing imports from claude-agent.ts
// Import and re-export AbortReason and RecoveryMessage from core module (single source of truth)
// Re-exported for backwards compatibility with existing imports from claude-agent.ts
import { AbortReason } from "../core/index.ts";
import type { ClaudeAgent } from '../claude-agent.ts';

/**
   * Interrupt the current query because control is being handed to the UI.
   *
   * For Claude, handoff boundaries (auth requests, plan submission) should use
   * the SDK's cooperative interrupt path instead of aborting the underlying
   * AbortController mid-control-write.
   */
export function interruptForHandoff(transportOwner: ClaudeAgent, reason: AbortReason): void {
    const gmailRuntime = transportOwner["activeTurnGmailRuntime"] ?? (transportOwner["persistentGmailRuntimeId"] && transportOwner["persistentGmailSessionId"]
        ? {
            sessionId: transportOwner["persistentGmailSessionId"],
            runtimeId: transportOwner["persistentGmailRuntimeId"],
        }
        : null);
    if ((gmailRuntime && hasContextualGmailInFlightForRuntime(gmailRuntime))
        || transportOwner["hasAdmittedToolExecutions"]()) {
        // Cooperative interrupt keeps the SDK runtime alive and therefore cannot
        // prove that an admitted host call will never start. Use the confirmed
        // teardown path only for this exact unresolved mutation.
        transportOwner["forceAbort"](reason);
        return;
    }
    transportOwner["promptPreparationRevision"]++;
    transportOwner["revokeAdmittedToolExecutions"]();
    transportOwner["lastAbortReason"] = reason;
    transportOwner["denyAllPendingPermissions"]();
    if (!transportOwner["currentQuery"]) {
        return;
    }
    void transportOwner["currentQuery"].interrupt().catch((error) => {
        transportOwner["debug"](`Claude handoff interrupt failed: ${error instanceof Error ? error.message : String(error)}`);
    });
}

/**
   * Force-abort the current query using the SDK's AbortController.
   * This immediately stops processing (SIGTERM/SIGKILL) without waiting for graceful shutdown.
   * Use this when you need instant termination (e.g., queuing a new message).
   *
   * @param reason - Why the abort is happening (affects UI feedback)
   */
export function forceAbort(transportOwner: ClaudeAgent, reason: AbortReason): void {
    transportOwner["promptPreparationRevision"]++;
    transportOwner["revokeAdmittedToolExecutions"]();
    transportOwner["lastAbortReason"] = reason;
    const abortSessionIds = new Set<string>();
    if (transportOwner["activeTurnGmailRuntime"]?.sessionId) {
        abortSessionIds.add(transportOwner["activeTurnGmailRuntime"].sessionId);
    }
    if (transportOwner["persistentGmailSessionId"]) {
        abortSessionIds.add(transportOwner["persistentGmailSessionId"]);
    }
    if (abortSessionIds.size === 0 && transportOwner["config"]?.session?.id) {
        abortSessionIds.add(transportOwner["config"].session.id);
    }
    for (const sessionId of abortSessionIds) {
        // AbortController termination is asynchronous. Invalidate first so a
        // delayed SDK proxy callback cannot enter host execution after Stop.
        invalidateContextualGmailSessionState(sessionId);
    }
    transportOwner["denyAllPendingPermissions"]();
    if (transportOwner["persistentInput"] || transportOwner["persistentIterator"] || transportOwner["persistentAbortController"]) {
        transportOwner["teardownPersistentQuery"](`force-abort:${reason}`);
    }
    else if (transportOwner["currentQueryAbortController"]) {
        transportOwner["currentQueryAbortController"].abort(reason);
    }
    transportOwner["currentQueryAbortController"] = null;
    transportOwner["currentQuery"] = null;
}

/**
   * Claude has no native, acknowledged mid-turn redirect. Stop the old turn
   * before the host durably queues the complete new message and its authority.
   */
export function redirect(transportOwner: ClaudeAgent, _message: string): boolean {
    transportOwner["forceAbort"](AbortReason.Redirect);
    return false;
}

/**
   * Set source servers (user-defined sources)
   * These are MCP servers and API tools added via the source selector UI
   * @param mcpServers Pre-built MCP server configs with auth headers
   * @param apiServers In-process MCP servers for REST APIs
   * @param intendedSlugs Optional list of source slugs that should be considered active
   *                      (what the UI shows as active, even if build failed)
   */

  // isSourceServerActive, getActiveSourceServerNames, setAllSources, getAllSources, markSourceUnseen
  // are now inherited from BaseAgent and delegate to this.sourceManager

  // setTemporaryClarifications is now inherited from BaseAgent
export async function close(transportOwner: ClaudeAgent): Promise<void> {
    transportOwner["forceAbort"]();
}

// ============================================================
  // AgentBackend Interface Methods
  // ============================================================

  /**
   * Abort current query (async interface for AgentBackend compatibility).
   * Wraps forceAbort() in a Promise.
   */
export async function abort(transportOwner: ClaudeAgent, reason?: string): Promise<void> {
    transportOwner["forceAbort"]();
}

/**
   * Check if currently processing a query.
   */
export function isProcessing(transportOwner: ClaudeAgent): boolean {
    return transportOwner["currentQuery"] !== null;
}
