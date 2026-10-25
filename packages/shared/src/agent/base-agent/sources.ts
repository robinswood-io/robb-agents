import type { LoadedSource } from "../../sources/types.ts";
import type { ApiServerConfig } from "../../mcp/mcp-pool.ts";
import type { SdkMcpServerConfig, SourceServerSnapshot } from "../backend/types.ts";
// Core modules
import { PermissionManager } from "../core/permission-manager.ts";
import { SourceManager } from "../core/source-manager.ts";
import { PromptBuilder } from "../core/prompt-builder.ts";
import type { BaseAgent } from '../base-agent.ts';

// ============================================================
  // Source Management (delegated to SourceManager)
  // ============================================================

  /**
   * Set the MCP server configurations for sources.
   * Called by facade when sources are activated/deactivated.
   *
   * Subclasses may override to handle provider-specific MCP setup.
   */
export async function setSourceServers(transportOwner: BaseAgent, mcpServers: Record<string, SdkMcpServerConfig>, apiServers: Record<string, unknown>, intendedSlugs?: string[]): Promise<void> {
    // Update SourceManager state (common tracking)
    transportOwner["sourceManager"].updateActiveState(Object.keys(mcpServers), Object.keys(apiServers), intendedSlugs);
    // Sync the centralized MCP client pool (if available)
    // Both MCP sources and API sources are routed through the pool.
    if (transportOwner["config"].mcpPool) {
        try {
            await transportOwner["config"].mcpPool.sync(mcpServers, apiServers as Record<string, ApiServerConfig>);
        }
        catch (err) {
            transportOwner["debug"](`Failed to sync MCP pool: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    transportOwner["sourceServerSnapshot"] = {
        mcpServers: { ...mcpServers },
        apiServers: { ...apiServers },
        intendedSlugs: [...(intendedSlugs ?? [...Object.keys(mcpServers), ...Object.keys(apiServers)])],
    };
}

export function getSourceServerSnapshot(transportOwner: BaseAgent): SourceServerSnapshot {
    return {
        mcpServers: { ...transportOwner["sourceServerSnapshot"].mcpServers },
        apiServers: { ...transportOwner["sourceServerSnapshot"].apiServers },
        intendedSlugs: [...transportOwner["sourceServerSnapshot"].intendedSlugs],
    };
}

export function getActiveSourceSlugs(transportOwner: BaseAgent): string[] {
    return Array.from(transportOwner["sourceManager"].getIntendedSlugs());
}

export function getAllSources(transportOwner: BaseAgent): LoadedSource[] {
    return transportOwner["sourceManager"].getAllSources();
}

/**
   * Set all sources (for context injection).
   * Uses SourceManager for state tracking.
   */
export function setAllSources(transportOwner: BaseAgent, sources: LoadedSource[]): void {
    transportOwner["sourceManager"].setAllSources(sources);
}

/**
   * Mark a source as unseen (will show introduction text again).
   */
export function markSourceUnseen(transportOwner: BaseAgent, sourceSlug: string): void {
    transportOwner["sourceManager"].markSourceUnseen(sourceSlug);
}

/**
   * Check if a source server is currently active.
   */
export function isSourceServerActive(transportOwner: BaseAgent, serverName: string): boolean {
    return transportOwner["sourceManager"].isSourceActive(serverName);
}

/**
   * Get the set of active source server names.
   */
export function getActiveSourceServerNames(transportOwner: BaseAgent): Set<string> {
    return new Set(transportOwner["sourceManager"].getActiveSlugs());
}

/**
   * Set temporary clarifications for context injection.
   * These are injected into prompts but not yet persisted.
   */
export function setTemporaryClarifications(transportOwner: BaseAgent, text: string | null): void {
    transportOwner["temporaryClarifications"] = text;
}

// ============================================================
  // Manager Accessors (for advanced queries)
  // ============================================================

  /**
   * Get SourceManager for advanced source state queries.
   */
export function getSourceManager(transportOwner: BaseAgent): SourceManager {
    return transportOwner["sourceManager"];
}

/**
   * Get PermissionManager for advanced permission queries.
   */
export function getPermissionManager(transportOwner: BaseAgent): PermissionManager {
    return transportOwner["permissionManager"];
}

/**
   * Get PromptBuilder for context building.
   */
export function getPromptBuilder(transportOwner: BaseAgent): PromptBuilder {
    return transportOwner["promptBuilder"];
}
