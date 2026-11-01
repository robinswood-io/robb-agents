/**
 * Config Validators
 *
 * Zod schemas and validation utilities for config files.
 * Used by agents to validate config changes before they take effect.
 *
 * Validates:
 * - config.json: Main app configuration
 * - preferences.json: User preferences
 * - sources/{slug}/config.json: Workspace-scoped source configs
 * - permissions.json: Permission rules for Explore mode
 * - tool-icons/tool-icons.json: CLI tool icon mappings
 */
import { z } from "zod";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { safeJsonParse } from "../../utils/files.ts";
import { EntityColorSchema } from "../../colors/validate.ts";
import type { ValidationIssue, ValidationResult } from './validation-types.ts';
import { zodErrorToIssues } from './validation-types.ts';

// ============================================================
// Status Validators
// ============================================================

const STATUS_CONFIG_FILE = 'statuses/config.json';

/** Required fixed statuses that must always exist */
const REQUIRED_FIXED_STATUS_IDS = ['todo', 'done', 'cancelled'] as const;

/**
 * Status icons are simple strings: emoji characters, URLs, or local filenames
 * such as "in-progress.svg" which resolve to statuses/icons/in-progress.svg.
 * When icon is omitted, local icon files (statuses/icons/{id}.svg) are still
 * auto-discovered at runtime.
 */
const StatusIconSchema = z.string();

/**
 * Zod schema for individual status configuration
 */
const StatusConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'Status ID must be lowercase alphanumeric with hyphens'),
  label: z.string().min(1, 'Status label is required'),
  color: EntityColorSchema.optional(),
  icon: StatusIconSchema.optional(),
  category: z.enum(['open', 'closed']),
  isFixed: z.boolean(),
  isDefault: z.boolean(),
  order: z.number().int().min(0),
});

/**
 * Zod schema for workspace status configuration
 */
const WorkspaceStatusConfigSchema = z.object({
  version: z.number().int().min(1),
  statuses: z.array(StatusConfigSchema),
  defaultStatusId: z.string().min(1),
});

/**
 * Validate statuses configuration for a workspace
 * @param workspaceRoot - Absolute path to workspace root folder
 */
export function validateStatuses(workspaceRoot: string): ValidationResult {
  const configPath = join(workspaceRoot, STATUS_CONFIG_FILE);
  const file = STATUS_CONFIG_FILE;

  // Check if config file exists (optional - defaults are used if missing)
  if (!existsSync(configPath)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file,
        path: '',
        message: 'Status config does not exist (using defaults)',
        severity: 'warning',
        suggestion: 'Statuses will use default configuration. Edit to customize.',
      }],
    };
  }

  // Read file and delegate to content-based validator
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Cannot read file: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Icons are auto-discovered from statuses/icons/{id}.{ext} at runtime,
  // not referenced in config, so no FS checks needed here.
  return validateStatusesContent(raw);
}

/**
 * Validate statuses config from a JSON string (no disk reads).
 * Used by PreToolUse hook to validate before writing to disk.
 * Runs schema validation and semantic checks. Skips icon file existence checks.
 */
export function validateStatusesContent(jsonString: string): ValidationResult {
  const file = 'statuses/config.json';
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Parse JSON
  let content: unknown;
  try {
    content = safeJsonParse(jsonString);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Validate schema
  const result = WorkspaceStatusConfigSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, file));
    return { valid: false, errors, warnings };
  }

  const config = result.data;

  // Semantic validations (same as validateStatuses but without FS checks)

  // 1. Check required fixed statuses exist
  const statusIds = new Set(config.statuses.map(s => s.id));
  for (const requiredId of REQUIRED_FIXED_STATUS_IDS) {
    if (!statusIds.has(requiredId)) {
      errors.push({
        file,
        path: 'statuses',
        message: `Required fixed status '${requiredId}' is missing`,
        severity: 'error',
        suggestion: `Add the '${requiredId}' status - it's required for the system to function`,
      });
    }
  }

  // 2. Check for duplicate IDs
  const seenIds = new Set<string>();
  for (const status of config.statuses) {
    if (seenIds.has(status.id)) {
      errors.push({
        file,
        path: `statuses[id=${status.id}]`,
        message: `Duplicate status ID '${status.id}'`,
        severity: 'error',
        suggestion: 'Each status must have a unique ID',
      });
    }
    seenIds.add(status.id);
  }

  // 3. Check defaultStatusId references an existing status
  if (!statusIds.has(config.defaultStatusId)) {
    errors.push({
      file,
      path: 'defaultStatusId',
      message: `Default status '${config.defaultStatusId}' does not exist in statuses array`,
      severity: 'error',
      suggestion: 'Set defaultStatusId to an existing status ID (typically "todo")',
    });
  }

  // 4. Check fixed statuses have correct isFixed flag
  for (const status of config.statuses) {
    const shouldBeFixed = (REQUIRED_FIXED_STATUS_IDS as readonly string[]).includes(status.id);
    if (shouldBeFixed && !status.isFixed) {
      warnings.push({
        file,
        path: `statuses[id=${status.id}].isFixed`,
        message: `Status '${status.id}' should have isFixed: true`,
        severity: 'warning',
        suggestion: 'This is a required system status and should be marked as fixed',
      });
    }
  }

  // 5. Check that at least one status is in each category
  const hasOpen = config.statuses.some(s => s.category === 'open');
  const hasClosed = config.statuses.some(s => s.category === 'closed');
  if (!hasOpen) {
    errors.push({
      file,
      path: 'statuses',
      message: 'No status with category "open" - sessions will not appear in inbox',
      severity: 'error',
    });
  }
  if (!hasClosed) {
    warnings.push({
      file,
      path: 'statuses',
      message: 'No status with category "closed" - sessions cannot be archived',
      severity: 'warning',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
