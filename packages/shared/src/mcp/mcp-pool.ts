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

import {
  CraftMcpClient,
  type McpClientConfig,
  type PoolClient,
  type PoolTool,
} from './client.ts';
import { ApiSourcePoolClient } from './api-source-pool-client.ts';
import type { SdkMcpServerConfig } from '../agent/backend/types.ts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JsonSchemaValidator } from '@modelcontextprotocol/server';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { isLocalMcpEnabled } from '../workspaces/storage.ts';
import { guardLargeResult } from '../utils/large-response.ts';
import { collectionSummaryCache, createCollectionSummaryCallback, type CollectionCacheScope } from './collection-cache.ts';
import { classifyToolNameMutationSemantics } from '../agent/core/tool-name-semantics.ts';
import { createHash } from 'node:crypto';
import {
  saveBinaryResponse,
  detectExtensionFromMagic,
  sanitizeFilename,
} from '../utils/binary-detection.ts';

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

const LLM_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const LLM_TOOL_NAME_MAX_LENGTH = 128;

function normalizeInputSchema(inputSchema: Record<string, unknown> | undefined): Record<string, unknown> {
  // AJV consumers used by some backends reject unknown meta-schema URIs.
  const { $schema, ...cleanSchema } = inputSchema || {};
  return Object.keys(cleanSchema).length > 0 ? cleanSchema : { type: 'object', properties: {} };
}

function normalizeStructuredContent(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function sanitizeToolNamePart(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, '_');
  return sanitized.length > 0 ? sanitized : 'tool';
}

function truncateWithSuffix(base: string, suffix: string): string {
  return `${base.slice(0, LLM_TOOL_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
}

function buildSafeProxyToolName(slug: string, originalName: string, usedNames: Set<string>): string {
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

const OUTPUT_BOUND_FIELD = /^(?:limit|maxResults|max_results|pageSize|page_size|count|top|fields|select|from|to|start|end|since|until)$/i;

function withOutputBudgetGuidance(
  description: string,
  toolName: string,
  inputSchema: Record<string, unknown>,
): string {
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
function sdkConfigToClientConfig(config: SdkMcpServerConfig): McpClientConfig | null {
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
function mcpConfigChanged(oldConfig: SdkMcpServerConfig, newConfig: SdkMcpServerConfig): boolean {
  if (oldConfig.type !== newConfig.type) return true;

  if (
    (oldConfig.type === 'http' || oldConfig.type === 'sse') &&
    (newConfig.type === 'http' || newConfig.type === 'sse')
  ) {
    if (oldConfig.url !== newConfig.url) return true;
    const oldAuth = oldConfig.headers?.['Authorization'];
    const newAuth = newConfig.headers?.['Authorization'];
    if (oldAuth !== newAuth) return true;
  }

  return false;
}

export class McpClientPool {
  /** Active MCP clients keyed by source slug */
  private clients = new Map<string, PoolClient>();

  /** Configs used for active MCP connections (for change detection during sync) */
  protected activeConfigs = new Map<string, SdkMcpServerConfig>();

  /** Cached tool lists keyed by source slug */
  private toolCache = new Map<string, PoolTool[]>();

  /** Proxy tool name → { slug, originalName } (e.g., "mcp__linear__createIssue" → { slug: "linear", originalName: "createIssue" }) */
  private proxyTools = new Map<string, { slug: string; originalName: string }>();

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

  constructor(options?: { debug?: (msg: string) => void; workspaceRootPath?: string; sessionPath?: string }) {
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
    if (!scope) return undefined;
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

  // ============================================================
  // Connection Lifecycle
  // ============================================================

  /**
   * Register a client: connect, cache tools, build proxy mappings.
   * Shared logic for both remote MCP and in-process API sources.
   */
  protected async registerClient(slug: string, client: PoolClient): Promise<void> {
    // listTools() triggers connect() internally for both CraftMcpClient and ApiSourcePoolClient
    const tools = await client.listTools();
    this.clients.set(slug, client);
    this.toolCache.set(slug, tools);

    const usedProxyNames = new Set(this.proxyTools.keys());
    const sourceProxyNames = new Map<string, string>();
    for (const tool of tools) {
      const proxyName = buildSafeProxyToolName(slug, tool.name, usedProxyNames);
      usedProxyNames.add(proxyName);
      sourceProxyNames.set(tool.name, proxyName);
      this.proxyTools.set(proxyName, { slug, originalName: tool.name });
    }
    this.sourceToolProxyNames.set(slug, sourceProxyNames);

    this.debug(`Connected source ${slug}: ${tools.length} tools`);
  }

  /**
   * Connect to an MCP source server (remote HTTP/SSE/stdio).
   * If already connected, this is a no-op.
   */
  async connect(slug: string, config: SdkMcpServerConfig): Promise<void> {
    if (this.clients.has(slug)) return;
    const clientConfig = sdkConfigToClientConfig(config);
    if (!clientConfig) {
      this.debug(`Unknown MCP server type for ${slug}: ${(config as { type: string }).type}`);
      return;
    }
    await this.registerClient(slug, new CraftMcpClient(clientConfig, slug));
    this.activeConfigs.set(slug, config);
  }

  /**
   * Connect to an in-process MCP server (API source) via in-memory transport.
   */
  async connectInProcess(slug: string, mcpServer: McpServer): Promise<void> {
    if (this.clients.has(slug)) return;
    await this.registerClient(slug, new ApiSourcePoolClient(mcpServer));
  }

  /**
   * Disconnect a source and remove its tools from the pool.
   */
  async disconnect(slug: string): Promise<void> {
    const client = this.clients.get(slug);
    if (client) {
      await client.close().catch(() => {});
      this.clients.delete(slug);
    }

    // Remove proxy tool entries for this slug
    for (const [proxyName, info] of this.proxyTools) {
      if (info.slug === slug) {
        this.proxyTools.delete(proxyName);
        this.toolInputValidators.delete(proxyName);
        this.toolOutputValidators.delete(proxyName);
      }
    }
    this.sourceToolProxyNames.delete(slug);
    this.toolCache.delete(slug);
    this.activeConfigs.delete(slug);
    this.debug(`Disconnected source: ${slug}`);
  }

  /**
   * Disconnect all sources and clear all state.
   */
  async disconnectAll(): Promise<void> {
    const closePromises = Array.from(this.clients.values()).map(c => c.close().catch(() => {}));
    await Promise.all(closePromises);
    this.clients.clear();
    this.toolCache.clear();
    this.proxyTools.clear();
    this.sourceToolProxyNames.clear();
    this.activeConfigs.clear();
    this.toolInputValidators.clear();
    this.toolOutputValidators.clear();
    this.debug('Disconnected all MCP clients');
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
  async sync(
    mcpServers: Record<string, SdkMcpServerConfig>,
    apiServers: Record<string, ApiServerConfig> = {}
  ): Promise<string[]> {
    // Filter out stdio sources when local MCP is disabled for this workspace.
    const localEnabled = !this.workspaceRootPath || isLocalMcpEnabled(this.workspaceRootPath);
    const filteredMcp: Record<string, SdkMcpServerConfig> = {};
    for (const [slug, config] of Object.entries(mcpServers)) {
      if (config.type === 'stdio' && !localEnabled) {
        this.debug(`Filtering out stdio source "${slug}" (local MCP disabled)`);
        continue;
      }
      filteredMcp[slug] = config;
    }

    // Extract McpServer instances from API configs
    const apiSlugs = new Map<string, McpServer>();
    for (const [slug, config] of Object.entries(apiServers)) {
      if (config?.type === 'sdk' && config.instance) {
        apiSlugs.set(slug, config.instance);
      }
    }

    const desiredSlugs = new Set([...Object.keys(filteredMcp), ...apiSlugs.keys()]);
    const currentSlugs = new Set(this.clients.keys());
    const failures: string[] = [];

    // Disconnect sources no longer desired
    for (const slug of currentSlugs) {
      if (!desiredSlugs.has(slug)) {
        await this.disconnect(slug);
      }
    }

    // Connect new MCP sources + reconnect existing ones whose config changed (e.g. refreshed token)
    for (const [slug, config] of Object.entries(filteredMcp)) {
      if (!currentSlugs.has(slug)) {
        try {
          await this.connect(slug, config);
        } catch (err) {
          this.debug(`Failed to connect MCP source ${slug}: ${err instanceof Error ? err.message : String(err)}`);
          failures.push(slug);
        }
      } else {
        const oldConfig = this.activeConfigs.get(slug);
        if (oldConfig && mcpConfigChanged(oldConfig, config)) {
          this.debug(`Config changed for ${slug}, reconnecting with fresh credentials`);
          await this.disconnect(slug);
          try {
            await this.connect(slug, config);
          } catch (err) {
            this.debug(`Failed to reconnect MCP source ${slug}: ${err instanceof Error ? err.message : String(err)}`);
            failures.push(slug);
          }
        }
      }
    }

    // Connect new API sources
    for (const [slug, server] of apiSlugs) {
      if (!currentSlugs.has(slug)) {
        try {
          await this.connectInProcess(slug, server);
        } catch (err) {
          this.debug(`Failed to connect API source ${slug}: ${err instanceof Error ? err.message : String(err)}`);
          failures.push(slug);
        }
      }
    }

    this.onToolsChanged?.();
    return failures;
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
    return this.sourceToolProxyNames.get(slug)?.get(originalName) ?? null;
  }

  /**
   * Resolve the source-local safe tool name used by SDK MCP servers.
   */
  getProxyToolLocalName(slug: string, originalName: string): string | null {
    const proxyName = this.getProxyToolName(slug, originalName);
    if (!proxyName) return null;

    const prefix = `mcp__${sanitizeToolNamePart(slug)}__`;
    return proxyName.startsWith(prefix) ? proxyName.slice(prefix.length) : proxyName;
  }

  /**
   * Generate proxy tool definitions for all connected sources (or a subset).
   * These are passed to backends for tool registration.
   */
  getProxyToolDefs(slugs?: string[]): ProxyToolDef[] {
    const targetSlugs = slugs || Array.from(this.toolCache.keys());
    const defs: ProxyToolDef[] = [];

    for (const slug of targetSlugs) {
      const tools = this.toolCache.get(slug) || [];
      for (const tool of tools) {
        const proxyName = this.getProxyToolName(slug, tool.name);
        if (!proxyName) continue;
        const inputSchema = normalizeInputSchema(tool.inputSchema);
        defs.push({
          name: proxyName,
          description: withOutputBudgetGuidance(tool.description || `Tool from ${slug}`, tool.name, inputSchema),
          inputSchema,
          ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
          readOnly: tool.annotations?.readOnlyHint,
          idempotent: tool.annotations?.idempotentHint,
          destructive: tool.annotations?.destructiveHint,
          openWorld: tool.annotations?.openWorldHint,
        });
      }
    }

    return defs;
  }

  /** Resolve capability hints for the exact proxy name used by agent hooks. */
  getProxyToolCapabilities(proxyName: string): ProxyToolCapabilities | undefined {
    for (const [slug, tools] of this.toolCache.entries()) {
      for (const tool of tools) {
        if (this.getProxyToolName(slug, tool.name) !== proxyName) continue;
        return {
          readOnly: tool.annotations?.readOnlyHint,
          idempotent: tool.annotations?.idempotentHint,
          destructive: tool.annotations?.destructiveHint,
          openWorld: tool.annotations?.openWorldHint,
          trusted: false,
        };
      }
    }
    return undefined;
  }

  // ============================================================
  // Tool Execution
  // ============================================================

  /**
   * Execute an MCP tool by its proxy name (mcp__{slug}__{toolName}).
   * Returns a result matching the subprocess protocol format.
   */
  async callTool(proxyName: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const info = this.proxyTools.get(proxyName);
    if (!info) {
      return {
        content: `Unknown MCP proxy tool: ${proxyName}`,
        isError: true,
      };
    }

    const { slug, originalName } = info;

    const client = this.clients.get(slug);
    if (!client) {
      return {
        content: `MCP client for source "${slug}" is not connected.`,
        isError: true,
        sourceSlug: slug,
      };
    }

    const sourceTool = this.toolCache.get(slug)?.find(tool => tool.name === originalName);
    if (!sourceTool) {
      return {
        content: `MCP tool "${originalName}" is no longer advertised by source "${slug}".`,
        isError: true,
        sourceSlug: slug,
      };
    }

    const inputSchema = normalizeInputSchema(sourceTool.inputSchema);
    try {
      const schemaKey = JSON.stringify(inputSchema);
      let cachedValidator = this.toolInputValidators.get(proxyName);
      if (!cachedValidator || cachedValidator.schemaKey !== schemaKey) {
        cachedValidator = {
          schemaKey,
          validate: this.inputSchemaValidator.getValidator<Record<string, unknown>>(inputSchema),
        };
        this.toolInputValidators.set(proxyName, cachedValidator);
      }

      const validation = cachedValidator.validate(args);
      if (!validation.valid) {
        return {
          content: `Invalid arguments for MCP tool "${originalName}". The call was blocked before execution.`,
          isError: true,
          sourceSlug: slug,
        };
      }
    } catch (error) {
      this.debug(`Invalid input schema for ${proxyName}: ${error instanceof Error ? error.message : String(error)}`);
      return {
        content: `MCP tool "${originalName}" has an invalid input schema and was not executed.`,
        isError: true,
        sourceSlug: slug,
      };
    }

    const possibleMutation = classifyToolNameMutationSemantics(originalName) !== 'neutral'
      || (typeof args.method === 'string' && !['GET', 'HEAD'].includes(args.method.toUpperCase()));
    const mutationWorkspace = possibleMutation ? this.resolveCollectionCacheScope()?.workspace : undefined;
    try {
      // This is deliberately the final awaited host fence before dispatching to
      // either a remote MCP transport or an in-process API source client.
      await this.beforeSourceToolExecution?.({
        sourceSlug: slug,
        toolName: originalName,
        args,
        capabilities: this.getProxyToolCapabilities(proxyName),
      });
      // Names only invalidate; they never authorize a cached source call. Sources
      // are always read afresh, including tools with remote readOnly annotations.
      if (mutationWorkspace) collectionSummaryCache.invalidateWorkspace(mutationWorkspace);
      const result = await client.callTool(originalName, args) as {
        content?: Array<{ type: string; text?: unknown; data?: string; mimeType?: string }>;
        isError?: boolean;
        structuredContent?: unknown;
      };
      const structuredContent = normalizeStructuredContent(result.structuredContent);
      if (structuredContent && sourceTool.outputSchema) {
        try {
          const outputSchema = normalizeInputSchema(sourceTool.outputSchema);
          const schemaKey = JSON.stringify(outputSchema);
          let cachedValidator = this.toolOutputValidators.get(proxyName);
          if (!cachedValidator || cachedValidator.schemaKey !== schemaKey) {
            cachedValidator = {
              schemaKey,
              validate: this.inputSchemaValidator.getValidator<Record<string, unknown>>(outputSchema),
            };
            this.toolOutputValidators.set(proxyName, cachedValidator);
          }
          if (!cachedValidator.validate(structuredContent).valid) {
            return {
              content: `MCP tool "${originalName}" returned structured output that does not match its declared schema.`,
              isError: true,
              sourceSlug: slug,
            };
          }
        } catch (error) {
          this.debug(`Invalid output schema for ${proxyName}: ${error instanceof Error ? error.message : String(error)}`);
          return {
            content: `MCP tool "${originalName}" has an invalid output schema. Its structured result was rejected.`,
            isError: true,
            sourceSlug: slug,
          };
        }
      }

      const contentBlocks = result.content || [];
      const parts: string[] = [];

      // 1. Process each content block — handle text, image, audio
      for (const block of contentBlocks) {
        if (block.type === 'text') {
          // Handle non-string text fields (e.g., objects from non-conforming servers)
          if (typeof block.text === 'string') {
            parts.push(block.text);
          } else if (block.text !== undefined && block.text !== null) {
            parts.push(JSON.stringify(block.text, null, 2));
          }
        } else if ((block.type === 'image' || block.type === 'audio') && block.data && this.sessionPath) {
          // Decode base64 binary content and save to downloads/
          try {
            const buffer = Buffer.from(block.data, 'base64');
            const ext = detectExtensionFromMagic(buffer) || '.bin';
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const safeName = sanitizeFilename(proxyName);
            const filename = `${safeName}_${timestamp}${ext}`;
            const saved = saveBinaryResponse(this.sessionPath, filename, buffer, block.mimeType ?? null);
            if (saved.type === 'file_download') {
              parts.push(`[${block.type.charAt(0).toUpperCase() + block.type.slice(1)} saved: ${saved.path} (${saved.sizeHuman})]`);
            }
          } catch {
            // Base64 decode failed — skip this block
          }
        }
      }

      // 2. Combine parts (fallback to JSON.stringify if no content extracted)
      const text = parts.join('\n') || JSON.stringify(result);

      // 3. Centralized binary + large response handling
      if (!result.isError && this.sessionPath) {
        const guarded = await guardLargeResult(text, {
          sessionPath: this.sessionPath,
          toolName: proxyName,
          input: args,
          summarize: this.summarizeCallback,
        });
        if (guarded) {
          return { content: guarded, isError: false };
        }
      }

      return {
        content: text,
        isError: !!result.isError,
        ...(structuredContent ? { structuredContent } : {}),
      };
    } catch (err) {
      return {
        content: `MCP tool "${originalName}" (source: ${slug}) failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
        sourceSlug: slug,
      };
    } finally {
      if (mutationWorkspace) collectionSummaryCache.invalidateWorkspace(mutationWorkspace);
    }
  }

  /**
   * Check if a tool name is an MCP proxy tool managed by this pool.
   */
  isProxyTool(toolName: string): boolean {
    return this.proxyTools.has(toolName);
  }
}
