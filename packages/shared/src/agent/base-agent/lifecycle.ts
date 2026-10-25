import type { PostInitResult } from "../backend/types.ts";
import { AbortReason } from "../backend/types.ts";
import type { BaseAgent } from '../base-agent.ts';

// ============================================================
  // Lifecycle (postInit)
  // ============================================================

  /**
   * Post-construction initialization.
   * Default: no-op (auth already handled for Claude/Pi API-key).
   * Override in backends that need post-construction auth injection.
   */
export async function postInit(transportOwner: BaseAgent): Promise<PostInitResult> {
    return { authInjected: true };
}

/**
   * Ensure branch sessions are backend-ready before first user message.
   * Default implementation is a no-op.
   */
export async function ensureBranchReady(transportOwner: BaseAgent): Promise<void> {
    // No-op by default
}

// ============================================================
  // Cleanup (common base, subclasses extend)
  // ============================================================

  /**
   * Alias for destroy() for consistency.
   */
export function dispose(transportOwner: BaseAgent): void {
    transportOwner["destroy"]();
}

/**
   * Base cleanup - clears common resources.
   * Subclasses MUST call super.destroy() and add provider-specific cleanup.
   */
export function destroy(transportOwner: BaseAgent): void {
    transportOwner["stopConfigWatcher"]();
    transportOwner["permissionManager"].clearWhitelists();
    transportOwner["sourceManager"].resetSeenSources();
    transportOwner["usageTracker"].reset();
    // Disconnect MCP pool to avoid connection leaks
    if (transportOwner["config"].mcpPool) {
        transportOwner["config"].mcpPool.disconnectAll().catch(err => {
            transportOwner["debug"](`Failed to disconnect MCP pool: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
    transportOwner["debug"]('Base agent destroyed');
}

/**
   * Interrupt the current turn because control is being handed to the UI.
   *
   * Default implementation delegates to forceAbort(); backends can override
   * when handoff semantics differ from hard abort semantics.
   */
export function interruptForHandoff(transportOwner: BaseAgent, reason: AbortReason): void {
    transportOwner["forceAbort"](reason);
}

/**
   * Redirect the agent mid-stream. Default: abort and let session layer re-send.
   * Override in backends that support native steering (e.g., Pi's steer()).
   */
export function redirect(transportOwner: BaseAgent, _message: string): boolean {
    transportOwner["forceAbort"](AbortReason.Redirect);
    return false;
}

/**
   * Get a bound summarize callback for passing to API tool builders.
   * This allows MCP servers to summarize using the agent's auth infrastructure.
   */
export function getSummarizeCallback(transportOwner: BaseAgent): (prompt: string) => Promise<string | null> {
    return async (prompt) => (await transportOwner["queryLlm"]({ prompt })).text;
}
