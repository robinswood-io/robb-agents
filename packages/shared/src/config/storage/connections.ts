import { getCredentialManager } from "../../credentials/index.ts";
import { loadWorkspaceConfig, saveWorkspaceConfig } from "../../workspaces/storage.ts";
import { debug } from "../../utils/debug.ts";
// Import LLM connection types and constants
import type { LlmConnection } from "../llm-connections.ts";
import { loadStoredConfig, saveConfig } from './config-file.ts';
import { ensureDefaultLlmConnection } from './connection-migrations.ts';
import { modelSetEquals } from './provider-migrations.ts';
import { getWorkspaces } from './workspaces.ts';

/**
 * Get all LLM connections.
 * Returns only user-added connections (no auto-populated built-ins).
 *
 * Note: This function is read-only and never modifies config.
 * Call migrateLegacyLlmConnectionsConfig() on app startup to handle migration.
 */
export function getLlmConnections(): LlmConnection[] {
  const config = loadStoredConfig();
  if (!config) return [];

  // Return empty array if not migrated yet - caller should call migration on startup
  return config.llmConnections || [];
}

/**
 * Get a specific LLM connection by slug.
 * @param slug - Connection slug
 * @returns Connection or null if not found
 */
export function getLlmConnection(slug: string): LlmConnection | null {
  const connections = getLlmConnections();
  return connections.find(c => c.slug === slug) || null;
}

/**
 * Add a new LLM connection.
 * @param connection - Connection to add (slug must be unique)
 * @returns true if added, false if slug already exists
 */
export function addLlmConnection(connection: LlmConnection): boolean {
  const config = loadStoredConfig();
  if (!config) return false;

  // Initialize array if not yet migrated (safe default for write operations)
  if (!config.llmConnections) {
    config.llmConnections = [];
  }

  // Check for duplicate slug
  if (config.llmConnections.some(c => c.slug === connection.slug)) {
    return false;
  }

  // Add connection with timestamp
  config.llmConnections.push({
    ...connection,
    createdAt: connection.createdAt || Date.now(),
  });

  // Ensure default is set after adding first connection
  ensureDefaultLlmConnection(config);

  saveConfig(config);
  return true;
}

/**
 * Update an existing LLM connection.
 * @param slug - Connection slug to update
 * @param updates - Partial updates to apply (slug is ignored)
 * @returns true if updated, false if not found
 */
export function updateLlmConnection(slug: string, updates: Partial<Omit<LlmConnection, 'slug'>>): boolean {
  const config = loadStoredConfig();
  if (!config) return false;

  // No connections means nothing to update
  if (!config.llmConnections || config.llmConnections.length === 0) {
    return false;
  }

  const connections = config.llmConnections;
  const index = connections.findIndex(c => c.slug === slug);
  if (index === -1) return false;

  const existing = connections[index]!;
  const toModelIds = (models?: Array<{ id: string } | string>): string[] =>
    (models ?? []).map(m => typeof m === 'string' ? m : m.id);

  connections[index] = {
    // Preserve required fields from existing
    slug: existing.slug,
    name: updates.name ?? existing.name,
    providerType: updates.providerType ?? existing.providerType,
    type: updates.type ?? existing.type, // Legacy field
    authType: updates.authType ?? existing.authType,
    createdAt: updates.createdAt ?? existing.createdAt,
    // Optional fields from updates or existing
    baseUrl: updates.baseUrl !== undefined ? updates.baseUrl : existing.baseUrl,
    models: updates.models !== undefined ? updates.models : existing.models,
    defaultModel: updates.defaultModel !== undefined ? updates.defaultModel : existing.defaultModel,
    modelSelectionMode: updates.modelSelectionMode !== undefined ? updates.modelSelectionMode : existing.modelSelectionMode,
    // Pi auth provider
    piAuthProvider: updates.piAuthProvider !== undefined ? updates.piAuthProvider : existing.piAuthProvider,
    // Organization project for Gemini Code Assist OAuth
    googleCloudProject: updates.googleCloudProject !== undefined ? updates.googleCloudProject : existing.googleCloudProject,
    // Custom endpoint protocol (Anthropic/OpenAI compatible)
    customEndpoint: updates.customEndpoint !== undefined ? updates.customEndpoint : existing.customEndpoint,
    // Mid-stream send behavior (steer vs queue) — read via resolveMidStreamBehavior()
    midStreamBehavior: updates.midStreamBehavior !== undefined ? updates.midStreamBehavior : existing.midStreamBehavior,
    // Resolved Anthropic OAuth identity (issue #838) — preserved across unrelated saves
    oauthAccountUuid: updates.oauthAccountUuid !== undefined ? updates.oauthAccountUuid : existing.oauthAccountUuid,
    oauthAccountEmail: updates.oauthAccountEmail !== undefined ? updates.oauthAccountEmail : existing.oauthAccountEmail,
    oauthOrganizationUuid: updates.oauthOrganizationUuid !== undefined ? updates.oauthOrganizationUuid : existing.oauthOrganizationUuid,
    oauthOrganizationName: updates.oauthOrganizationName !== undefined ? updates.oauthOrganizationName : existing.oauthOrganizationName,
    oauthProfileVerifiedAt: updates.oauthProfileVerifiedAt !== undefined ? updates.oauthProfileVerifiedAt : existing.oauthProfileVerifiedAt,
    // Timestamps
    lastUsedAt: updates.lastUsedAt !== undefined ? updates.lastUsedAt : existing.lastUsedAt,
  };

  const updated = connections[index]!;
  if (updated.providerType === 'pi') {
    const beforeModelIds = toModelIds(existing.models);
    const afterModelIds = toModelIds(updated.models);
    const changed =
      existing.defaultModel !== updated.defaultModel ||
      existing.modelSelectionMode !== updated.modelSelectionMode ||
      !modelSetEquals(beforeModelIds, afterModelIds);

    if (changed) {
      const stack = (new Error().stack ?? '').split('\n').slice(2, 7).map(s => s.trim());
      debug('[storage] updateLlmConnection(pi) changed', {
        slug,
        before: {
          mode: existing.modelSelectionMode,
          defaultModel: existing.defaultModel,
          modelCount: beforeModelIds.length,
          modelsFirst5: beforeModelIds.slice(0, 5),
        },
        after: {
          mode: updated.modelSelectionMode,
          defaultModel: updated.defaultModel,
          modelCount: afterModelIds.length,
          modelsFirst5: afterModelIds.slice(0, 5),
        },
        updates: {
          keys: Object.keys(updates),
          defaultModel: updates.defaultModel,
          modelSelectionMode: updates.modelSelectionMode,
          modelsCount: Array.isArray(updates.models) ? updates.models.length : undefined,
        },
        stack,
      });
    }
  }

  saveConfig(config);
  return true;
}

/**
 * Delete an LLM connection.
 * @param slug - Connection slug to delete
 * @returns true if deleted, false if not found
 */
export function deleteLlmConnection(slug: string): boolean {
  const config = loadStoredConfig();
  if (!config) return false;

  // No connections means nothing to delete
  if (!config.llmConnections || config.llmConnections.length === 0) {
    return false;
  }

  const connections = config.llmConnections;
  const index = connections.findIndex(c => c.slug === slug);
  if (index === -1) return false;

  connections.splice(index, 1);

  // If deleted connection was the default, reset to first remaining or clear
  if (config.defaultLlmConnection === slug) {
    config.defaultLlmConnection = connections.length > 0 ? connections[0]!.slug : undefined;
  }

  saveConfig(config);

  // Clean up workspace references to the deleted connection (non-blocking)
  try {
    const workspaces = getWorkspaces();
    for (const ws of workspaces) {
      const wsConfig = loadWorkspaceConfig(ws.rootPath);
      if (wsConfig?.defaults?.defaultLlmConnection === slug) {
        wsConfig.defaults.defaultLlmConnection = undefined;
        saveWorkspaceConfig(ws.rootPath, wsConfig);
      }
    }
  } catch (error) {
    console.error('Failed to clean up workspace references:', error);
  }

  // Clean up stored credentials for this connection (API keys, OAuth tokens)
  // This is fire-and-forget but we log errors for debugging
  const credentialManager = getCredentialManager();
  credentialManager.delete({ type: 'llm_api_key', connectionSlug: slug }).catch((error) => {
    console.error(`[storage] Failed to delete API key credential for connection '${slug}':`, error);
  });
  credentialManager.delete({ type: 'llm_oauth', connectionSlug: slug }).catch((error) => {
    console.error(`[storage] Failed to delete OAuth credential for connection '${slug}':`, error);
  });

  return true;
}

/**
 * Get the default LLM connection slug.
 * @returns Default connection slug, or null if no connections exist
 */
export function getDefaultLlmConnection(): string | null {
  const config = loadStoredConfig();
  if (!config) return null;

  // If no connections, return null
  if (!config.llmConnections || config.llmConnections.length === 0) {
    return null;
  }

  return config.defaultLlmConnection || config.llmConnections[0]?.slug || null;
}

/**
 * Set the default LLM connection.
 * @param slug - Connection slug to set as default
 * @returns true if set, false if connection not found
 */
export function setDefaultLlmConnection(slug: string): boolean {
  const config = loadStoredConfig();
  if (!config) return false;

  // No connections means nothing to set as default
  if (!config.llmConnections || config.llmConnections.length === 0) {
    return false;
  }

  // Verify connection exists
  if (!config.llmConnections.some(c => c.slug === slug)) {
    return false;
  }

  config.defaultLlmConnection = slug;
  saveConfig(config);
  return true;
}
