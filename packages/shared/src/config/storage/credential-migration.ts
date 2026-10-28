import { getCredentialManager } from "../../credentials/index.ts";

/**
 * Migrate legacy global credentials to LLM connection-scoped credentials.
 * This ensures that credentials saved before the LLM connections system
 * are available through the new connection-based auth.
 *
 * Called on app startup (async operation, credentials use encrypted storage).
 *
 * Migration mapping:
 * - claude_oauth::global → llm_oauth::claude-max
 * - anthropic_api_key::global → llm_api_key::anthropic-api
 *
 * After successful migration, legacy credentials are deleted to prevent
 * stale data and reduce credential store clutter.
 */
export async function migrateLegacyCredentials(): Promise<void> {
  const manager = getCredentialManager();
  const debug = (await import("../../utils/debug.ts")).debug;

  // Migrate Claude OAuth: claude_oauth::global → llm_oauth::claude-max
  const legacyClaudeOAuth = await manager.getClaudeOAuthCredentials();
  if (legacyClaudeOAuth?.accessToken) {
    // Only migrate if llm_oauth::claude-max doesn't exist yet
    const existingLlmOAuth = await manager.getLlmOAuth('claude-max');
    if (!existingLlmOAuth) {
      await manager.setLlmOAuth('claude-max', {
        accessToken: legacyClaudeOAuth.accessToken,
        ...(legacyClaudeOAuth.refreshToken !== undefined ? { refreshToken: legacyClaudeOAuth.refreshToken } : {}),
        ...(legacyClaudeOAuth.expiresAt !== undefined ? { expiresAt: legacyClaudeOAuth.expiresAt } : {}),
      });
      debug('[storage] Migrated legacy Claude OAuth to llm_oauth::claude-max');

      // Delete legacy credential after successful migration
      // Global credentials use just the type - the key format is {type}::global
      try {
        await manager.delete({ type: 'claude_oauth' });
        debug('[storage] Deleted legacy claude_oauth::global credential');
      } catch (error) {
        debug('[storage] Failed to delete legacy claude_oauth::global:', error);
      }
    }
  }

  // Migrate Anthropic API key: anthropic_api_key::global → llm_api_key::anthropic-api
  const legacyApiKey = await manager.getApiKey();
  if (legacyApiKey) {
    // Only migrate if llm_api_key::anthropic-api doesn't exist yet
    const existingLlmApiKey = await manager.getLlmApiKey('anthropic-api');
    if (!existingLlmApiKey) {
      await manager.setLlmApiKey('anthropic-api', legacyApiKey);
      debug('[storage] Migrated legacy Anthropic API key to llm_api_key::anthropic-api');

      // Delete legacy credential after successful migration
      // Global credentials use just the type - the key format is {type}::global
      try {
        await manager.delete({ type: 'anthropic_api_key' });
        debug('[storage] Deleted legacy anthropic_api_key::global credential');
      } catch (error) {
        debug('[storage] Failed to delete legacy anthropic_api_key::global:', error);
      }
    }
  }
}
