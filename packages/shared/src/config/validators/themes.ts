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
import { readFileSync } from "fs";
import { safeJsonParse } from "../../utils/files.ts";
import type { ValidationIssue, ValidationResult } from './validation-types.ts';
import { zodErrorToIssues } from './validation-types.ts';

// ============================================================
// Theme Validators
// ============================================================

const CSSColorSchema = z.string().min(1);

const ThemeDarkOverrideSchema = z.object({
  background: CSSColorSchema.optional(),
  foreground: CSSColorSchema.optional(),
  accent: CSSColorSchema.optional(),
  info: CSSColorSchema.optional(),
  success: CSSColorSchema.optional(),
  destructive: CSSColorSchema.optional(),
  paper: CSSColorSchema.optional(),
  navigator: CSSColorSchema.optional(),
  input: CSSColorSchema.optional(),
  popover: CSSColorSchema.optional(),
  popoverSolid: CSSColorSchema.optional(),
}).strict();

/**
 * Zod schema for app-level theme override files (~/.craft-agent/theme.json).
 * Allows partial overrides but rejects unknown keys.
 */
export const ThemeOverrideSchema = z.object({
  // Semantic colors
  background: CSSColorSchema.optional(),
  foreground: CSSColorSchema.optional(),
  accent: CSSColorSchema.optional(),
  info: CSSColorSchema.optional(),
  success: CSSColorSchema.optional(),
  destructive: CSSColorSchema.optional(),
  // Surface colors
  paper: CSSColorSchema.optional(),
  navigator: CSSColorSchema.optional(),
  input: CSSColorSchema.optional(),
  popover: CSSColorSchema.optional(),
  popoverSolid: CSSColorSchema.optional(),
  // Scenic mode
  mode: z.enum(['solid', 'scenic']).optional(),
  backgroundImage: z.string().optional(),
  // Dark mode overrides
  dark: ThemeDarkOverrideSchema.optional(),
}).strict()
  .refine(
    (data) => {
      const keys = Object.keys(data);
      return keys.length > 0;
    },
    { message: 'Theme override must include at least one supported field' }
  )
  .refine(
    (data) => data.mode !== 'scenic' || Boolean(data.backgroundImage),
    { message: 'backgroundImage is required when mode is scenic', path: ['backgroundImage'] }
  );

/**
 * Zod schema for preset theme files.
 * Validates theme structure and requires at least one color property.
 */
export const PresetThemeSchema = z.object({
  name: z.string().min(1, 'Theme name is required'),
  description: z.string().optional(),
  author: z.string().optional(),
  license: z.string().optional(),
  source: z.string().optional(),
  supportedModes: z.array(z.enum(['light', 'dark'])).optional(),
  // Semantic colors
  background: CSSColorSchema.optional(),
  foreground: CSSColorSchema.optional(),
  accent: CSSColorSchema.optional(),
  info: CSSColorSchema.optional(),
  success: CSSColorSchema.optional(),
  destructive: CSSColorSchema.optional(),
  // Surface colors
  paper: CSSColorSchema.optional(),
  navigator: CSSColorSchema.optional(),
  input: CSSColorSchema.optional(),
  popover: CSSColorSchema.optional(),
  popoverSolid: CSSColorSchema.optional(),
  // Scenic mode
  mode: z.enum(['solid', 'scenic']).optional(),
  backgroundImage: z.string().optional(),
  // Dark mode overrides
  dark: z.object({}).passthrough().optional(),
  // Shiki theme for syntax highlighting
  shikiTheme: z.object({
    light: z.string().optional(),
    dark: z.string().optional(),
  }).optional(),
}).refine(
  (data) => {
    const colorProps = ['background', 'foreground', 'accent', 'info', 'success', 'destructive'];
    return colorProps.some(prop => prop in data);
  },
  { message: 'Theme must have at least one color property (background, foreground, accent, info, success, or destructive)' }
);

/**
 * Validate theme content from a JSON string (no disk reads).
 * Used to check if an existing theme file is valid before deciding to overwrite.
 */
export function validateThemeContent(jsonString: string, displayFile: string = 'theme.json'): ValidationResult {
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
  const result = PresetThemeSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, displayFile));
    return { valid: false, errors, warnings: [] };
  }

  return {
    valid: true,
    errors: [],
    warnings: [],
  };
}

/**
 * Validate app-level theme override content from a JSON string (no disk reads).
 * Unlike preset validation, this accepts partial ThemeOverrides objects and rejects unknown keys.
 */
export function validateThemeOverrideContent(jsonString: string, displayFile: string = 'theme.json'): ValidationResult {
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
  const result = ThemeOverrideSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, displayFile));
    return { valid: false, errors, warnings: [] };
  }

  return {
    valid: true,
    errors: [],
    warnings: [],
  };
}

/**
 * Check if a theme file at the given path is valid.
 * Returns true if the file exists and passes schema validation.
 */
export function isValidThemeFile(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const result = validateThemeContent(content);
    return result.valid;
  } catch {
    return false;
  }
}
