// ============================================
// Server Mode Configuration
// ============================================
import { DEFAULT_SERVER_CONFIG, normalizeServerConfigPublicUrls, type ServerConfig } from "../server-config.ts";
import { randomUUID } from "crypto";
import { loadStoredConfig, saveConfig } from './config-file.ts';

/**
 * Get the current server configuration.
 * Returns defaults if not yet configured.
 */
export function getServerConfig(): ServerConfig {
  const config = loadStoredConfig();
  return config?.serverConfig ?? { ...DEFAULT_SERVER_CONFIG };
}

/**
 * Persist server configuration.
 * Auto-generates a stable auth token on first enable if none exists.
 */
export function setServerConfig(serverConfig: ServerConfig): void {
  const config = loadStoredConfig();
  if (!config) return;

  const normalizedConfig = normalizeServerConfigPublicUrls(serverConfig);

  // Generate a stable token when first enabled (or if token is missing)
  if (normalizedConfig.enabled && !normalizedConfig.token) {
    normalizedConfig.token = randomUUID();
  }

  config.serverConfig = normalizedConfig;
  saveConfig(config);
}
