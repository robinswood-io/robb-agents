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
// ============================================================
// Tool Icons Validators
// ============================================================
import { getToolIconsDir } from "../storage.ts";
import type { ValidationIssue, ValidationResult } from './validation-types.ts';
import { zodErrorToIssues } from './validation-types.ts';

/**
 * Zod schema for a single tool icon entry in tool-icons.json.
 * Each entry maps CLI commands to an icon file.
 */
const ToolIconEntrySchema = z.object({
  id: z.string().min(1, 'Tool ID is required').regex(
    /^[a-z0-9-]+$/,
    'ID must be lowercase alphanumeric with hyphens (e.g., "my-tool")'
  ),
  displayName: z.string().min(1, 'Display name is required'),
  icon: z.string().min(1, 'Icon filename is required'),
  commands: z.array(z.string().min(1)).min(1, 'At least one command is required'),
});

/**
 * Zod schema for the full tool-icons.json config.
 * Contains a version number and array of tool icon mappings.
 */
const ToolIconsConfigSchema = z.object({
  version: z.number().int().min(1, 'Version must be a positive integer'),
  tools: z.array(ToolIconEntrySchema),
});

/**
 * Validate tool-icons config from a JSON string (no disk reads).
 * Used by PreToolUse hook to validate before writing to disk.
 * Checks JSON syntax, Zod schema, duplicate IDs, and duplicate commands.
 */
export function validateToolIconsContent(jsonString: string): ValidationResult {
  const file = 'tool-icons/tool-icons.json';
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

  // Validate against Zod schema
  const result = ToolIconsConfigSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, file));
    return { valid: false, errors, warnings };
  }

  const config = result.data;

  // Semantic validation: check for duplicate tool IDs
  const seenIds = new Set<string>();
  for (const tool of config.tools) {
    if (seenIds.has(tool.id)) {
      errors.push({
        file,
        path: `tools[id=${tool.id}]`,
        message: `Duplicate tool ID '${tool.id}'`,
        severity: 'error',
        suggestion: 'Each tool must have a unique ID',
      });
    }
    seenIds.add(tool.id);
  }

  // Semantic validation: warn on duplicate commands across tools
  const seenCommands = new Map<string, string>();
  for (const tool of config.tools) {
    for (const cmd of tool.commands) {
      if (seenCommands.has(cmd)) {
        warnings.push({
          file,
          path: `tools[id=${tool.id}].commands`,
          message: `Command '${cmd}' is also mapped by tool '${seenCommands.get(cmd)}'`,
          severity: 'warning',
          suggestion: 'Commands should be unique across tools for unambiguous icon resolution',
        });
      } else {
        seenCommands.set(cmd, tool.id);
      }
    }
  }

  // Validate icon file extensions
  const validIconExtensions = new Set(['.png', '.ico', '.svg', '.jpg', '.jpeg']);
  for (const tool of config.tools) {
    const ext = tool.icon.includes('.') ? '.' + tool.icon.split('.').pop()!.toLowerCase() : '';
    if (!validIconExtensions.has(ext)) {
      warnings.push({
        file,
        path: `tools[id=${tool.id}].icon`,
        message: `Icon '${tool.icon}' has unrecognized extension '${ext}'`,
        severity: 'warning',
        suggestion: 'Supported formats: .png, .ico, .svg, .jpg',
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
 * Validate tool-icons/tool-icons.json from disk.
 * Reads the file, runs content validation, and also checks that referenced icon files exist.
 */
export function validateToolIcons(): ValidationResult {
  const toolIconsDir = getToolIconsDir();
  const configPath = join(toolIconsDir, 'tool-icons.json');
  const file = 'tool-icons/tool-icons.json';

  // File is optional — missing is just a warning
  if (!existsSync(configPath)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file,
        path: '',
        message: 'Tool icons config does not exist (using defaults)',
        severity: 'warning',
      }],
    };
  }

  // Read file and delegate to content validator
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

  const result = validateToolIconsContent(raw);

  // Filesystem-specific check: verify referenced icon files exist
  try {
    const parsed = safeJsonParse(raw) as Record<string, unknown>;
    if (parsed.tools && Array.isArray(parsed.tools)) {
      for (const tool of parsed.tools) {
        if (tool.icon) {
          const iconPath = join(toolIconsDir, tool.icon);
          if (!existsSync(iconPath)) {
            result.warnings.push({
              file: `tool-icons/${tool.icon}`,
              path: `tools[id=${tool.id}].icon`,
              message: `Icon file '${tool.icon}' not found in tool-icons directory`,
              severity: 'warning',
              suggestion: `Place '${tool.icon}' in ~/.craft-agent/tool-icons/`,
            });
          }
        }
      }
    }
  } catch {
    // JSON parse errors already reported by content validator
  }

  return result;
}
