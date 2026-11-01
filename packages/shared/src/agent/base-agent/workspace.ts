import type { Workspace } from "../../config/storage.ts";
import type { BaseAgent } from '../base-agent.ts';

// ============================================================
  // Workspace & Session (AgentBackend interface)
  // ============================================================
export function getWorkspace(transportOwner: BaseAgent): Workspace {
    return transportOwner["config"].workspace;
}

export function setWorkspace(transportOwner: BaseAgent, workspace: Workspace): void {
    transportOwner["config"].workspace = workspace;
    // Subclasses should clear session-specific state
}

export function setSessionId(transportOwner: BaseAgent, sessionId: string | null): void {
    transportOwner["_sessionId"] = sessionId || `agent-${Date.now()}`;
}

/**
   * Clear conversation history and start fresh.
   * Subclasses should override to clear provider-specific state.
   */
export function clearHistory(transportOwner: BaseAgent): void {
    transportOwner["usageTracker"].reset();
    transportOwner["resetPrerequisiteState"]();
    transportOwner["debug"]('History cleared');
}

/**
   * Reset prerequisite read state (e.g., on context compaction).
   * After compaction the LLM no longer has guide content in context,
   * so it must re-read before using source tools.
   * Also resets seen sources so guide paths re-appear in source introductions.
   */
export function resetPrerequisiteState(transportOwner: BaseAgent): void {
    transportOwner["prerequisiteManager"].resetReadState();
    transportOwner["sourceManager"].resetSeenSources();
}

/**
   * Update the working directory.
   * Also updates PermissionManager and persists to session config.
   */
export function updateWorkingDirectory(transportOwner: BaseAgent, path: string): void {
    transportOwner["workingDirectory"] = path;
    // Persist to session config for storage and consistency with ClaudeAgent
    if (transportOwner["config"].session) {
        transportOwner["config"].session.workingDirectory = path;
    }
    transportOwner["permissionManager"].updateWorkingDirectory(path);
    transportOwner["debug"](`Working directory updated: ${path}`);
}

/**
   * Update the SDK cwd (used for transcript storage location).
   *
   * This should only be called when it's safe to update - i.e., before any
   * SDK interaction has occurred. The SessionManager checks this condition
   * before calling this method.
   *
   * This updates the session config so the agent uses the new path for
   * SDK operations going forward.
   */
export function updateSdkCwd(transportOwner: BaseAgent, path: string): void {
    if (transportOwner["config"].session) {
        transportOwner["config"].session.sdkCwd = path;
    }
    transportOwner["debug"](`SDK cwd updated: ${path}`);
}
