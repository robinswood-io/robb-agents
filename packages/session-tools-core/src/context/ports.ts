/**
 * Session Tools Core - Context Interface
 *
 * Defines the abstract context interface that both Claude (in-process)
 * and Codex (subprocess) implementations must provide.
 *
 * This enables writing tool handlers once and running them in both environments.
 */
import type { AuthRequest, SourceConfig } from "../types.ts";

// ============================================================
// Source Credential Types
// ============================================================

/**
 * Loaded source with context for credential operations.
 * Note: guide field omitted as credential manager doesn't use it.
 */
export interface LoadedSource {
  config: SourceConfig;
  folderPath: string;
  workspaceRootPath: string;
  workspaceId: string;
}

// ============================================================
// Callback Interface
// ============================================================

/**
 * Callbacks for session tool operations.
 * Both Claude and Codex implement this interface differently:
 * - Claude: Direct function calls via registry
 * - Codex: JSON messages over stderr
 */
export interface SessionToolCallbacks {
  /**
   * Called when a plan is submitted.
   * Claude: calls onPlanSubmitted callback
   * Codex: sends __CALLBACK__ message to stderr
   */
  onPlanSubmitted(planPath: string): void;

  /**
   * Called when authentication is requested.
   * Claude: calls onAuthRequest callback + forceAbort
   * Codex: sends __CALLBACK__ message to stderr
   */
  onAuthRequest(request: AuthRequest): void;
}

// ============================================================
// File System Interface
// ============================================================

/**
 * File system abstraction for portability.
 * Allows mocking in tests and different implementations in different environments.
 */
export interface FileSystemInterface {
  /** Check if file/directory exists */
  exists(path: string): boolean;

  /** Read file as UTF-8 string */
  readFile(path: string): string;

  /** Read file as Buffer (for binary/images) */
  readFileBuffer(path: string): Buffer;

  /** Write file */
  writeFile(path: string, content: string): void;

  /** Check if path is a directory */
  isDirectory(path: string): boolean;

  /** List directory contents */
  readdir(path: string): string[];

  /** Get file stats */
  stat(path: string): { size: number; isDirectory(): boolean };
}

// ============================================================
// Credential Manager Interface
// ============================================================

/**
 * Credential manager abstraction.
 * Claude has full access to credential stores.
 * Codex may have limited or no access (relies on main process).
 */
export interface CredentialManagerInterface {
  /**
   * Check if a source has valid, non-expired credentials
   */
  hasValidCredentials(source: LoadedSource): Promise<boolean>;

  /**
   * Get the current access token for a source (null if expired/missing)
   */
  getToken(source: LoadedSource): Promise<string | null>;

  /**
   * Refresh the access token for a source
   */
  refresh(source: LoadedSource): Promise<string | null>;
}

// ============================================================
// Validator Interface
// ============================================================

/**
 * Config validation interface.
 * Claude uses full Zod validators from packages/shared.
 * Codex uses simplified validators from session-tools-core.
 */
export interface ValidatorInterface {
  validateConfig(): import("../types.js").ValidationResult;
  validateSource(workspaceRootPath: string, sourceSlug: string): import("../types.js").ValidationResult;
  validateAllSources(workspaceRootPath: string): import("../types.js").ValidationResult;
  validateStatuses(workspaceRootPath: string): import("../types.js").ValidationResult;
  validatePreferences(): import("../types.js").ValidationResult;
  validatePermissions(workspaceRootPath: string, sourceSlug?: string): import("../types.js").ValidationResult;
  validateAutomations(workspaceRootPath: string): import("../types.js").ValidationResult;
  validateToolIcons(): import("../types.js").ValidationResult;
  validateAll(workspaceRootPath: string): import("../types.js").ValidationResult;
  validateSkill(workspaceRootPath: string, skillSlug: string): import("../types.js").ValidationResult;
}
