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
import { type PoolClient, type PoolTool } from "./client.ts";
import type { SdkMcpServerConfig } from "../agent/backend/types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JsonSchemaValidator } from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { createCollectionSummaryCallback, type CollectionCacheScope } from "./collection-cache.ts";
import { createHash } from "node:crypto";
import type { ApiServerConfig, ProxyToolDef, ProxyToolCapabilities, McpToolResult, BeforeSourceToolExecution } from './mcp-pool/shared.ts';
import * as mcpPoolConnection from './mcp-pool/connection.ts';
import * as mcpPoolProxy from './mcp-pool/proxy.ts';
import * as mcpPoolExecution from './mcp-pool/execution.ts';
export type { ApiServerConfig, ProxyToolDef, ProxyToolCapabilities, McpToolResult, BeforeSourceToolExecution } from './mcp-pool/shared.ts';

export class McpClientPool {
    /** Active MCP clients keyed by source slug */
    private clients = new Map<string, PoolClient>();
    /** Configs used for active MCP connections (for change detection during sync) */
    protected activeConfigs = new Map<string, SdkMcpServerConfig>();
    /** Cached tool lists keyed by source slug */
    private toolCache = new Map<string, PoolTool[]>();
    /** Proxy tool name → { slug, originalName } (e.g., "mcp__linear__createIssue" → { slug: "linear", originalName: "createIssue" }) */
    private proxyTools = new Map<string, {
        slug: string;
        originalName: string;
    }>();
    /** Source slug → original tool name → safe proxy tool name */
    private sourceToolProxyNames = new Map<string, Map<string, string>>();
    /** Optional debug logger */
    private debugFn: ((msg: string) => void) | undefined;
    /** Workspace root path for local MCP filtering */
    private workspaceRootPath?: string;
    /** Session storage path for saving large responses */
    private sessionPath?: string;
    /** Summarize callback for large response handling */
    private summarizeCallback?: (prompt: string) => Promise<string | null>;
    private collectionCacheScope?: CollectionCacheScope | (() => CollectionCacheScope | undefined);
    private beforeSourceToolExecution?: BeforeSourceToolExecution;
    private readonly inputSchemaValidator = new AjvJsonSchemaValidator();
    private readonly toolInputValidators = new Map<string, {
        schemaKey: string;
        validate: JsonSchemaValidator<Record<string, unknown>>;
    }>();
    private readonly toolOutputValidators = new Map<string, {
        schemaKey: string;
        validate: JsonSchemaValidator<Record<string, unknown>>;
    }>();
    /** Called after sync() connects/disconnects sources, so clients can be notified */
    onToolsChanged?: () => void;
    constructor(options?: {
        debug?: (msg: string) => void;
        workspaceRootPath?: string;
        sessionPath?: string;
    }) {
        this.debugFn = options?.debug;
        this.workspaceRootPath = options?.workspaceRootPath;
        this.sessionPath = options?.sessionPath;
    }
    /**
     * Set the summarize callback for large response handling.
     * Typically called after agent creation: pool.setSummarizeCallback(agent.getSummarizeCallback())
     */
    setSummarizeCallback(fn: (prompt: string) => Promise<string | null>): void {
        this.summarizeCallback = createCollectionSummaryCallback(() => this.resolveCollectionCacheScope(), fn);
    }
    setCollectionCacheScope(scope?: CollectionCacheScope | (() => CollectionCacheScope | undefined)): void {
        this.collectionCacheScope = typeof scope === 'function' ? scope : scope ? { ...scope } : undefined;
    }
    setBeforeSourceToolExecution(fence?: BeforeSourceToolExecution): void {
        this.beforeSourceToolExecution = fence;
    }
    private resolveCollectionCacheScope(): CollectionCacheScope | undefined {
        const scope = typeof this.collectionCacheScope === 'function' ? this.collectionCacheScope() : this.collectionCacheScope;
        if (!scope)
            return undefined;
        // Actual active endpoint/credential configuration participates in the
        // boundary, but only its digest enters the cache key; never log it.
        const permissionRevision = createHash('sha256').update(JSON.stringify([
            scope.permissionRevision, [...this.activeConfigs].sort(([left], [right]) => left.localeCompare(right)),
        ])).digest('hex');
        return { ...scope, permissionRevision };
    }
    private debug(msg: string): void {
        this.debugFn?.(`[McpClientPool] ${msg}`);
    }
    protected async registerClient(slug: string, client: PoolClient): Promise<void> {
        return mcpPoolConnection.registerClient(this, slug, client);
    }
    /**
     * Connect to an MCP source server (remote HTTP/SSE/stdio).
     * If already connected, this is a no-op.
     */
    async connect(slug: string, config: SdkMcpServerConfig): Promise<void> {
        return mcpPoolConnection.connect(this, slug, config);
    }
    /**
     * Connect to an in-process MCP server (API source) via in-memory transport.
     */
    async connectInProcess(slug: string, mcpServer: McpServer): Promise<void> {
        return mcpPoolConnection.connectInProcess(this, slug, mcpServer);
    }
    /**
     * Disconnect a source and remove its tools from the pool.
     */
    async disconnect(slug: string): Promise<void> {
        return mcpPoolConnection.disconnect(this, slug);
    }
    /**
     * Disconnect all sources and clear all state.
     */
    async disconnectAll(): Promise<void> {
        return mcpPoolConnection.disconnectAll(this);
    }
    // ============================================================
    // Sync: Reconcile active sources
    // ============================================================
    /**
     * Sync the pool to match a desired set of MCP + API sources.
     * Connects new sources, disconnects removed ones, keeps existing ones.
     *
     * @param mcpServers - Map of slug → config for desired MCP sources
     * @param apiServers - Map of slug → config for desired API sources
     * @returns List of slugs that failed to connect
     */
    async sync(mcpServers: Record<string, SdkMcpServerConfig>, apiServers: Record<string, ApiServerConfig> = {}): Promise<string[]> {
        return mcpPoolConnection.sync(this, mcpServers, apiServers);
    }
    // ============================================================
    // Tool Discovery
    // ============================================================
    /**
     * Get cached tools for a source. Returns empty array if not connected.
     */
    getTools(slug: string): PoolTool[] {
        return this.toolCache.get(slug) || [];
    }
    /**
     * Get all connected source slugs.
     */
    getConnectedSlugs(): string[] {
        return Array.from(this.clients.keys());
    }
    /**
     * Check if a source is connected.
     */
    isConnected(slug: string): boolean {
        return this.clients.has(slug);
    }
    /**
     * Resolve the LLM-facing proxy name for an original MCP tool name.
     */
    getProxyToolName(slug: string, originalName: string): string | null {
        return mcpPoolProxy.getProxyToolName(this, slug, originalName);
    }
    /**
     * Resolve the source-local safe tool name used by SDK MCP servers.
     */
    getProxyToolLocalName(slug: string, originalName: string): string | null {
        return mcpPoolProxy.getProxyToolLocalName(this, slug, originalName);
    }
    /**
     * Generate proxy tool definitions for all connected sources (or a subset).
     * These are passed to backends for tool registration.
     */
    getProxyToolDefs(slugs?: string[]): ProxyToolDef[] {
        return mcpPoolProxy.getProxyToolDefs(this, slugs);
    }
    /** Resolve capability hints for the exact proxy name used by agent hooks. */
    getProxyToolCapabilities(proxyName: string): ProxyToolCapabilities | undefined {
        return mcpPoolProxy.getProxyToolCapabilities(this, proxyName);
    }
    // ============================================================
    // Tool Execution
    // ============================================================
    /**
     * Execute an MCP tool by its proxy name (mcp__{slug}__{toolName}).
     * Returns a result matching the subprocess protocol format.
     */
    async callTool(proxyName: string, args: Record<string, unknown>): Promise<McpToolResult> {
        return mcpPoolExecution.callTool(this, proxyName, args);
    }
    /**
     * Check if a tool name is an MCP proxy tool managed by this pool.
     */
    isProxyTool(toolName: string): boolean {
        return mcpPoolProxy.isProxyTool(this, toolName);
    }
}
