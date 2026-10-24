import type { SourceSensitivity } from "../../config/selection-provenance.ts";
import type { ApiSourceConfig } from './api-config.ts';
import type { McpSourceConfig } from './mcp-config.ts';
import type { SourceType } from './provider-inference.ts';

/**
 * Local filesystem/app configuration
 */
export interface LocalSourceConfig {
  path: string;
  format?: string; // Optional hint: 'filesystem' | 'obsidian' | 'git' | 'sqlite' | etc.
}

/**
 * Source connection status
 * - 'connected': Source is connected and working
 * - 'needs_auth': Source requires authentication
 * - 'failed': Connection failed with error
 * - 'untested': Connection has not been tested
 * - 'local_disabled': Stdio source is disabled (local MCP servers off)
 */
export type SourceConnectionStatus = 'connected' | 'needs_auth' | 'failed' | 'untested' | 'local_disabled';

// ============================================================================
// Source Brand
// ============================================================================

/**
 * Brand theming for a source's UI elements.
 * Uses the EntityColor system for light/dark mode support.
 */
export interface SourceBrand {
  /** Primary brand color — used for source-branded UI elements.
   *  Can be a system color name ("accent", "info") or custom { light, dark } values.
   *  Defaults to "accent" if not set. */
  color?: import("../../colors/types").EntityColor;
}

// ============================================================================
// Main Source Config
// ============================================================================

/**
 * Main source configuration (stored in config.json)
 */
export interface FolderSourceConfig {
  id: string;
  name: string;
  slug: string;
  enabled: boolean;

  // Provider is a freeform label (e.g., "linear", "todoist", "my-custom-api")
  provider: string;

  // Connection type determines which config block is used
  type: SourceType;

  // Type-specific configuration (exactly one should be present)
  mcp?: McpSourceConfig;
  api?: ApiSourceConfig;
  local?: LocalSourceConfig;

  // Icon: emoji or URL
  // Config is the source of truth. Local icon files are auto-discovered only when icon is undefined.
  // Priority: emoji > URL > local file (auto-discovered)
  icon?: string;

  // Short description for agent context (e.g., "Issue tracking, bugs, tasks, sprints")
  // If not set, extracted from guide.md first paragraph
  tagline?: string;

  // Brand theming for this source's UI elements
  brand?: SourceBrand;

  /**
   * Optional policy hint consumed by Robinswood's policy-first LLM router.
   * When several enabled sources are present, the runtime uses the highest
   * sensitivity among them for the turn.
   */
  routingSensitivity?: SourceSensitivity;

  // Status tracking
  isAuthenticated?: boolean;
  connectionStatus?: SourceConnectionStatus;
  connectionError?: string; // Error message if status is 'failed'
  lastTestedAt?: number;

  // Metadata (optional - manually created configs may not have them)
  createdAt?: number;
  updatedAt?: number;
}

/**
 * Parsed guide.md content with embedded cache
 */
export interface SourceGuide {
  // Full raw markdown
  raw: string;

  // Parsed sections (extracted via regex/parsing)
  scope?: string;
  guidelines?: string;
  context?: string;
  apiNotes?: string;

  // Embedded cache data (from YAML frontmatter)
  cache?: Record<string, unknown>;
}

/**
 * Fully loaded source with all files
 */
export interface LoadedSource {
  config: FolderSourceConfig;
  guide: SourceGuide | null;

  /** Absolute path to source folder (for resolving relative icon paths) */
  folderPath: string;

  /** Absolute path to workspace folder (e.g., ~/.craft-agent/workspaces/xxx) */
  workspaceRootPath: string;

  /**
   * Workspace this source belongs to.
   * Used for credential lookups: source_oauth::{workspaceId}::{sourceSlug}
   */
  workspaceId: string;

  /**
   * Whether this is a built-in source (e.g., craft-agents-docs).
   * Built-in sources are always available and not shown in the sources UI.
   */
  isBuiltin?: boolean;

  /**
   * Pre-computed path to local icon file (icon.svg, icon.png, etc.) if it exists.
   * Computed during source loading so renderer doesn't need filesystem access.
   */
  iconPath?: string;
}

/**
 * Source creation input (without auto-generated fields)
 */
export interface CreateSourceInput {
  name: string;
  provider: string;
  type: SourceType;
  mcp?: McpSourceConfig;
  api?: ApiSourceConfig;
  local?: LocalSourceConfig;
  icon?: string; // Emoji or URL (auto-downloaded)
  enabled?: boolean;
  routingSensitivity?: SourceSensitivity;
}

/**
 * REST API configuration for API sources
 * Used by api-tools.ts to create dynamic API tools
 */
export interface ApiConfig {
  name: string;
  baseUrl: string;
  auth?: {
    type: 'none' | 'header' | 'bearer' | 'query' | 'basic';
    headerName?: string;
    headerNames?: string[]; // For multi-header auth (e.g., ["DD-API-KEY", "DD-APPLICATION-KEY"])
    queryParam?: string;
    authScheme?: string;
    credentialLabel?: string;
    secretLabel?: string;
  };
  headers?: Record<string, string>;
  documentation?: string;
  docsUrl?: string;
  defaultHeaders?: Record<string, string>;
  logo?: string;
  workspaceId?: string;
}
