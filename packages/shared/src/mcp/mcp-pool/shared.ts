/**
 * Centralized MCP Client Pool
 *
 * Owns all MCP source connections in the main Electron process.
 * All backends (Claude, Pi) receive proxy tool definitions
 * and route tool calls through this pool instead of managing MCP connections
 * themselves.
 *
 * Benefits:
 * - One MCP code path for all backends
 * - Shared clients across sessions (e.g., same Linear connection)
 * - No credential cache files — main process has direct access
 * - Runtime source switching without session restart
 */
import { type McpClientConfig } from "../client.ts";
import type { SdkMcpServerConfig } from "../../agent/backend/types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Configuration for an in-process API source server.
 * Used by sync() to connect API sources alongside MCP sources.
 */
export interface ApiServerConfig {
    type: 'sdk';
    instance: McpServer;
}

/**
 * Proxy tool definition — the format passed to backends for registration.
 * Uses mcp__{slug}__{toolName} naming convention.
 */
export interface ProxyToolDef {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    readOnly?: boolean;
    idempotent?: boolean;
    destructive?: boolean;
    openWorld?: boolean;
}

/** Capability hints reported by an MCP server. They are untrusted by default. */
export interface ProxyToolCapabilities {
    readOnly?: boolean;
    idempotent?: boolean;
    destructive?: boolean;
    openWorld?: boolean;
    /** Only host-owned manifests may set this. Remote MCP annotations never do. */
    trusted?: boolean;
}

/**
 * Result of an MCP tool call, matching the subprocess protocol format.
 */
export interface McpToolResult {
    content: string;
    isError: boolean;
    /** Typed MCP output retained for hosts that support structured tool results. */
    structuredContent?: Record<string, unknown>;
    /** Source slug for error attribution (set on failure) */
    sourceSlug?: string;
}

/**
 * Host-owned fence evaluated immediately before a source client is invoked.
 * The callback must not mutate source/authentication state; governed runtimes
 * use it to attest the exact live credential generation consumed by the call.
 */
export type BeforeSourceToolExecution = (input: {
    sourceSlug: string;
    toolName: string;
    /** Exact arguments that will be sent after this final host-owned fence. */
    args: Readonly<Record<string, unknown>>;
    /** Untrusted remote hints; authorization must never rely on them alone. */
    capabilities?: ProxyToolCapabilities;
}) => Promise<void> | void;

export const LLM_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export const LLM_TOOL_NAME_MAX_LENGTH = 128;

export function normalizeInputSchema(inputSchema: Record<string, unknown> | undefined): Record<string, unknown> {
    // AJV consumers used by some backends reject unknown meta-schema URIs.
    const { $schema, ...cleanSchema } = inputSchema || {};
    return Object.keys(cleanSchema).length > 0 ? cleanSchema : { type: 'object', properties: {} };
}

export function normalizeStructuredContent(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

export function sanitizeToolNamePart(value: string): string {
    const sanitized = value.replace(/[^A-Za-z0-9_-]/g, '_');
    return sanitized.length > 0 ? sanitized : 'tool';
}

export function truncateWithSuffix(base: string, suffix: string): string {
    return `${base.slice(0, LLM_TOOL_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
}

export function buildSafeProxyToolName(slug: string, originalName: string, usedNames: Set<string>): string {
    const safeSlug = sanitizeToolNamePart(slug);
    const safeTool = sanitizeToolNamePart(originalName);
    let baseName = `mcp__${safeSlug}__${safeTool}`;
    if (baseName.length > LLM_TOOL_NAME_MAX_LENGTH) {
        baseName = baseName.slice(0, LLM_TOOL_NAME_MAX_LENGTH);
    }
    let candidate = baseName;
    let counter = 2;
    while (usedNames.has(candidate) || !LLM_TOOL_NAME_PATTERN.test(candidate)) {
        const suffix = `_${counter}`;
        candidate = truncateWithSuffix(baseName, suffix);
        counter++;
    }
    return candidate;
}

export const OUTPUT_BOUND_FIELD = /^(?:limit|maxResults|max_results|pageSize|page_size|count|top|fields|select|from|to|start|end|since|until)$/i;

export function withOutputBudgetGuidance(description: string, toolName: string, inputSchema: Record<string, unknown>): string {
    const properties = inputSchema.properties;
    const controls = properties && typeof properties === 'object' && !Array.isArray(properties)
        ? Object.keys(properties as Record<string, unknown>).filter(key => OUTPUT_BOUND_FIELD.test(key)).slice(0, 6)
        : [];
    const guidance: string[] = [];
    if (controls.length > 0) {
        guidance.push(`Output budget: set ${controls.join(', ')} to the smallest range or projection sufficient for the next decision; expand only if evidence is missing.`);
    }
    if (/ssh.*(?:execute|command)|(?:execute|command).*ssh/i.test(toolName)) {
        guidance.push('Remote efficiency: combine related read-only diagnostics and bound stdout with server-side filters, head, or tail. Prefer sync/worktree tools when several files must move.');
    }
    return guidance.length > 0 ? `${description}\n\n${guidance.join(' ')}` : description;
}

/**
 * Convert SdkMcpServerConfig (used by backend types) to CraftMcpClient config.
 */
export function sdkConfigToClientConfig(config: SdkMcpServerConfig): McpClientConfig | null {
    if (config.type === 'http' || config.type === 'sse') {
        return {
            transport: 'http',
            url: config.url,
            headers: config.headers,
        };
    }
    if (config.type === 'stdio') {
        return {
            transport: 'stdio',
            command: config.command,
            args: config.args,
            env: config.env,
        };
    }
    return null;
}

/**
 * Check if an MCP source's config has changed in a way that requires reconnection.
 * Compares auth headers (token refresh) and URL changes.
 * Ignores stdio sources since they don't use OAuth tokens.
 */
export function mcpConfigChanged(oldConfig: SdkMcpServerConfig, newConfig: SdkMcpServerConfig): boolean {
    if (oldConfig.type !== newConfig.type)
        return true;
    if ((oldConfig.type === 'http' || oldConfig.type === 'sse') &&
        (newConfig.type === 'http' || newConfig.type === 'sse')) {
        if (oldConfig.url !== newConfig.url)
            return true;
        const oldAuth = oldConfig.headers?.['Authorization'];
        const newAuth = newConfig.headers?.['Authorization'];
        if (oldAuth !== newAuth)
            return true;
    }
    return false;
}
