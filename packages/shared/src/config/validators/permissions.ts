import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { safeJsonParse } from "../../utils/files.ts";
// ============================================================
// Permissions Validators
// ============================================================
import { PermissionsConfigSchema } from "../../agent/mode-types.ts";
import { validatePermissionsConfig, getWorkspacePermissionsPath, getSourcePermissionsPath, getAppPermissionsDir } from "../../agent/permissions-config.ts";
import type { ValidationIssue, ValidationResult } from './validation-types.ts';
import { zodErrorToIssues } from './validation-types.ts';

/**
 * Internal: Validate a single permissions.json file
 * Checks JSON syntax, Zod schema, and regex pattern validity.
 */
function validatePermissionsFile(filePath: string, displayFile: string): ValidationResult {
  // File is optional - missing is just a warning
  if (!existsSync(filePath)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file: displayFile,
        path: '',
        message: 'Permissions file does not exist (using defaults)',
        severity: 'warning',
      }],
    };
  }

  // Read file and delegate to content-based validator
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: displayFile,
        path: '',
        message: `Cannot read file: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  return validatePermissionsContent(raw, displayFile);
}

/**
 * Validate permissions config from a JSON string (no disk reads).
 * Used by PreToolUse hook to validate before writing to disk.
 * Runs Zod schema validation and regex pattern compilation checks.
 *
 * @param jsonString - The raw JSON content of the permissions file
 * @param displayFile - File name for error messages (e.g., 'permissions.json' or 'sources/github/permissions.json')
 */
export function validatePermissionsContent(jsonString: string, displayFile: string = 'permissions.json'): ValidationResult {
  const errors: ValidationIssue[] = [];

  // Parse JSON
  let content: unknown;
  try {
    content = safeJsonParse(jsonString);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: displayFile,
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Validate schema
  const result = PermissionsConfigSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, displayFile));
    return { valid: false, errors, warnings: [] };
  }

  // Validate regex patterns (semantic validation)
  const regexErrors = validatePermissionsConfig(result.data);
  for (const regexError of regexErrors) {
    errors.push({
      file: displayFile,
      path: regexError.split(':')[0] || '',
      message: regexError,
      severity: 'error',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: [],
  };
}

/**
 * Validate workspace-level permissions.json
 * @param workspaceRoot - Absolute path to workspace root folder
 */
export function validateWorkspacePermissions(workspaceRoot: string): ValidationResult {
  const permissionsPath = getWorkspacePermissionsPath(workspaceRoot);
  return validatePermissionsFile(permissionsPath, 'permissions.json');
}

/**
 * Validate source-level permissions.json
 * @param workspaceRoot - Absolute path to workspace root folder
 * @param sourceSlug - Source slug
 */
export function validateSourcePermissions(workspaceRoot: string, sourceSlug: string): ValidationResult {
  const permissionsPath = getSourcePermissionsPath(workspaceRoot, sourceSlug);
  return validatePermissionsFile(permissionsPath, `sources/${sourceSlug}/permissions.json`);
}

/**
 * Validate app-level default permissions
 */
export function validateDefaultPermissions(): ValidationResult {
  const permissionsPath = join(getAppPermissionsDir(), 'default.json');
  return validatePermissionsFile(permissionsPath, 'permissions/default.json');
}

/**
 * Validate all permissions files in a workspace
 * Includes: app-level default, workspace-level, and all source-level permissions
 */
export function validateAllPermissions(workspaceRoot: string): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Validate app-level default permissions
  const defaultResult = validateDefaultPermissions();
  errors.push(...defaultResult.errors);
  warnings.push(...defaultResult.warnings);

  // Validate workspace-level permissions
  const wsResult = validateWorkspacePermissions(workspaceRoot);
  errors.push(...wsResult.errors);
  warnings.push(...wsResult.warnings);

  // Validate all source-level permissions
  const sourcesDir = join(workspaceRoot, 'sources');
  if (existsSync(sourcesDir)) {
    const entries = readdirSync(sourcesDir);
    for (const entry of entries) {
      const entryPath = join(sourcesDir, entry);
      if (statSync(entryPath).isDirectory()) {
        const srcResult = validateSourcePermissions(workspaceRoot, entry);
        errors.push(...srcResult.errors);
        warnings.push(...srcResult.warnings);
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
 * Check if a permissions file at the given path is valid.
 * Returns true if the file exists and passes schema validation.
 */
export function isValidPermissionsFile(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const result = validatePermissionsContent(content);
    return result.valid;
  } catch {
    return false;
  }
}
