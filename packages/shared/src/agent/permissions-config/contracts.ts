import { type ApiEndpointRule, type CompiledApiEndpointRule, type CompiledBashPattern, type CompiledBlockedCommandHint, type BlockedCommandHintRule, type PermissionPaths } from "../mode-types.ts";

// ============================================================
// Types
// ============================================================

/**
 * Pattern entry with optional comment for error messages.
 * Preserves the comment from permissions.json so we can show helpful hints.
 */
export interface PatternWithComment {
  pattern: string;
  comment?: string;
}

/**
 * Parsed and normalized permissions configuration
 *
 * Note: blockedTools (Write, Edit, MultiEdit, NotebookEdit) are hardcoded in
 * SAFE_MODE_CONFIG and not configurable here - they're fundamental write
 * operations that must always be blocked in Explore mode.
 */
export interface PermissionsCustomConfig {
  /** Additional bash patterns to allow (with optional comments for error messages) */
  allowedBashPatterns: PatternWithComment[];
  /** Additional MCP patterns to allow (as regex strings) */
  allowedMcpPatterns: string[];
  /** API endpoint rules for fine-grained control */
  allowedApiEndpoints: ApiEndpointRule[];
  /** File paths to allow writes in Explore mode (glob pattern strings) */
  allowedWritePaths: string[];
  /** Command-specific hints for blocked Bash commands */
  blockedCommandHints: BlockedCommandHintRule[];
}

/**
 * Merged permissions config for runtime use
 */
export interface MergedPermissionsConfig {
  /** Blocked tools (Write, Edit, MultiEdit, NotebookEdit) - hardcoded, not configurable */
  blockedTools: Set<string>;
  /** Read-only bash patterns with metadata for helpful error messages */
  readOnlyBashPatterns: CompiledBashPattern[];
  /** Command-specific hints for blocked Bash command explanations */
  blockedCommandHints: CompiledBlockedCommandHint[];
  readOnlyMcpPatterns: RegExp[];
  /** Fine-grained API endpoint rules */
  allowedApiEndpoints: CompiledApiEndpointRule[];
  /** File paths allowed for writes in Explore mode (glob patterns) */
  allowedWritePaths: string[];
  /** Display name for error messages */
  displayName: string;
  /** Keyboard shortcut hint */
  shortcutHint: string;
  /** Paths to permission files for actionable error messages */
  permissionPaths?: PermissionPaths;
}

/**
 * Context for permissions checking (includes workspace/source/agent info)
 */
export interface PermissionsContext {
  workspaceRootPath: string;
  /** Active source slugs for source-specific rules */
  activeSourceSlugs?: string[];
}
