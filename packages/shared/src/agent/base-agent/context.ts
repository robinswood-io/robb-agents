import type { RecoveryMessage } from "../backend/types.ts";
import { getSessionPath } from "../../sessions/storage.ts";
import { getMiniAgentSystemPrompt } from "../../prompts/system.ts";
import type { BaseAgent } from '../base-agent.ts';
import { MINI_AGENT_TOOLS, MINI_AGENT_MCP_KEYS } from './shared.ts';
import type { MiniAgentConfig } from './shared.ts';

// ============================================================
  // Mini Agent Mode (centralized for all backends)
  // ============================================================

  /**
   * Check if running in mini agent mode.
   * Centralized detection used by all backends.
   */
export function isMiniAgent(transportOwner: BaseAgent): boolean {
    return transportOwner["config"].systemPromptPreset === 'mini';
}

/**
   * Get mini agent configuration for provider-specific application.
   * Returns centralized config that each backend interprets appropriately:
   * - ClaudeAgent: Uses tools array, mcpServers filter, maxThinkingTokens: 0
   * - PiAgent: Applies tool filter + minimizeThinking via runtime config
   */
export function getMiniAgentConfig(transportOwner: BaseAgent): MiniAgentConfig {
    const enabled = transportOwner["isMiniAgent"]();
    return {
        enabled,
        tools: enabled ? MINI_AGENT_TOOLS : [],
        mcpServerKeys: enabled ? MINI_AGENT_MCP_KEYS : [],
        minimizeThinking: enabled,
    };
}

/**
   * Get the mini agent system prompt.
   * Shared across backends for consistency.
   * Uses workspace root path for config file locations.
   */
export function getMiniSystemPrompt(transportOwner: BaseAgent): string {
    return getMiniAgentSystemPrompt(transportOwner["config"].workspace.rootPath);
}

/**
   * Filter MCP servers for mini agent mode.
   * Only includes servers whose keys are in the allowed list.
   *
   * @param servers - Full set of MCP servers
   * @param allowedKeys - Keys to include (from getMiniAgentConfig().mcpServerKeys)
   * @returns Filtered servers object
   */
export function filterMcpServersForMiniAgent<T>(_transportOwner: BaseAgent, servers: Record<string, T>, allowedKeys: readonly string[]): Record<string, T> {
    const filtered: Record<string, T> = {};
    for (const key of allowedKeys) {
        if (servers[key]) {
            filtered[key] = servers[key];
        }
    }
    return filtered;
}

// ============================================================
  // Session Recovery (unified across backends)
  // ============================================================

  /**
   * Build recovery context from previous messages when session resume fails.
   * Called when we detect an empty response or thread not found during resume.
   * Injects previous conversation context so the agent can continue naturally.
   *
   * @returns Formatted string to prepend to the user message, or null if no context available.
   */
export function buildRecoveryContext(transportOwner: BaseAgent): string | null {
    const messages = transportOwner["config"].getRecoveryMessages?.();
    if (!messages || messages.length === 0) {
        return null;
    }
    // Format messages as a conversation block the agent can understand
    const formattedMessages = messages
        .map((m) => {
        const role = m.type === 'user' ? 'User' : 'Assistant';
        // Truncate very long messages to avoid bloating context (max ~1000 chars each)
        const content = m.content.length > 1000
            ? m.content.slice(0, 1000) + '...[truncated]'
            : m.content;
        return `[${role}]: ${content}`;
    })
        .join('\n\n');
    return `<conversation_recovery>
This session was interrupted and is being restored. Here is the recent conversation context:

${formattedMessages}

Please continue the conversation naturally from where we left off.
</conversation_recovery>

`;
}

/**
   * Build one-time branch seed context for sessions branched from an earlier message.
   * Ensures the first turn in the new branch only sees transcript up to the selected branch point.
   */
export function buildBranchSeedContext(_transportOwner: BaseAgent, messages?: RecoveryMessage[]): string | null {
    if (!messages || messages.length === 0)
        return null;
    // Keep seed payload bounded to avoid oversized first-turn prompts.
    const bounded = messages.slice(-24);
    const formattedMessages = bounded
        .map((m) => {
        const role = m.type === 'user' ? 'User' : 'Assistant';
        const content = m.content.length > 1200
            ? m.content.slice(0, 1200) + '...[truncated]'
            : m.content;
        return `[${role}]: ${content}`;
    })
        .join('\n\n');
    return `<branch_seed_context>
This is a branched conversation. The context below is the parent transcript up to the selected branch point.
Ignore and do not assume any parent messages that came after this cutoff.

${formattedMessages}
</branch_seed_context>`;
}

/**
   * Clear session ID and notify callbacks.
   * Called when session resume fails and we need to start fresh.
   */
export function clearSessionForRecovery(transportOwner: BaseAgent): void {
    transportOwner["config"].onSdkSessionIdCleared?.();
    transportOwner["debug"]('Session cleared for recovery');
}

// ============================================================
  // Path Helpers
  // ============================================================

  /**
   * Get the session storage path for this agent's session.
   * Convenience wrapper around getSessionPath() with null-checking.
   *
   * @returns Session path, or undefined if session/workspace not configured
   */
export function getSessionStoragePath(transportOwner: BaseAgent): string | undefined {
    if (!transportOwner["config"].session?.id || !transportOwner["config"].workspace.rootPath)
        return undefined;
    return getSessionPath(transportOwner["config"].workspace.rootPath, transportOwner["config"].session.id);
}
