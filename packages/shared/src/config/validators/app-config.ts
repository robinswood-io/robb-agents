import { existsSync, readFileSync } from "fs";
import { safeJsonParse } from "../../utils/files.ts";
import { isValidProviderAuthCombination } from "../llm-connections.ts";
import { validateAutomations } from "../../automations/index.ts";
import { validateLabels } from './labels.ts';
import { validateAllPermissions } from './permissions.ts';
import { validateAllSkills } from './skills.ts';
import { validateAllSources } from './sources.ts';
import { validateStatuses } from './statuses.ts';
import { validateToolIcons } from './tool-icons.ts';
import type { ValidationIssue, ValidationResult } from './validation-types.ts';
import { CONFIG_FILE, PREFERENCES_FILE, StoredConfigSchema, UserPreferencesSchema, zodErrorToIssues } from './validation-types.ts';

/**
 * Validate config.json
 */
export function validateConfig(): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Check if file exists
  if (!existsSync(CONFIG_FILE)) {
    return {
      valid: false,
      errors: [{
        file: 'config.json',
        path: '',
        message: 'Config file does not exist',
        severity: 'error',
        suggestion: 'Run setup to create initial configuration',
      }],
      warnings: [],
    };
  }

  // Parse JSON
  let content: unknown;
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    content = safeJsonParse(raw);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: 'config.json',
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Validate schema
  const result = StoredConfigSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, 'config.json'));
  } else {
    const config = result.data;

    // Semantic validations
    if (config.activeWorkspaceId && config.workspaces.length > 0) {
      const activeExists = config.workspaces.some(w => w.id === config.activeWorkspaceId);
      if (!activeExists) {
        errors.push({
          file: 'config.json',
          path: 'activeWorkspaceId',
          message: `Active workspace ID '${config.activeWorkspaceId}' does not exist in workspaces array`,
          severity: 'error',
          suggestion: 'Set activeWorkspaceId to an existing workspace ID or null',
        });
      }
    }

    // Validate LLM connections
    if (config.llmConnections) {
      const seenSlugs = new Set<string>();
      for (const [i, conn] of config.llmConnections.entries()) {
        // Check for duplicate slugs
        if (seenSlugs.has(conn.slug)) {
          errors.push({
            file: 'config.json',
            path: `llmConnections[${i}].slug`,
            message: `Duplicate connection slug '${conn.slug}'`,
            severity: 'error',
            suggestion: 'Each connection must have a unique slug',
          });
        }
        seenSlugs.add(conn.slug);

        // Validate provider/auth combination
        if (!isValidProviderAuthCombination(conn.providerType, conn.authType)) {
          warnings.push({
            file: 'config.json',
            path: `llmConnections[${i}]`,
            message: `Invalid provider/auth combination: providerType='${conn.providerType}' with authType='${conn.authType}'`,
            severity: 'warning',
            suggestion: 'Check supported auth types for this provider',
          });
        }
      }

      // Validate defaultLlmConnection references an existing connection
      if (config.defaultLlmConnection) {
        const exists = config.llmConnections.some(c => c.slug === config.defaultLlmConnection);
        if (!exists) {
          warnings.push({
            file: 'config.json',
            path: 'defaultLlmConnection',
            message: `Default LLM connection '${config.defaultLlmConnection}' does not exist in llmConnections array`,
            severity: 'warning',
            suggestion: 'Set defaultLlmConnection to an existing connection slug',
          });
        }
      }
    }

  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate preferences.json
 */
export function validatePreferences(): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Check if file exists (preferences are optional)
  if (!existsSync(PREFERENCES_FILE)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file: 'preferences.json',
        path: '',
        message: 'Preferences file does not exist (using defaults)',
        severity: 'warning',
      }],
    };
  }

  // Parse JSON
  let content: unknown;
  try {
    const raw = readFileSync(PREFERENCES_FILE, 'utf-8');
    content = safeJsonParse(raw);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: 'preferences.json',
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Validate schema
  const result = UserPreferencesSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, 'preferences.json'));
  } else {
    const prefs = result.data;

    // Warn about missing recommended fields
    if (!prefs.name) {
      warnings.push({
        file: 'preferences.json',
        path: 'name',
        message: 'User name is not set',
        severity: 'warning',
        suggestion: 'Setting a name helps personalize agent responses',
      });
    }

    if (!prefs.timezone) {
      warnings.push({
        file: 'preferences.json',
        path: 'timezone',
        message: 'Timezone is not set',
        severity: 'warning',
        suggestion: 'Setting timezone helps with date/time formatting',
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate all config files
 * @param workspaceId - Optional workspace ID for source validation
 * @param workspaceRoot - Optional workspace root path for skill and status validation
 */
export function validateAll(workspaceId?: string, workspaceRoot?: string): ValidationResult {
  const results: ValidationResult[] = [
    validateConfig(),
    validatePreferences(),
    validateToolIcons(),
  ];

  // Include workspace-scoped validations if workspaceId is provided
  if (workspaceId) {
    results.push(validateAllSources(workspaceId));
  }

  // Include skill, status, label, automations, and permissions validation if workspaceRoot is provided
  if (workspaceRoot) {
    results.push(validateAllSkills(workspaceRoot));
    results.push(validateStatuses(workspaceRoot));
    results.push(validateLabels(workspaceRoot));
    results.push(validateAutomations(workspaceRoot));
    results.push(validateAllPermissions(workspaceRoot));
  }

  const allErrors = results.flatMap(r => r.errors);
  const allWarnings = results.flatMap(r => r.warnings);

  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings,
  };
}
