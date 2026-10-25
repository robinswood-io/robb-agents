import { SPAWN_SESSION_ROLE_HELP } from "@craft-agent/session-tools-core";
import type { PermissionMode } from "../mode-manager.ts";

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
export interface SpawnSessionRequest {
    /** One-shot host capability injected after PreToolUse; never model authority. */
    _hostTerminalReconciliationCapability?: string;
    prompt: string;
    name?: string;
    enabledSourceSlugs?: string[];
    permissionMode?: PermissionMode;
    labels?: string[];
    workingDirectory?: string;
    /** Workspace project id to bind the spawned session to */
    projectId?: string;
    role?: 'worker' | 'reviewer';
    attachments?: Array<{
        path: string;
        name?: string;
    }>;
}

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
