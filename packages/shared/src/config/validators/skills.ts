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
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
// ============================================================
// Skill Validators
// ============================================================
import matter from "gray-matter";
import { getWorkspaceSkillsPath } from "../../workspaces/storage.ts";
import { basename, extname } from "path";
import type { ValidationIssue, ValidationResult } from './validation-types.ts';
import { zodErrorToIssues } from './validation-types.ts';

/**
 * Schema for skill metadata (SKILL.md frontmatter)
 */
export const SkillMetadataSchema = z.object({
  name: z.string().min(1, "Add a 'name' field with a human-readable title (e.g., 'Git Commit Helper')"),
  description: z.string().min(1, "Add a 'description' field explaining what this skill does and when to use it (1-2 sentences)"),
  globs: z.array(z.string()).optional(),
  alwaysAllow: z.array(z.string()).optional(),
});

/**
 * Find icon file in skill directory
 */
function findSkillIconForValidation(skillDir: string): string | null {
  const iconExtensions = ['.svg', '.png', '.jpg', '.jpeg'];

  for (const ext of iconExtensions) {
    const iconPath = join(skillDir, `icon${ext}`);
    if (existsSync(iconPath)) {
      return iconPath;
    }
  }

  return null;
}

/**
 * Validate a skill folder
 * @param workspaceRoot - Absolute path to workspace root folder
 * @param slug - Skill directory name
 */
export function validateSkill(workspaceRoot: string, slug: string): ValidationResult {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  const skillDir = join(skillsDir, slug);
  const skillFile = join(skillDir, 'SKILL.md');
  const file = `skills/${slug}/SKILL.md`;

  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // 1. Check directory exists (slug format is validated by validateSkillContent below)
  if (!existsSync(skillDir)) {
    return {
      valid: false,
      errors: [{
        file: `skills/${slug}`,
        path: '',
        message: `Skill folder '${slug}' does not exist`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // 3. Check SKILL.md exists
  if (!existsSync(skillFile)) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: 'SKILL.md not found',
        severity: 'error',
        suggestion: 'Create a SKILL.md file with YAML frontmatter',
      }],
      warnings: [],
    };
  }

  // 4. Read and validate content using content-based validator
  let content: string;
  try {
    content = readFileSync(skillFile, 'utf-8');
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

  // Delegate content validation (frontmatter schema + body non-empty + slug format)
  const contentResult = validateSkillContent(content, slug);
  errors.push(...contentResult.errors);

  // 5. FS-only checks: icon existence (warnings)
  const iconPath = findSkillIconForValidation(skillDir);
  if (iconPath) {
    const ext = extname(iconPath).toLowerCase();
    if (!['.svg', '.png', '.jpg', '.jpeg'].includes(ext)) {
      warnings.push({
        file: `skills/${slug}/${basename(iconPath)}`,
        path: '',
        message: `Unexpected icon format: ${ext}`,
        severity: 'warning',
        suggestion: 'Use .svg, .png, or .jpg for icons',
      });
    }
  } else {
    const searchTerm = slug.replace(/-/g, ' ');
    warnings.push({
      file: `skills/${slug}/`,
      path: 'icon',
      message: 'No icon found',
      severity: 'warning',
      suggestion: `Search for '${searchTerm} icon' on heroicons.com, lucide.dev, or icons8.com. Save as icon.svg in the skill folder.`,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate skill SKILL.md content from a string (no disk reads).
 * Used by PreToolUse hook to validate before writing to disk.
 * Checks frontmatter schema and non-empty body. Skips icon/folder checks.
 *
 * @param markdownContent - The full SKILL.md file content
 * @param slug - The skill slug (folder name), used for slug format validation
 */
export function validateSkillContent(markdownContent: string, slug: string): ValidationResult {
  const file = `skills/${slug}/SKILL.md`;
  const errors: ValidationIssue[] = [];

  // 1. Validate slug format
  if (!isLowercaseSlug(slug)) {
    const suggestedSlug = suggestLowercaseSlug(slug);
    errors.push({
      file: `skills/${slug}`,
      path: 'slug',
      message: 'Slug must be lowercase alphanumeric with hyphens',
      severity: 'error',
      suggestion: `Rename folder to '${suggestedSlug || 'valid-slug-name'}'`,
    });
  }

  // 2. Parse frontmatter
  let frontmatter: unknown;
  let body: string;
  try {
    const parsed = matter(markdownContent);
    frontmatter = parsed.data;
    body = parsed.content;
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: 'frontmatter',
        message: `Invalid YAML frontmatter: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
        suggestion: 'See ~/.craft-agent/docs/skills.md for SKILL.md format reference',
      }],
      warnings: [],
    };
  }

  // 3. Validate frontmatter schema
  const metaResult = SkillMetadataSchema.safeParse(frontmatter);
  if (!metaResult.success) {
    errors.push(...zodErrorToIssues(metaResult.error, file));
  }

  // 4. Check content is not empty
  if (!body || body.trim().length === 0) {
    errors.push({
      file,
      path: 'content',
      message: 'Skill content is empty (nothing after frontmatter)',
      severity: 'error',
      suggestion: 'Add instructions after the frontmatter describing what the skill should do',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: [],  // Icon/folder warnings skipped in content-only validation
  };
}

function isLowercaseSlug(slug: string): boolean {
  return slug.length > 0 && [...slug].every(character => (
    (character >= 'a' && character <= 'z')
    || (character >= '0' && character <= '9')
    || character === '-'
  ));
}

function suggestLowercaseSlug(value: string): string {
  let suggestion = '';
  let previousWasHyphen = false;

  for (const character of value.toLowerCase()) {
    const allowed = (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9');
    if (allowed) {
      suggestion += character;
      previousWasHyphen = false;
    } else if (!previousWasHyphen && suggestion.length > 0) {
      suggestion += '-';
      previousWasHyphen = true;
    }
  }

  return suggestion.endsWith('-') ? suggestion.slice(0, -1) : suggestion;
}

/**
 * Validate all skills in a workspace
 * @param workspaceRoot - Absolute path to workspace root folder
 */
export function validateAllSkills(workspaceRoot: string): ValidationResult {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!existsSync(skillsDir)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file: 'skills/',
        path: '',
        message: 'Skills directory does not exist (no skills configured)',
        severity: 'warning',
      }],
    };
  }

  const entries = readdirSync(skillsDir);
  const skillFolders = entries.filter((entry) => {
    const entryPath = join(skillsDir, entry);
    return statSync(entryPath).isDirectory();
  });

  if (skillFolders.length === 0) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file: 'skills/',
        path: '',
        message: 'No skills configured',
        severity: 'warning',
      }],
    };
  }

  for (const folder of skillFolders) {
    const result = validateSkill(workspaceRoot, folder);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
