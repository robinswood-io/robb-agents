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
import { CraftMcpClient, type PoolClient } from "../client.ts";
import { ApiSourcePoolClient } from "../api-source-pool-client.ts";
import type { SdkMcpServerConfig } from "../../agent/backend/types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isLocalMcpEnabled } from "../../workspaces/storage.ts";
import type { McpClientPool } from '../mcp-pool.ts';
import { buildSafeProxyToolName, sdkConfigToClientConfig, mcpConfigChanged } from './shared.ts';
import type { ApiServerConfig } from './shared.ts';

// ============================================================
  // Connection Lifecycle
  // ============================================================

  /**
   * Register a client: connect, cache tools, build proxy mappings.
   * Shared logic for both remote MCP and in-process API sources.
   */
export async function registerClient(transportOwner: McpClientPool, slug: string, client: PoolClient): Promise<void> {
    // listTools() triggers connect() internally for both CraftMcpClient and ApiSourcePoolClient
    const tools = await client.listTools();
    transportOwner["clients"].set(slug, client);
    transportOwner["toolCache"].set(slug, tools);
    const usedProxyNames = new Set(transportOwner.proxyTools.keys());
    const sourceProxyNames = new Map<string, string>();
    for (const tool of tools) {
        const proxyName = buildSafeProxyToolName(slug, tool.name, usedProxyNames);
        usedProxyNames.add(proxyName);
        sourceProxyNames.set(tool.name, proxyName);
        transportOwner.proxyTools.set(proxyName, { slug, originalName: tool.name });
    }
    transportOwner.sourceToolProxyNames.set(slug, sourceProxyNames);
    transportOwner.debug(`Connected source ${slug}: ${tools.length} tools`);
}

export async function connect(transportOwner: McpClientPool, slug: string, config: SdkMcpServerConfig): Promise<void> {
    if (transportOwner["clients"].has(slug))
        return;
    const clientConfig = sdkConfigToClientConfig(config);
    if (!clientConfig) {
        transportOwner.debug(`Unknown MCP server type for ${slug}: ${(config as {
            type: string;
        }).type}`);
        return;
    }
    await transportOwner["registerClient"](slug, new CraftMcpClient(clientConfig, slug));
    transportOwner["activeConfigs"].set(slug, config);
}

export async function connectInProcess(transportOwner: McpClientPool, slug: string, mcpServer: McpServer): Promise<void> {
    if (transportOwner["clients"].has(slug))
        return;
    await transportOwner["registerClient"](slug, new ApiSourcePoolClient(mcpServer));
}

export async function disconnect(transportOwner: McpClientPool, slug: string): Promise<void> {
    const client = transportOwner["clients"].get(slug);
    if (client) {
        await client.close().catch(() => { });
        transportOwner["clients"].delete(slug);
    }
    // Remove proxy tool entries for this slug
    for (const [proxyName, info] of transportOwner.proxyTools) {
        if (info.slug === slug) {
            transportOwner.proxyTools.delete(proxyName);
            transportOwner.toolInputValidators.delete(proxyName);
            transportOwner.toolOutputValidators.delete(proxyName);
        }
    }
    transportOwner.sourceToolProxyNames.delete(slug);
    transportOwner["toolCache"].delete(slug);
    transportOwner["activeConfigs"].delete(slug);
    transportOwner.debug(`Disconnected source: ${slug}`);
}

export async function disconnectAll(transportOwner: McpClientPool): Promise<void> {
    const closePromises = Array.from(transportOwner["clients"].values()).map(c => c.close().catch(() => { }));
    await Promise.all(closePromises);
    transportOwner["clients"].clear();
    transportOwner["toolCache"].clear();
    transportOwner.proxyTools.clear();
    transportOwner.sourceToolProxyNames.clear();
    transportOwner["activeConfigs"].clear();
    transportOwner.toolInputValidators.clear();
    transportOwner.toolOutputValidators.clear();
    transportOwner.debug('Disconnected all MCP clients');
}

export async function sync(transportOwner: McpClientPool, mcpServers: Record<string, SdkMcpServerConfig>, apiServers: Record<string, ApiServerConfig>): Promise<string[]> {
    // Filter out stdio sources when local MCP is disabled for this workspace.
    const localEnabled = !transportOwner["workspaceRootPath"] || isLocalMcpEnabled(transportOwner["workspaceRootPath"]);
    const filteredMcp: Record<string, SdkMcpServerConfig> = {};
    for (const [slug, config] of Object.entries(mcpServers)) {
        if (config.type === 'stdio' && !localEnabled) {
            transportOwner.debug(`Filtering out stdio source "${slug}" (local MCP disabled)`);
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
    const currentSlugs = new Set(transportOwner["clients"].keys());
    const failures: string[] = [];
    // Disconnect sources no longer desired
    for (const slug of currentSlugs) {
        if (!desiredSlugs.has(slug)) {
            await transportOwner["disconnect"](slug);
        }
    }
    // Connect new MCP sources + reconnect existing ones whose config changed (e.g. refreshed token)
    for (const [slug, config] of Object.entries(filteredMcp)) {
        if (!currentSlugs.has(slug)) {
            try {
                await transportOwner["connect"](slug, config);
            }
            catch (err) {
                transportOwner.debug(`Failed to connect MCP source ${slug}: ${err instanceof Error ? err.message : String(err)}`);
                failures.push(slug);
            }
        }
        else {
            const oldConfig = transportOwner["activeConfigs"].get(slug);
            if (oldConfig && mcpConfigChanged(oldConfig, config)) {
                transportOwner.debug(`Config changed for ${slug}, reconnecting with fresh credentials`);
                await transportOwner["disconnect"](slug);
                try {
                    await transportOwner["connect"](slug, config);
                }
                catch (err) {
                    transportOwner.debug(`Failed to reconnect MCP source ${slug}: ${err instanceof Error ? err.message : String(err)}`);
                    failures.push(slug);
                }
            }
        }
    }
    // Connect new API sources
    for (const [slug, server] of apiSlugs) {
        if (!currentSlugs.has(slug)) {
            try {
                await transportOwner["connectInProcess"](slug, server);
            }
            catch (err) {
                transportOwner.debug(`Failed to connect API source ${slug}: ${err instanceof Error ? err.message : String(err)}`);
                failures.push(slug);
            }
        }
    }
    transportOwner["onToolsChanged"]?.();
    return failures;
}
