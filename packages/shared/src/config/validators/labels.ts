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
// ============================================================
// Labels Validators
// ============================================================
import { validateAutoLabelRule } from "../../labels/auto/validation.ts";
import type { ValidationIssue, ValidationResult } from './validation-types.ts';
import { zodErrorToIssues } from './validation-types.ts';

const LABEL_CONFIG_FILE = 'labels/config.json';

/** Maximum nesting depth for label tree (prevents excessively deep hierarchies) */
const MAX_LABEL_DEPTH = 5;

/**
 * Zod schema for individual label configuration.
 * Recursive: each label can have optional children forming a tree.
 * IDs are simple slugs (lowercase alphanumeric + hyphens).
 */
/**
 * Zod schema for auto-label rules (regex patterns for automatic label application).
 * Validates pattern is non-empty; regex validity is checked semantically below.
 */
const AutoLabelRuleSchema = z.object({
  pattern: z.string().min(1, 'Auto-label rule pattern is required'),
  flags: z.string().optional(),
  valueTemplate: z.string().optional(),
  description: z.string().optional(),
});

const BaseLabelConfigSchema = z.object({
  id: z.string().regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    'Label ID must be a simple slug (lowercase alphanumeric + hyphens, e.g., "bug", "frontend")'
  ),
  name: z.string().min(1, 'Label name is required'),
  color: EntityColorSchema.optional(),
  icon: z.string().optional(),
  /** Optional hint: what type of value this label carries (omit for boolean labels) */
  valueType: z.enum(['string', 'number', 'date', 'link']).optional(),
  /** Auto-label rules: regex patterns that scan messages and apply labels automatically */
  autoRules: z.array(AutoLabelRuleSchema).optional(),
});

// Recursive schema: LabelConfig can have children which are also LabelConfigs.
// Zod supports lazy() for recursive types.
type LabelConfigSchemaType = z.ZodType<{
  id: string;
  name: string;
  color?: unknown;
  icon?: string;
  valueType?: 'string' | 'number' | 'date' | 'link';
  autoRules?: Array<{ pattern: string; flags?: string; valueTemplate?: string; description?: string }>;
  children?: LabelConfigSchemaType[];
}>;

const LabelConfigSchema: z.ZodType<any> = BaseLabelConfigSchema.extend({
  children: z.lazy(() => z.array(LabelConfigSchema)).optional(),
});

/**
 * Zod schema for workspace label configuration (recursive tree)
 */
const WorkspaceLabelConfigSchema = z.object({
  version: z.number().int().min(1),
  labels: z.array(LabelConfigSchema),
});

/**
 * Validate labels configuration for a workspace (reads from disk)
 * @param workspaceRoot - Absolute path to workspace root folder
 */
export function validateLabels(workspaceRoot: string): ValidationResult {
  const configPath = join(workspaceRoot, LABEL_CONFIG_FILE);
  const file = LABEL_CONFIG_FILE;

  // Labels config is optional — no config means no labels (valid state)
  if (!existsSync(configPath)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file,
        path: '',
        message: 'Labels config does not exist (no labels configured)',
        severity: 'warning',
      }],
    };
  }

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

  return validateLabelsContent(raw);
}

/**
 * Validate labels config from a JSON string (no disk reads).
 * Used by PreToolUse hook to validate before writing to disk.
 * Checks schema validation and semantic rules (unique IDs, max depth).
 */
export function validateLabelsContent(jsonString: string): ValidationResult {
  const file = 'labels/config.json';
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

  // Validate schema (recursive, includes EntityColor validation via Zod)
  const result = WorkspaceLabelConfigSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, file));
    return { valid: false, errors, warnings };
  }

  const config = result.data;

  // 1. Check for globally unique IDs across the entire tree
  const seenIds = new Set<string>();
  function checkUniqueIds(labels: any[], path: string): void {
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      if (seenIds.has(label.id)) {
        errors.push({
          file,
          path: `${path}[${i}].id`,
          message: `Duplicate label ID '${label.id}' — IDs must be globally unique across the tree`,
          severity: 'error',
          suggestion: 'Each label must have a unique ID regardless of nesting level',
        });
      }
      seenIds.add(label.id);
      if (label.children && label.children.length > 0) {
        checkUniqueIds(label.children, `${path}[${i}].children`);
      }
    }
  }
  checkUniqueIds(config.labels, 'labels');

  // 2. Check max nesting depth (prevents excessively deep hierarchies)
  function checkDepth(labels: any[], depth: number, path: string): void {
    if (depth > MAX_LABEL_DEPTH) {
      errors.push({
        file,
        path,
        message: `Label tree exceeds maximum depth of ${MAX_LABEL_DEPTH} levels`,
        severity: 'error',
        suggestion: `Flatten the hierarchy — ${MAX_LABEL_DEPTH} levels should be sufficient for any organization scheme`,
      });
      return;
    }
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      if (label.children && label.children.length > 0) {
        checkDepth(label.children, depth + 1, `${path}[${i}].children`);
      }
    }
  }
  checkDepth(config.labels, 1, 'labels');

  // 3. Validate auto-label rules (regex patterns on regular labels)
  function checkAutoRules(labels: any[], path: string): void {
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      if (label.autoRules && Array.isArray(label.autoRules)) {
        for (let j = 0; j < label.autoRules.length; j++) {
          const rule = label.autoRules[j];
          if (rule.pattern) {
            const ruleResult = validateAutoLabelRule(rule.pattern, rule.flags);
            for (const err of ruleResult.errors) {
              errors.push({
                file,
                path: `${path}[${i}].autoRules[${j}].pattern`,
                message: err,
                severity: 'error',
                suggestion: 'Fix the regex pattern or remove the rule',
              });
            }
            for (const warn of ruleResult.warnings) {
              warnings.push({
                file,
                path: `${path}[${i}].autoRules[${j}].pattern`,
                message: warn,
                severity: 'warning',
              });
            }
          } else {
            errors.push({
              file,
              path: `${path}[${i}].autoRules[${j}]`,
              message: 'Auto-label rule must have a "pattern" field',
              severity: 'error',
              suggestion: 'Add a regex pattern string to the rule',
            });
          }
        }
      }
      if (label.children && label.children.length > 0) {
        checkAutoRules(label.children, `${path}[${i}].children`);
      }
    }
  }
  checkAutoRules(config.labels, 'labels');

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
