// Import for local use
import type { AuthType } from "@craft-agent/core/types";
// Import LLM connection types and constants
import type { LlmConnection } from "../llm-connections.ts";
import { isValidProviderAuthCombination, getDefaultModelsForConnection } from "../llm-connections.ts";
import { getModelProvider } from "../models.ts";
import { loadStoredConfig, saveConfig } from './config-file.ts';
import type { StoredConfig } from './config-types.ts';
import { backfillAllConnectionModels, migrateCodexCopilotToPi, migrateLegacyProviderTypes } from './provider-migrations.ts';

/**
 * Migrate modelDefaults onto connection.defaultModel, then delete modelDefaults.
 * If user had set modelDefaults.anthropic, apply it to the default anthropic connection.
 * Same for openai. Then remove modelDefaults from config.
 */
function migrateModelDefaultsToConnections(config: StoredConfig): boolean {
  const configRecord = config as {
    modelDefaults?: { anthropic?: string; openai?: string };
  };
  if (!configRecord.modelDefaults || !config.llmConnections) return false;
  let changed = false;

  // Apply anthropic model default to the default anthropic connection
  if (configRecord.modelDefaults.anthropic) {
    const defaultSlug = config.defaultLlmConnection;
    const anthropicConn = config.llmConnections.find(c =>
      c.slug === defaultSlug && c.providerType === 'anthropic'
    ) || config.llmConnections.find(c =>
      c.providerType === 'anthropic'
    );
    if (anthropicConn) {
      anthropicConn.defaultModel = configRecord.modelDefaults.anthropic;
      changed = true;
    }
  }

  // Apply openai model default to the default openai connection
  // Cast providerType to string for legacy values removed from LlmProviderType
  if (configRecord.modelDefaults.openai) {
    const openaiConn = config.llmConnections.find(c =>
      (c.providerType as string) === 'openai' || (c.providerType as string) === 'openai_compat'
    );
    if (openaiConn) {
      openaiConn.defaultModel = configRecord.modelDefaults.openai;
      changed = true;
    }
  }

  // Delete modelDefaults
  delete configRecord.modelDefaults;
  changed = true;

  return changed;
}

/**
 * Migrate legacy auth config to LLM connections.
 * Call this on app startup before any getLlmConnections() calls.
 *
 * This is a one-time migration that converts:
 * - Legacy authType field → LlmConnection in llmConnections array
 * - Legacy anthropicBaseUrl → LlmConnection.baseUrl
 * - Legacy customModel → LlmConnection.defaultModel
 * - Legacy model → modelDefaults (per provider)
 *
 * After migration, the legacy fields are deleted since they are no longer used.
 */
export function migrateLegacyLlmConnectionsConfig(): void {
  const config = loadStoredConfig();
  if (!config) return;



  // Already migrated - llmConnections array exists
  if (config.llmConnections !== undefined) {
    // Clean up any remaining legacy fields from previous runs
    let needsSave = false;
    const configRecord = config as {
      authType?: AuthType;
      anthropicBaseUrl?: string;
      customModel?: string;
      model?: string;
      modelDefaults?: Record<string, string>;
    };
    if ('authType' in config) {
      delete configRecord.authType;
      needsSave = true;
    }
    if ('anthropicBaseUrl' in config) {
      delete configRecord.anthropicBaseUrl;
      needsSave = true;
    }
    if ('customModel' in config) {
      delete configRecord.customModel;
      needsSave = true;
    }
    if ('model' in config) {
      const legacyModel = configRecord.model;
      if (legacyModel) {
        const provider = getModelProvider(legacyModel) ?? 'anthropic';
        configRecord.modelDefaults = { ...(configRecord.modelDefaults ?? {}), [provider]: legacyModel };
      }
      delete configRecord.model;
      needsSave = true;
    }
    // Note: applyCompatDefaults() is NOT called here for already-migrated configs.
    // Compat connections are user-owned after creation — the app should not
    // silently extend or override the user's model list on every startup.
    // Compat defaults are only applied during fresh connection creation or
    // first-time legacy migration (the config.llmConnections === undefined path below).

    // Phase 1a-bis: Migrate Codex/Copilot connections to Pi backend
    if (migrateCodexCopilotToPi(config)) {
      needsSave = true;
    }

    // Phase 1c: Backfill models/defaultModel on ALL connections (not just compat)
    // This ensures built-in connections (anthropic, openai) always have models populated
    if (backfillAllConnectionModels(config)) {
      needsSave = true;
    }
    // Phase 1d: Migrate modelDefaults onto connection.defaultModel, then delete modelDefaults
    if (migrateModelDefaultsToConnections(config)) {
      needsSave = true;
    }
    // Phase 1j: Migrate legacy provider types (bedrock/vertex/anthropic_compat → pi/pi_compat)
    if (migrateLegacyProviderTypes(config)) {
      needsSave = true;
    }

    if (needsSave) {
      saveConfig(config);
    }
    return;
  }

  // Initialize empty array
  config.llmConnections = [];

  // Legacy migration: if user had authType set, create a connection for them
  const configRecord = config as {
    authType?: AuthType;
    anthropicBaseUrl?: string;
    customModel?: string;
    model?: string;
    modelDefaults?: Record<string, string>;
  };
  const legacyAuthType = configRecord.authType;
  const legacyBaseUrl = configRecord.anthropicBaseUrl;
  const legacyCustomModel = configRecord.customModel;
  const legacyModel = configRecord.model;

  if (legacyAuthType) {
    let migrated: LlmConnection | null = null;

    if (legacyAuthType === 'oauth_token') {
      // Claude Max OAuth
      migrated = {
        slug: 'claude-max',
        name: 'Claude Max',
        providerType: 'anthropic',
        authType: 'oauth',
        models: getDefaultModelsForConnection('anthropic'),
        createdAt: Date.now(),
      };
    } else if (legacyAuthType === 'codex_oauth') {
      // ChatGPT Plus OAuth → Pi backend
      migrated = {
        slug: 'codex',
        name: 'ChatGPT Plus (via Pi)',
        providerType: 'pi',
        authType: 'oauth',
        piAuthProvider: 'openai-codex',
        modelSelectionMode: 'automaticallySyncedFromProvider',
        models: getDefaultModelsForConnection('pi', 'openai-codex'),
        createdAt: Date.now(),
      };
    } else if (legacyAuthType === 'codex_api_key') {
      // OpenAI API Key → Pi backend
      migrated = {
        slug: 'codex-api',
        name: 'OpenAI API (via Pi)',
        providerType: 'pi',
        authType: 'api_key',
        piAuthProvider: 'openai',
        modelSelectionMode: 'automaticallySyncedFromProvider',
        models: getDefaultModelsForConnection('pi', 'openai'),
        createdAt: Date.now(),
      };
    } else if (legacyAuthType === 'api_key') {
      // Anthropic API Key - check if custom endpoint (compat mode → pi_compat)
      const hasCustomEndpoint = !!legacyBaseUrl;
      if (hasCustomEndpoint) {
        migrated = {
          slug: 'anthropic-api',
          name: 'Custom Anthropic-Compatible',
          providerType: 'pi_compat',
          authType: 'api_key_with_endpoint',
          customEndpoint: { api: 'anthropic-messages' },
          models: getDefaultModelsForConnection('pi_compat'),
          createdAt: Date.now(),
        };
      } else {
        migrated = {
          slug: 'anthropic-api',
          name: 'Anthropic (API Key)',
          providerType: 'anthropic',
          authType: 'api_key',
          models: getDefaultModelsForConnection('anthropic'),
          createdAt: Date.now(),
        };
      }
    }

    if (migrated) {
      // Validate the migrated connection has a valid provider/auth combination
      if (!isValidProviderAuthCombination(migrated.providerType, migrated.authType)) {
        console.warn(
          `[config] Legacy migration created invalid provider/auth combination: ` +
          `providerType=${migrated.providerType}, authType=${migrated.authType} ` +
          `(slug: ${migrated.slug}). Skipping migration for this connection.`
        );
      } else {
        // Apply legacy baseUrl if set
        if (legacyBaseUrl) {
          migrated.baseUrl = legacyBaseUrl;
        }

        // Apply legacy customModel if set
        if (legacyCustomModel) {
          migrated.defaultModel = legacyCustomModel;
        }

        config.llmConnections.push(migrated);
        config.defaultLlmConnection = migrated.slug;
      }
    }
  }

  // Delete legacy fields after migration
  delete configRecord.authType;
  delete configRecord.anthropicBaseUrl;
  delete configRecord.customModel;
  delete configRecord.model;

  if (legacyModel) {
    const provider = getModelProvider(legacyModel) ?? 'anthropic';
    configRecord.modelDefaults = { ...(configRecord.modelDefaults ?? {}), [provider]: legacyModel };
  }

  // Run the same backfill and migration on newly created connections
  migrateCodexCopilotToPi(config);
  backfillAllConnectionModels(config);
  migrateModelDefaultsToConnections(config);

  saveConfig(config);
}

/**
 * Initialize a missing global default for configurations without a selection.
 * Existing global/workspace selections, including missing connections, remain unchanged.
 * Called on app startup alongside other migrations.
 */
export function migrateOrphanedDefaultConnections(): void {
  const config = loadStoredConfig();
  if (!config) return;
  if (!config.llmConnections || config.llmConnections.length === 0) return;

  let changed = false;

  // Only initialize a default when none was selected.
  if (ensureDefaultLlmConnection(config)) {
    changed = true;
  }

  // Existing global/workspace selections are preserved. An unavailable
  // selected connection is reported by backend resolution, never replaced.

  if (changed) {
    saveConfig(config);
  }
}

/**
 * Ensure default LLM connection is set correctly.
 * Called internally by write operations to fix inconsistent state.
 * This is NOT called on read - reads never modify config.
 */
export function ensureDefaultLlmConnection(config: StoredConfig): boolean {
  if (!config.llmConnections || config.llmConnections.length === 0) {
    return false;
  }

  if (!config.defaultLlmConnection) {
    config.defaultLlmConnection = config.llmConnections[0]!.slug;
    return true;
  }

  return false;
}
