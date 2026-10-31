import { SPAWN_SESSION_ROLE_HELP, type parseSpawnSessionInput } from "@craft-agent/session-tools-core";

// ============================================================
// Mini Agent Configuration
// ============================================================
/**
 * Mini agent configuration - shared across all backends.
 * Centralized here to avoid duplication between Claude/Codex agents.
 */
export interface MiniAgentConfig {
    /** Whether mini agent mode is enabled */
    enabled: boolean;
    /** Allowed tools for mini agent mode */
    tools: readonly string[];
    /** MCP server keys to include (others filtered out) */
    mcpServerKeys: readonly string[];
    /** Thinking/reasoning should be minimized */
    minimizeThinking: boolean;
}

// ============================================================
// Spawn Session Types
// ============================================================
/** Validated tool input shared by both backends; prompt is required after help dispatch. */
export type SpawnSessionRequest = Omit<ReturnType<typeof parseSpawnSessionInput>, 'prompt'> & {
    prompt: string;
};

export interface SpawnSessionResult {
    sessionId: string;
    name: string;
    status: 'started';
    /** True when the identical request already owns an active child. */
    reused?: boolean;
    connection?: string;
    model?: string;
}

export interface SpawnSessionHelpResult {
    roleHelp: typeof SPAWN_SESSION_ROLE_HELP;
    sources: Array<{
        slug: string;
        name: string;
        type: string;
        enabled: boolean;
    }>;
    defaults: {
        permissionMode: string;
    };
}

/** Tool list for mini agents - quick config edits only */
export const MINI_AGENT_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'] as const;

/** MCP servers for mini agents - minimal set (docs tools are now bundled in session) */
export const MINI_AGENT_MCP_KEYS = ['session'] as const;
