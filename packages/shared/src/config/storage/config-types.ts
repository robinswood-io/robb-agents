import { join } from "path";
import { CONFIG_DIR } from "../paths.ts";
import type { ThinkingLevel } from "../../agent/thinking-levels.ts";
import { type ConfigDefaults } from "../config-defaults-schema.ts";
// Import for local use
import type { Workspace } from "@craft-agent/core/types";
// Import LLM connection types and constants
import type { LlmConnection } from "../llm-connections.ts";

// Config stored in JSON file (credentials stored in encrypted file, not here)
export interface StoredConfig {
  /** Forward-only envelope version for config migrations. */
  schemaVersion?: typeof STORED_CONFIG_SCHEMA_VERSION;
  // LLM Connections (authoritative source for auth and model config)
  llmConnections?: LlmConnection[];
  defaultLlmConnection?: string;  // Slug of default connection for new sessions
  defaultThinkingLevel?: ThinkingLevel;  // App-level default thinking level for new sessions

  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  activeSessionId: string | null;  // Currently active session (primary scope)
  // Notifications
  notificationsEnabled?: boolean;  // Desktop notifications for task completion (default: true)
  // Appearance
  colorTheme?: string;  // ID of selected preset theme (e.g., 'dracula', 'nord'). Default: 'default'
  // Auto-update
  dismissedUpdateVersion?: string;  // Version that user dismissed (skip notifications for this version)
  // Input settings
  autoCapitalisation?: boolean;  // Auto-capitalize first letter when typing (default: true)
  sendMessageKey?: 'enter' | 'cmd-enter';  // Key to send messages (default: 'enter')
  spellCheck?: boolean;  // Enable spell check in input (default: false)
  // Power settings
  keepAwakeWhileRunning?: boolean;  // Prevent screen sleep while sessions are running (default: false)
  // Tool metadata
  richToolDescriptions?: boolean;  // Add intent/action metadata to all tool calls (default: true)
  // Tools
  browserToolEnabled?: boolean;  // Enable built-in browser tool (default: true). Disable for Playwright/Puppeteer.
  allowRemoteEvaluate?: boolean;  // Allow remote agents to call `browser_tool evaluate` on local browser (default: true).
  // Prompt caching & context
  extendedPromptCache?: boolean;  // Use 1h prompt cache TTL instead of 5m (default: false)
  enable1MContext?: boolean;  // Enable 1M context window for supported models (default: false — opt-in; requires Anthropic Tier 4+)
  // Token optimization
  rtkEnabled?: boolean;  // Route Bash commands through bundled RTK to compress tool output (default: true). https://github.com/rtk-ai/rtk
  // Network proxy
  networkProxy?: import("../types.ts").NetworkProxySettings;
  // Windows: path to Git Bash (bash.exe) for the SDK subprocess
  gitBashPath?: string;
  // User chose "Setup later" during onboarding — skip showing onboarding on next launch
  setupDeferred?: boolean;
  // Server mode — embedded remote server settings
  serverConfig?: import("../server-config.ts").ServerConfig;
  // One-shot migration markers. Used by migrations that should run at most
  // once per user (e.g. restoring a previously-removed model to connection
  // lists without re-adding it if the user later removes it deliberately).
  migrationsApplied?: string[];
}

export const STORED_CONFIG_SCHEMA_VERSION = 1 as const;

export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export const CONFIG_DEFAULTS_FILE = join(CONFIG_DIR, 'config-defaults.json');

/**
 * Sync config-defaults.json from bundled assets.
 * Always writes on launch to ensure defaults are up-to-date with the running version.
 * Follows the same pattern as docs, themes, and other bundled assets.
 *
 * Source of truth: apps/electron/resources/config-defaults.json
 */
/** Minimal config-defaults used when bundled assets aren't available (CI, standalone server). */
export const FALLBACK_CONFIG_DEFAULTS: ConfigDefaults = {
  version: '1.0',
  description: 'Default configuration values for Robb Agents',
  defaults: {
    notificationsEnabled: true,
    colorTheme: 'default',
    autoCapitalisation: true,
    sendMessageKey: 'enter',
    spellCheck: false,
    keepAwakeWhileRunning: false,
    richToolDescriptions: true,
    extendedPromptCache: false,
    browserToolEnabled: true,
    rtkEnabled: true,
    allowRemoteEvaluate: true,
  },
  workspaceDefaults: {
    thinkingLevel: 'high',
    permissionMode: 'allow-all',
    externalActionPolicy: 'allow-in-execute',
    cyclablePermissionModes: ['allow-all', 'ask', 'safe'],
    localMcpServers: { enabled: true },
  },
};
