import { type Workspace } from "../../config/storage.ts";
// Centralized PreToolUse pipeline
// Centralized PreToolUse pipeline
import { invalidateContextualGmailSessionState } from "../core/pre-tool-use.ts";
import type { ClaudeAgent } from '../claude-agent.ts';

export function setWorkspace(transportOwner: ClaudeAgent, workspace: Workspace): void {
    transportOwner["denyAllPendingPermissions"]();
    const configSessionId = transportOwner["config"].session?.id;
    if (configSessionId)
        invalidateContextualGmailSessionState(configSessionId);
    transportOwner["teardownPersistentQuery"]('set-workspace');
    transportOwner["config"].workspace = workspace;
    // Clear session when switching workspaces - caller should set session separately if needed
    transportOwner["sessionId"] = null;
    // Note: MCP proxy needs to be reinitialized by the caller (useAgent hook)
}

/**
   * Update the working directory for this agent's session.
   * Called when user changes the working directory in the UI.
   */
export function updateWorkingDirectory(transportOwner: ClaudeAgent, path: string): void {
    if (transportOwner["config"].session) {
        transportOwner["config"].session.workingDirectory = path;
    }
}

// getMiniSystemPrompt() and filterMcpServersForMiniAgent() are inherited from BaseAgent
export function getWorkspace(transportOwner: ClaudeAgent): Workspace {
    return transportOwner["config"].workspace;
}
