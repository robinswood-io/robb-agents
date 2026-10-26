import { jsonSchemaToZodShape } from "./schema";
import { createSdkMcpServer, tool, type Options } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { type MiniAgentConfig } from "../base-agent.ts";
import { type BackendConfig } from "../backend/types.ts";
import { type DiagnosticCode } from "../diagnostics.ts";
import { type Workspace } from "../../config/storage.ts";
import type { McpClientPool, McpToolResult } from "../../mcp/mcp-pool.ts";
import { type SessionConfig as Session } from "../../sessions/storage.ts";
import { isClaudeModel, isAdaptiveThinkingAlwaysOnModel } from "../../config/models.ts";
import type { FileAttachment } from "../../utils/files.ts";
import { type AutomationSystem } from "../../automations/index.ts";
// Centralized PreToolUse pipeline
// Centralized PreToolUse pipeline
import { beginContextualGmailHostExecution, settleContextualGmailHostExecution } from "../core/pre-tool-use.ts";
import { type ThinkingLevel, THINKING_TO_EFFORT, getThinkingTokens } from "../thinking-levels.ts";
// Claude event adapter — extracts SDK message → AgentEvent conversion into testable class
// Claude event adapter — extracts SDK message → AgentEvent conversion into testable class
import { buildWindowsSkillsDirError as buildWindowsSkillsDirErrorFn } from "../backend/claude/event-adapter.ts";
// Import and re-export AbortReason and RecoveryMessage from core module (single source of truth)
// Re-exported for backwards compatibility with existing imports from claude-agent.ts
// Import and re-export AbortReason and RecoveryMessage from core module (single source of truth)
// Re-exported for backwards compatibility with existing imports from claude-agent.ts
import { type RecoveryMessage } from "../core/index.ts";

// Local type for SDK user message content blocks (text, image, document)
// Replaces import from @anthropic-ai/sdk/resources — keeps SDK as agent-only dependency
export type ContentBlockParam = {
    type: 'text';
    text: string;
} | {
    type: 'image';
    source: {
        type: 'base64';
        media_type: string;
        data: string;
    };
} | {
    type: 'document';
    source: {
        type: 'base64';
        media_type: string;
        data: string;
    };
};

/**
 * Only infrastructure-shaped Claude subprocess failures enter automatic turn
 * recovery. Credentials, billing, rate limits, and invalid input remain
 * terminal so a process relaunch cannot create a hot retry loop.
 */
export function shouldAutomaticallyRecoverClaudeProcessInterruption(code: DiagnosticCode): boolean {
    return code === 'service_unavailable'
        || code === 'mcp_unreachable'
        || code === 'unknown_error';
}

/** Image extensions that may need size-guard in PreToolUse (matches Read tool's image detection) */
export const IMAGE_READ_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff']);

/** File extensions that can be converted to readable text by CLI tools. */
export const CONVERTIBLE_FILE_HINTS: Record<string, string> = {
    pdf: 'markitdown or pdf-tool extract',
    docx: 'markitdown', xlsx: 'markitdown or xlsx-tool read', pptx: 'markitdown or pptx-tool extract',
    doc: 'markitdown', xls: 'markitdown', ppt: 'markitdown',
    msg: 'markitdown', eml: 'markitdown', rtf: 'markitdown',
    ics: 'ical-tool read',
};

export function resolveClaudeThinkingOptions(args: {
    thinkingLevel: ThinkingLevel;
    model: string;
    providerType?: BackendConfig['providerType'];
    minimizeThinking: boolean;
}): Partial<Options> {
    const { thinkingLevel, model, providerType, minimizeThinking } = args;
    const isClaude = isClaudeModel(model);
    const effort = THINKING_TO_EFFORT[thinkingLevel];
    const isHaiku = model.toLowerCase().includes('haiku');
    const supportsAdaptiveThinking = isClaude && !isHaiku;
    // Mythos-class models (Fable 5 / Mythos 5) have adaptive thinking ALWAYS ON and
    // reject `thinking: { type: 'disabled' }`. There's no way to turn thinking off;
    // the lowest we can go is adaptive + 'low' effort.
    const adaptiveAlwaysOn = isAdaptiveThinkingAlwaysOnModel(model);
    if (minimizeThinking || !isClaude || !effort) {
        if (adaptiveAlwaysOn) {
            return { thinking: { type: 'adaptive' as const }, effort: 'low' as const };
        }
        return supportsAdaptiveThinking
            ? { thinking: { type: 'disabled' as const } }
            : { maxThinkingTokens: 0 };
    }
    if (supportsAdaptiveThinking) {
        return {
            thinking: { type: 'adaptive' as const },
            effort,
        };
    }
    return {
        maxThinkingTokens: getThinkingTokens(thinkingLevel, model),
    };
}

/** Remove a model-authored nested-route override before the in-process
 * call_llm tool validates its model enum. The public selected-model contract
 * active session route is authoritative, including for unknown override IDs. */
export function resolveClaudeCallLlmInterceptInput(input: Record<string, unknown>): Record<string, unknown> { const { model: _ignoredModelOverride, ...selectedInput } = input; return selectedInput; }

export function resolveClaudeNestedQueryModel(input: {
    activeModel: string;
    requestedModel?: string;
}): string { return input.activeModel; }

export function resolveClaudeMiniCompletionRoute(input: {
    activeModel: string;
    activeThinkingLevel: ThinkingLevel;
    providerType?: BackendConfig['providerType'];
}): {
    model: string;
    thinkingOptions: Partial<Options>;
} { return { model: input.activeModel, thinkingOptions: resolveClaudeThinkingOptions({ thinkingLevel: input.activeThinkingLevel, model: input.activeModel, providerType: input.providerType, minimizeThinking: false }) }; }

export interface ClaudeAgentConfig {
    workspace: Workspace;
    session?: Session; // Current session (primary isolation boundary)
    mcpToken?: string; // Override token (for testing)
    model?: string;
    thinkingLevel?: ThinkingLevel; // Initial thinking level (defaults to 'medium')
    /** Live host-owned manual model authority. */
    isModelRoutePinned?: () => boolean;
    onSdkSessionIdUpdate?: (sdkSessionId: string) => void; // Callback when SDK session ID is captured
    onSdkSessionIdCleared?: () => void; // Callback when SDK session ID is cleared (e.g., after failed resume)
    /**
     * Callback when branch-fork metadata is invalidated (parent cwd missing on this machine,
     * or SDK fork spawn failed). Clears branchFromSdk* + sdkSessionId atomically.
     * See BackendConfig.onBranchForkInvalidated for details.
     */
    onBranchForkInvalidated?: () => void;
    /**
     * Callback to get recent messages for recovery context.
     * Called when SDK resume fails and we need to inject previous conversation context into retry.
     * Returns last N user/assistant message pairs for context injection.
     */
    getRecoveryMessages?: () => RecoveryMessage[];
    /** All parent messages for branch fork fallback (summarized with the selected session model). */
    getBranchFallbackMessages?: () => RecoveryMessage[];
    /** Branch seed messages for seeded-fresh-session context strategy. */
    getBranchSeedMessages?: () => RecoveryMessage[];
    /** Mark branch seed as applied (called after first injection). */
    markBranchSeedApplied?: () => void;
    /** Get transferred session summary for cross-server session context. */
    getTransferredSessionSummary?: () => string | null;
    /** Mark transferred session summary as applied. */
    markTransferredSessionSummaryApplied?: () => void;
    isHeadless?: boolean; // Running in headless mode (disables interactive tools)
    /** Skip agent-level config file watching (server already owns a workspace-level watcher) */
    skipConfigWatcher?: boolean;
    debugMode?: {
        enabled: boolean; // Whether debug mode is active
        logFilePath?: string; // Path to the log file for querying
    };
    /** System prompt preset for mini agents ('default' | 'mini' or custom string) */
    systemPromptPreset?: 'default' | 'mini' | string;
    /** Workspace-level AutomationSystem instance (shared across all agents in the workspace) */
    automationSystem?: AutomationSystem;
    /**
     * Per-session environment variable overrides for the SDK subprocess.
     * Used to pass connection-specific config like ANTHROPIC_BASE_URL that
     * must not be clobbered by concurrent sessions.
     */
    envOverrides?: Record<string, string>;
    /** Utility model for title/icon metadata generation only. */
    miniModel?: string;
    /** Centralized MCP client pool for source tool execution. */
    mcpPool?: McpClientPool;
    /** LLM connection slug for credential lookup in postInit(). */
    connectionSlug?: string;
    /** Enable 1M context window for current Opus models. Default: true. Set false to use 200K and conserve usage limits. */
    enable1MContext?: boolean;
}

// Permission request tracking
export interface PendingPermission {
    resolve: (allowed: boolean, alwaysAllow?: boolean) => void;
    toolName: string;
    command: string;
    baseCommand: string;
    type?: 'bash' | 'safe_mode'; // Type of permission request
}

// Dangerous commands that should always require permission (never auto-allow)
export const DANGEROUS_COMMANDS = new Set([
    'rm', 'rmdir', 'sudo', 'su', 'chmod', 'chown', 'chgrp',
    'mv', 'cp', 'dd', 'mkfs', 'fdisk', 'parted',
    'kill', 'killall', 'pkill',
    'reboot', 'shutdown', 'halt', 'poweroff',
    'curl', 'wget', 'ssh', 'scp', 'rsync',
    'git push', 'git reset', 'git rebase', 'git checkout',
]);

// ============================================================
// Global Tool Permission System
// Used by both bash commands (via agent instance) and MCP tools (via global functions)
// ============================================================
export interface GlobalPendingPermission {
    resolve: (allowed: boolean) => void;
    toolName: string;
    command: string;
}

export const globalPendingPermissions = new Map<string, GlobalPendingPermission>();

// Handler set by application to receive permission requests
export let globalPermissionHandler: ((request: {
    requestId: string;
    toolName: string;
    command: string;
    description: string;
}) => void) | null = null;

/**
 * Set the global permission request handler (called by application)
 */
export function setGlobalPermissionHandler(handler: ((request: {
    requestId: string;
    toolName: string;
    command: string;
    description: string;
}) => void) | null): void {
    globalPermissionHandler = handler;
}

/**
 * Request permission for a tool operation (used by MCP tools)
 * Returns a promise that resolves to true if allowed, false if denied
 */
export function requestToolPermission(toolName: string, command: string, description: string): Promise<boolean> {
    return new Promise((resolve) => {
        const requestId = `perm-${toolName}-${Date.now()}`;
        globalPendingPermissions.set(requestId, {
            resolve,
            toolName,
            command,
        });
        if (globalPermissionHandler) {
            globalPermissionHandler({ requestId, toolName, command, description });
        }
        else {
            // No handler - deny by default
            globalPendingPermissions.delete(requestId);
            resolve(false);
        }
    });
}

/**
 * Resolve a pending global permission request (called by application)
 */
export function resolveGlobalPermission(requestId: string, allowed: boolean): void {
    const pending = globalPendingPermissions.get(requestId);
    if (pending) {
        pending.resolve(allowed);
        globalPendingPermissions.delete(requestId);
    }
}

/**
 * Clear all pending global permissions (called on workspace switch)
 */
export function clearGlobalPermissions(): void {
    globalPendingPermissions.clear();
}

/**
 * Create one SDK MCP server per connected source, using original tool names.
 * The SDK adds its own `mcp__{serverKey}__` prefix, so we use the source slug
 * as the server key and original tool names to get the correct final names
 * (e.g., `mcp__linear__createIssue`).
 */
export interface SourceProxyGmailLifecycleContext {
    sessionId: string;
    runtimeId: string;
}

export interface SourceProxyExecutionGuard {
    begin(toolName: string, args: Record<string, unknown>): string | undefined;
    settle(toolUseId: string): void;
}

/** Execute a source proxy behind the host-owned Gmail exact-once boundary. */
export async function executeSourceProxyCall(pool: Pick<McpClientPool, 'callTool'>, proxyName: string, args: Record<string, unknown>, gmailLifecycle: SourceProxyGmailLifecycleContext, executionGuard?: SourceProxyExecutionGuard): Promise<McpToolResult> {
    const admittedToolUseId = executionGuard?.begin(proxyName, args);
    if (executionGuard && !admittedToolUseId) {
        return {
            content: 'The host did not find one exact current PreToolUse admission for this source tool. The tool was not executed.',
            isError: true,
        };
    }
    const hostExecution = beginContextualGmailHostExecution({
        sessionId: gmailLifecycle.sessionId,
        runtimeId: gmailLifecycle.runtimeId,
        toolName: proxyName,
        toolInput: args,
    });
    if (hostExecution.applies && !hostExecution.allowed) {
        if (admittedToolUseId)
            executionGuard?.settle(admittedToolUseId);
        return { content: hostExecution.reason, isError: true };
    }
    const ticket = hostExecution.applies && hostExecution.allowed
        ? hostExecution.ticket
        : undefined;
    try {
        return await pool.callTool(proxyName, args);
    }
    finally {
        if (admittedToolUseId)
            executionGuard?.settle(admittedToolUseId);
        if (ticket)
            settleContextualGmailHostExecution(ticket);
    }
}

export function createSourceProxyServers(pool: McpClientPool, gmailLifecycle: SourceProxyGmailLifecycleContext, executionGuard: SourceProxyExecutionGuard): Record<string, ReturnType<typeof createSdkMcpServer>> {
    const servers: Record<string, ReturnType<typeof createSdkMcpServer>> = {};
    for (const slug of pool.getConnectedSlugs()) {
        const mcpTools = pool.getTools(slug);
        if (mcpTools.length === 0)
            continue;
        const proxyTools = mcpTools.flatMap(mcpTool => {
            const proxyName = pool.getProxyToolName(slug, mcpTool.name);
            const proxyLocalName = pool.getProxyToolLocalName(slug, mcpTool.name);
            if (!proxyName || !proxyLocalName)
                return [];
            return tool(proxyLocalName, mcpTool.description || `Tool from ${slug}`, {
                ...jsonSchemaToZodShape((mcpTool.inputSchema as Record<string, unknown>) || {}),
                ...z.object({}).catchall(z.unknown()).shape,
            }, async (args: Record<string, unknown>) => {
                const result = await executeSourceProxyCall(pool, proxyName, args, gmailLifecycle, executionGuard);
                return {
                    content: [{ type: 'text' as const, text: result.content }],
                    ...(result.isError ? { isError: true } : {}),
                    ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
                };
            }, mcpTool.annotations && Object.values(mcpTool.annotations).some(value => value !== undefined)
                ? { annotations: { ...mcpTool.annotations } }
                : undefined);
        });
        servers[slug] = createSdkMcpServer({
            name: `source-proxy-${slug}`,
            version: '1.0.0',
            tools: proxyTools,
        });
    }
    return servers;
}

// buildWindowsSkillsDirError is now in backend/claude/event-adapter.ts (exported)
export const buildWindowsSkillsDirError = buildWindowsSkillsDirErrorFn;

export function createClaudeBackendConfig(config: ClaudeAgentConfig, model: string): BackendConfig {
    return {
        provider: 'anthropic',
        workspace: config.workspace,
        session: config.session,
        model,
        thinkingLevel: config.thinkingLevel,
        isModelRoutePinned: config.isModelRoutePinned,
        mcpToken: config.mcpToken,
        isHeadless: config.isHeadless,
        skipConfigWatcher: config.skipConfigWatcher,
        debugMode: config.debugMode,
        systemPromptPreset: config.systemPromptPreset,
        onSdkSessionIdUpdate: config.onSdkSessionIdUpdate,
        onSdkSessionIdCleared: config.onSdkSessionIdCleared,
        onBranchForkInvalidated: config.onBranchForkInvalidated,
        getRecoveryMessages: config.getRecoveryMessages,
        getBranchFallbackMessages: config.getBranchFallbackMessages,
        getBranchSeedMessages: config.getBranchSeedMessages,
        markBranchSeedApplied: config.markBranchSeedApplied,
        getTransferredSessionSummary: config.getTransferredSessionSummary,
        markTransferredSessionSummaryApplied: config.markTransferredSessionSummaryApplied,
        envOverrides: config.envOverrides,
        miniModel: config.miniModel,
        mcpPool: config.mcpPool,
        connectionSlug: config.connectionSlug,
        automationSystem: config.automationSystem,
    };
}

export interface ClaudeQueryPreparation {
    effectiveModel: string;
    thinkingOptions: ReturnType<typeof resolveClaudeThinkingOptions>;
    miniConfig: MiniAgentConfig;
    resolvedCwd: string;
    mcpServers: Options['mcpServers'];
    disallowedTools: string[];
}

export interface ClaudeQueryFailureContext {
    receivedAssistantContent: boolean;
    wasResuming: boolean;
    _isRetry: boolean;
    userMessage: string;
    attachments?: FileAttachment[];
    suppressedSessionExpiredError: boolean;
    suppressedBranchCutoffError: boolean;
    resolvedBinaryPath: Options['pathToClaudeCodeExecutable'];
    resolvedCwd: string;
}
