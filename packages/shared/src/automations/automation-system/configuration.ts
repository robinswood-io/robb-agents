import { isUnknownArray } from '../../utils/json.ts';
/**
 * AutomationSystem - Unified Facade for the Automations System
 *
 * Single entry point that:
 * - Creates EventBus instance (per workspace)
 * - Creates and registers all handlers
 * - Loads automations.json configuration
 * - Manages scheduler service
 * - Provides diffing for session metadata changes
 * - Provides dispose() for cleanup
 *
 * Benefits:
 * - No global state - each AutomationSystem instance is self-contained
 * - Easy to create for testing
 * - SessionManager uses ~30 lines instead of ~300
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolveAutomationsConfigPath, generateShortId } from "../resolve-config-path.ts";
import { compactAutomationHistorySync } from "../history-store.ts";
import { validateAutomationsConfig } from "../validation.ts";
import type { AutomationSystem } from '../automation-system.ts';
import { log } from './shared.ts';

// ============================================================================
  // Configuration
  // ============================================================================

  /**
   * Read, parse, and validate automations.json. Shared pipeline for loadConfig/reloadConfig.
   * Returns the raw parsed JSON alongside validation results (avoids re-reading for backfillIds).
   */
export function readAndValidateConfig(_transportOwner: AutomationSystem, configPath: string): {
    raw: unknown;
    validation: import("../types.ts").AutomationsValidationResult;
} {
    const raw: unknown = JSON.parse(readFileSync(configPath, 'utf-8'));
    const validation = validateAutomationsConfig(raw);
    return { raw, validation };
}

/**
   * Load automations configuration from automations.json.
   */
export function loadConfig(transportOwner: AutomationSystem): void {
    const configPath = resolveAutomationsConfigPath(transportOwner["options"].workspaceRootPath);
    if (!existsSync(configPath)) {
        log.debug(`[AutomationSystem] No automations config found at ${configPath}`);
        transportOwner["config"] = { automations: {} };
        return;
    }
    try {
        const { raw, validation } = transportOwner.readAndValidateConfig(configPath);
        if (!validation.valid) {
            console.warn('[AutomationSystem] Invalid automations config:', validation.errors);
            transportOwner["config"] = { automations: {} };
            return;
        }
        transportOwner["config"] = validation.config;
        transportOwner.backfillIds(configPath, raw);
        transportOwner.rotateHistory();
        const actionCount = transportOwner.getActionCount();
        log.debug(`[AutomationSystem] Loaded ${actionCount} actions from ${configPath}`);
    }
    catch (e) {
        const error = e instanceof Error ? e.message : 'Unknown error';
        console.warn('[AutomationSystem] Failed to load automations config:', error);
        transportOwner["config"] = { automations: {} };
    }
}

export function reloadConfig(transportOwner: AutomationSystem): {
    success: boolean;
    automationCount: number;
    errors: string[];
} {
    const configPath = resolveAutomationsConfigPath(transportOwner["options"].workspaceRootPath);
    if (!existsSync(configPath)) {
        transportOwner["config"] = { automations: {} };
        return { success: true, automationCount: 0, errors: [] };
    }
    try {
        const { raw, validation } = transportOwner.readAndValidateConfig(configPath);
        if (!validation.valid) {
            return { success: false, automationCount: 0, errors: validation.errors };
        }
        transportOwner["config"] = validation.config;
        transportOwner.backfillIds(configPath, raw);
        const actionCount = transportOwner.getActionCount();
        log.debug(`[AutomationSystem] Reloaded ${actionCount} actions`);
        return { success: true, automationCount: actionCount, errors: [] };
    }
    catch (e) {
        const error = e instanceof Error ? e.message : 'Unknown error';
        return { success: false, automationCount: 0, errors: [`Failed to parse JSON: ${error}`] };
    }
}

/**
   * Backfill missing IDs on matchers in the raw config.
   * Operates on the already-parsed raw JSON to avoid re-reading from disk.
   * Only writes if IDs were actually missing — no-op on subsequent loads.
   */
export function backfillIds(_transportOwner: AutomationSystem, configPath: string, raw: unknown): void {
    try {
        const obj = raw as Record<string, unknown>;
        const eventMap = (obj["automations"] ?? obj["tasks"] ?? obj["hooks"]) as Record<string, unknown[]> | undefined;
        if (!eventMap)
            return;
        let changed = false;
        for (const matchers of Object.values(eventMap)) {
            if (!isUnknownArray(matchers))
                continue;
            for (const m of matchers as Record<string, unknown>[]) {
                if (!m["id"]) {
                    m["id"] = generateShortId();
                    changed = true;
                }
            }
        }
        if (changed) {
            writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
            log.debug('[AutomationSystem] Backfilled missing matcher IDs');
        }
    }
    catch {
        // Non-critical — IDs will be backfilled on next mutation via IPC
    }
}

/**
   * Compact automations-history.jsonl on startup: two-tier retention.
   * 1) Keep only the last N entries per automation ID.
   * 2) If total still exceeds the global cap, drop oldest globally.
   * Runs synchronously during init — single-threaded, no race with concurrent appends.
   */
export function rotateHistory(transportOwner: AutomationSystem): void {
    try {
        compactAutomationHistorySync(transportOwner["options"].workspaceRootPath);
    }
    catch {
        // Non-critical — compaction failure doesn't affect functionality
    }
}

/**
   * Get total number of actions.
   */
export function getActionCount(transportOwner: AutomationSystem): number {
    if (!transportOwner["config"])
        return 0;
    return Object.values(transportOwner["config"].automations).reduce((sum, matchers) => sum + (matchers?.reduce((s, m) => s + m.actions.length, 0) ?? 0), 0);
}
