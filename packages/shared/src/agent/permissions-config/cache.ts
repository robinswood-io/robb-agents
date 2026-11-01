import { join } from "path";
import { debug } from "../../utils/debug.ts";
import { CONFIG_DIR } from "../../config/paths.ts";
import { SAFE_MODE_CONFIG } from "../mode-types.ts";
import { getAppPermissionsDir, loadDefaultPermissions } from './app-defaults.ts';
import type { MergedPermissionsConfig, PermissionsContext, PermissionsCustomConfig } from './contracts.ts';
import { getWorkspacePermissionsPath, loadSourcePermissionsConfig, loadWorkspacePermissionsConfig } from './storage.ts';
import { compileBlockedCommandHint, shouldCompileBashPattern, validateRegex } from './validation.ts';

// ============================================================
// Config Cache
// ============================================================

/**
 * In-memory cache for parsed permissions configs
 * Invalidated on file changes via ConfigWatcher
 */
class PermissionsConfigCache {
  private workspaceConfigs: Map<string, PermissionsCustomConfig | null> = new Map();
  private sourceConfigs: Map<string, PermissionsCustomConfig | null> = new Map();
  private mergedConfigs: Map<string, MergedPermissionsConfig> = new Map();

  // App-level default permissions (loaded from ~/.craft-agent/permissions/default.json)
  private defaultConfig: PermissionsCustomConfig | null | undefined = undefined; // undefined = not loaded yet

  /**
   * Get or load app-level default permissions
   * These come from ~/.craft-agent/permissions/default.json
   */
  private getDefaultConfig(): PermissionsCustomConfig | null {
    if (this.defaultConfig === undefined) {
      this.defaultConfig = loadDefaultPermissions();
    }
    return this.defaultConfig;
  }

  /**
   * Get or load workspace config
   */
  getWorkspaceConfig(workspaceRootPath: string): PermissionsCustomConfig | null {
    if (!this.workspaceConfigs.has(workspaceRootPath)) {
      this.workspaceConfigs.set(workspaceRootPath, loadWorkspacePermissionsConfig(workspaceRootPath));
    }
    return this.workspaceConfigs.get(workspaceRootPath) ?? null;
  }

  /**
   * Get or load source config
   */
  getSourceConfig(workspaceRootPath: string, sourceSlug: string): PermissionsCustomConfig | null {
    const key = `${workspaceRootPath}::${sourceSlug}`;
    if (!this.sourceConfigs.has(key)) {
      this.sourceConfigs.set(key, loadSourcePermissionsConfig(workspaceRootPath, sourceSlug));
    }
    return this.sourceConfigs.get(key) ?? null;
  }

  /**
   * Invalidate app-level default permissions (called by ConfigWatcher)
   * This clears all merged configs since defaults affect everything
   */
  invalidateDefaults(): void {
    debug('[Permissions] Invalidating app-level default permissions');
    this.defaultConfig = undefined;
    // Clear ALL merged configs since defaults affect everything
    this.mergedConfigs.clear();
  }

  /**
   * Invalidate workspace config (called by ConfigWatcher)
   */
  invalidateWorkspace(workspaceRootPath: string): void {
    debug(`[Permissions] Invalidating workspace config: ${workspaceRootPath}`);
    this.workspaceConfigs.delete(workspaceRootPath);
    // Clear all merged configs for this workspace
    for (const key of this.mergedConfigs.keys()) {
      if (key.startsWith(`${workspaceRootPath}::`)) {
        this.mergedConfigs.delete(key);
      }
    }
  }

  /**
   * Invalidate source config (called by ConfigWatcher)
   */
  invalidateSource(workspaceRootPath: string, sourceSlug: string): void {
    debug(`[Permissions] Invalidating source config: ${workspaceRootPath}/${sourceSlug}`);
    this.sourceConfigs.delete(`${workspaceRootPath}::${sourceSlug}`);
    // Clear merged configs that include this source
    // Cache key format: "{workspaceRootPath}::{source1},{source2},..."
    // Use precise matching to avoid false positives (e.g., "linear" matching "linear-triage")
    for (const key of this.mergedConfigs.keys()) {
      if (!key.startsWith(`${workspaceRootPath}::`)) continue;

      // Extract sources portion after the ::
      const sourcesStr = key.slice(workspaceRootPath.length + 2);
      if (!sourcesStr) continue;

      // Check for exact match: at start, end, or between commas
      const sources = sourcesStr.split(',');
      if (sources.includes(sourceSlug)) {
        this.mergedConfigs.delete(key);
      }
    }
  }


  /**
   * Get merged config for a context (workspace + active sources)
   * Uses additive merging: custom configs extend defaults
   */
  getMergedConfig(context: PermissionsContext): MergedPermissionsConfig {
    const cacheKey = this.buildCacheKey(context);

    if (!this.mergedConfigs.has(cacheKey)) {
      const merged = this.buildMergedConfig(context);
      this.mergedConfigs.set(cacheKey, merged);
    }

    return this.mergedConfigs.get(cacheKey)!;
  }

  private buildMergedConfig(context: PermissionsContext): MergedPermissionsConfig {
    const defaults = SAFE_MODE_CONFIG;

    // Start with hardcoded fallback defaults (blocked tools are fixed, display settings)
    // blockedTools (Write, Edit, MultiEdit, NotebookEdit) come from SAFE_MODE_CONFIG
    // and cannot be modified via permissions.json
    const merged: MergedPermissionsConfig = {
      blockedTools: new Set(defaults.blockedTools),
      readOnlyBashPatterns: [...defaults.readOnlyBashPatterns],
      blockedCommandHints: [...(defaults.blockedCommandHints ?? [])],
      readOnlyMcpPatterns: [...defaults.readOnlyMcpPatterns],
      allowedApiEndpoints: [],
      allowedWritePaths: [],
      displayName: defaults.displayName,
      shortcutHint: defaults.shortcutHint,
      // Add permission file paths for actionable error messages
      permissionPaths: {
        workspacePath: getWorkspacePermissionsPath(context.workspaceRootPath),
        appDefaultPath: join(getAppPermissionsDir(), 'default.json'),
        docsPath: join(CONFIG_DIR, 'docs', 'permissions.md'),
      },
    };

    // Load and apply app-level default permissions from JSON
    // This is where the actual bash/MCP patterns come from
    const defaultConfig = this.getDefaultConfig();
    if (defaultConfig) {
      this.applyDefaultConfig(merged, defaultConfig);
    }

    // Add workspace-level customizations
    const wsConfig = this.getWorkspaceConfig(context.workspaceRootPath);
    if (wsConfig) {
      this.applyCustomConfig(merged, wsConfig);
    }

    // Add source-level customizations (additive, with auto-scoped MCP patterns)
    if (context.activeSourceSlugs) {
      for (const sourceSlug of context.activeSourceSlugs) {
        const srcConfig = this.getSourceConfig(context.workspaceRootPath, sourceSlug);
        if (srcConfig) {
          // Use applySourceConfig which auto-scopes MCP patterns to this source
          this.applySourceConfig(merged, srcConfig, sourceSlug);
        }
      }
    }

    return merged;
  }

  /**
   * Apply app-level default config (from default.json)
   * This adds bash/MCP patterns from the JSON config. Blocked tools are hardcoded
   * in SAFE_MODE_CONFIG and not loaded from JSON.
   */
  private applyDefaultConfig(merged: MergedPermissionsConfig, config: PermissionsCustomConfig): void {
    // Add allowed bash patterns (as CompiledBashPattern with metadata for error messages)
    for (const patternEntry of config.allowedBashPatterns) {
      if (!shouldCompileBashPattern(patternEntry.pattern)) {
        debug(`[Permissions] Skipping craft-agent bash pattern (feature disabled): ${patternEntry.pattern}`);
        continue;
      }

      const regex = validateRegex(patternEntry.pattern);
      if (regex) {
        merged.readOnlyBashPatterns.push({
          regex,
          source: patternEntry.pattern,
          ...(patternEntry.comment !== undefined ? { comment: patternEntry.comment } : {}),
        });
      } else {
        debug(`[Permissions] Invalid default bash pattern, skipping: ${patternEntry.pattern}`);
      }
    }

    // Add allowed MCP patterns
    for (const pattern of config.allowedMcpPatterns) {
      const regex = validateRegex(pattern);
      if (regex) {
        merged.readOnlyMcpPatterns.push(regex);
      } else {
        debug(`[Permissions] Invalid default MCP pattern, skipping: ${pattern}`);
      }
    }

    // Add allowed API endpoints
    for (const rule of config.allowedApiEndpoints) {
      const pathRegex = validateRegex(rule.path);
      if (pathRegex) {
        merged.allowedApiEndpoints.push({
          method: rule.method,
          pathPattern: pathRegex,
        });
      }
    }

    // Add allowed write paths
    for (const pattern of config.allowedWritePaths) {
      merged.allowedWritePaths.push(pattern);
    }

    // Add blocked command hints (contextual guidance for blocked bash commands)
    for (const hint of config.blockedCommandHints) {
      const compiled = compileBlockedCommandHint(hint);
      if (compiled) {
        merged.blockedCommandHints.push(compiled);
      }
    }
  }

  private applyCustomConfig(merged: MergedPermissionsConfig, custom: PermissionsCustomConfig): void {
    // Add allowed bash patterns (making config more permissive)
    for (const patternEntry of custom.allowedBashPatterns) {
      if (!shouldCompileBashPattern(patternEntry.pattern)) {
        debug(`[Permissions] Skipping craft-agent bash pattern (feature disabled): ${patternEntry.pattern}`);
        continue;
      }

      const regex = validateRegex(patternEntry.pattern);
      if (regex) {
        merged.readOnlyBashPatterns.push({
          regex,
          source: patternEntry.pattern,
          ...(patternEntry.comment !== undefined ? { comment: patternEntry.comment } : {}),
        });
      } else {
        debug(`[Permissions] Invalid bash pattern, skipping: ${patternEntry.pattern}`);
      }
    }

    // Add allowed MCP patterns
    for (const pattern of custom.allowedMcpPatterns) {
      const regex = validateRegex(pattern);
      if (regex) {
        merged.readOnlyMcpPatterns.push(regex);
      } else {
        debug(`[Permissions] Invalid MCP pattern, skipping: ${pattern}`);
      }
    }

    // Add allowed API endpoints (fine-grained)
    for (const rule of custom.allowedApiEndpoints) {
      const pathRegex = validateRegex(rule.path);
      if (pathRegex) {
        merged.allowedApiEndpoints.push({
          method: rule.method,
          pathPattern: pathRegex,
        });
      } else {
        debug(`[Permissions] Invalid API endpoint path pattern, skipping: ${rule.path}`);
      }
    }

    // Add allowed write paths (glob patterns, stored as strings)
    for (const pattern of custom.allowedWritePaths) {
      merged.allowedWritePaths.push(pattern);
    }

    // Add blocked command hints
    for (const hint of custom.blockedCommandHints) {
      const compiled = compileBlockedCommandHint(hint);
      if (compiled) {
        merged.blockedCommandHints.push(compiled);
      }
    }
  }

  /**
   * Apply source-specific config with auto-scoped MCP patterns.
   * MCP patterns in a source's permissions.json are automatically prefixed with
   * mcp__<sourceSlug>__ so they only apply to that source's tools.
   * This prevents cross-source leakage when using simple patterns like "list".
   */
  private applySourceConfig(
    merged: MergedPermissionsConfig,
    custom: PermissionsCustomConfig,
    sourceSlug: string
  ): void {
    // Write paths - apply normally (global effect)
    for (const pattern of custom.allowedWritePaths) {
      merged.allowedWritePaths.push(pattern);
    }

    // MCP patterns - AUTO-SCOPE to this source
    // User writes: "list" → becomes: "mcp__<sourceSlug>__.*list"
    // This ensures patterns only match tools from THIS source
    for (const pattern of custom.allowedMcpPatterns) {
      const scopedPattern = `mcp__${sourceSlug}__.*${pattern}`;
      const regex = validateRegex(scopedPattern);
      if (regex) {
        merged.readOnlyMcpPatterns.push(regex);
        debug(`[Permissions] Scoped MCP pattern for ${sourceSlug}: ${pattern} → ${scopedPattern}`);
      } else {
        debug(`[Permissions] Invalid MCP pattern after scoping, skipping: ${scopedPattern}`);
      }
    }

    // Bash patterns - apply normally (not source-specific)
    for (const patternEntry of custom.allowedBashPatterns) {
      if (!shouldCompileBashPattern(patternEntry.pattern)) {
        debug(`[Permissions] Skipping craft-agent bash pattern (feature disabled): ${patternEntry.pattern}`);
        continue;
      }

      const regex = validateRegex(patternEntry.pattern);
      if (regex) {
        merged.readOnlyBashPatterns.push({
          regex,
          source: patternEntry.pattern,
          ...(patternEntry.comment !== undefined ? { comment: patternEntry.comment } : {}),
        });
      } else {
        debug(`[Permissions] Invalid bash pattern, skipping: ${patternEntry.pattern}`);
      }
    }

    // API endpoints - apply normally (API tools are already source-scoped as api_<slug>)
    for (const rule of custom.allowedApiEndpoints) {
      const pathRegex = validateRegex(rule.path);
      if (pathRegex) {
        merged.allowedApiEndpoints.push({
          method: rule.method,
          pathPattern: pathRegex,
        });
      } else {
        debug(`[Permissions] Invalid API endpoint path pattern, skipping: ${rule.path}`);
      }
    }

    // Blocked command hints - apply normally (bash is session-level)
    for (const hint of custom.blockedCommandHints) {
      const compiled = compileBlockedCommandHint(hint);
      if (compiled) {
        merged.blockedCommandHints.push(compiled);
      }
    }
  }

  private buildCacheKey(context: PermissionsContext): string {
    const sources = context.activeSourceSlugs?.sort().join(',') ?? '';
    return `${context.workspaceRootPath}::${sources}`;
  }

  /**
   * Clear all cached configs
   */
  clear(): void {
    this.defaultConfig = undefined;
    this.workspaceConfigs.clear();
    this.sourceConfigs.clear();
    this.mergedConfigs.clear();
  }
}

// Singleton instance
export const permissionsConfigCache = new PermissionsConfigCache();
