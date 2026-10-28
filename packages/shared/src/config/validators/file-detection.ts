import { CONFIG_DIR } from "../paths.ts";
import { validateAutomationsContent, AUTOMATIONS_CONFIG_FILE } from "../../automations/index.ts";
import { validateLabelsContent } from './labels.ts';
import { validatePermissionsContent } from './permissions.ts';
import { validateSkillContent } from './skills.ts';
import { validateSourceConfigContent } from './sources.ts';
import { validateStatusesContent } from './statuses.ts';
import { validateToolIconsContent } from './tool-icons.ts';
import type { ValidationResult } from './validation-types.ts';

// ============================================================
// Formatting
// ============================================================

/**
 * Format validation result as text for agent response
 */
export function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = [];

  if (result.valid && result.warnings.length === 0) {
    lines.push('All configuration files are valid.');
    return lines.join('\n');
  }

  if (result.valid) {
    lines.push('Configuration is valid with warnings:');
  } else {
    lines.push('Configuration has errors:');
  }

  lines.push('');

  // Errors first
  if (result.errors.length > 0) {
    lines.push('**Errors:**');
    for (const error of result.errors) {
      lines.push(`- \`${error.file}\` at \`${error.path}\`: ${error.message}`);
      if (error.suggestion) {
        lines.push(`  → ${error.suggestion}`);
      }
    }
    lines.push('');
  }

  // Then warnings
  if (result.warnings.length > 0) {
    lines.push('**Warnings:**');
    for (const warning of result.warnings) {
      lines.push(`- \`${warning.file}\` at \`${warning.path}\`: ${warning.message}`);
      if (warning.suggestion) {
        lines.push(`  → ${warning.suggestion}`);
      }
    }
  }

  return lines.join('\n');
}

// ============================================================
// PreToolUse Content Validation
// ============================================================
// These utilities are used by the PreToolUse hook to detect config files
// being written and validate their content before it reaches disk.

/**
 * Result of detecting what type of config file a path corresponds to.
 */
export interface ConfigFileDetection {
  type: 'source' | 'skill' | 'statuses' | 'labels' | 'permissions' | 'tool-icons' | 'automations';
  /** Slug of the source or skill (if applicable) */
  slug?: string;
  /** Display file path for error messages */
  displayFile: string;
}

/**
 * Detect if a file path corresponds to a known config file type within a workspace.
 * Returns null if the path is not a recognized config file.
 *
 * Matches patterns:
 * - .../sources/{slug}/config.json → source config
 * - .../skills/{slug}/SKILL.md → skill definition
 * - .../statuses/config.json → status workflow config
 * - .../labels/config.json → label config
 * - .../permissions.json (workspace or source-level) → permission rules
 */
export function detectConfigFileType(filePath: string, workspaceRootPath: string): ConfigFileDetection | null {
  // Normalize to consistent forward slashes and ensure root ends with /
  // so startsWith doesn't false-match on path prefixes (e.g., /workspace vs /workspacefoo)
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedRoot = workspaceRootPath.replace(/\\/g, '/').replace(/\/?$/, '/');

  // Only validate files within the workspace root
  if (!normalizedPath.startsWith(normalizedRoot)) {
    return null;
  }

  // Get the relative path from workspace root (no leading slash since root ends with /)
  const relativePath = normalizedPath.slice(normalizedRoot.length);

  // Match: sources/{slug}/config.json
  const sourceMatch = relativePath.match(/^sources\/([^/]+)\/config\.json$/);
  if (sourceMatch) {
    return { type: 'source', ...(sourceMatch[1] !== undefined ? { slug: sourceMatch[1] } : {}), displayFile: `sources/${sourceMatch[1]}/config.json` };
  }

  // Match: skills/{slug}/SKILL.md
  const skillMatch = relativePath.match(/^skills\/([^/]+)\/SKILL\.md$/);
  if (skillMatch) {
    return { type: 'skill', ...(skillMatch[1] !== undefined ? { slug: skillMatch[1] } : {}), displayFile: `skills/${skillMatch[1]}/SKILL.md` };
  }

  // Match: statuses/config.json
  if (relativePath === 'statuses/config.json') {
    return { type: 'statuses', displayFile: 'statuses/config.json' };
  }

  // Match: labels/config.json
  if (relativePath === 'labels/config.json') {
    return { type: 'labels', displayFile: 'labels/config.json' };
  }

  // Match: automations config file
  if (relativePath === AUTOMATIONS_CONFIG_FILE) {
    return { type: 'automations', displayFile: relativePath };
  }

  // Match: permissions.json (workspace-level)
  if (relativePath === 'permissions.json') {
    return { type: 'permissions', displayFile: 'permissions.json' };
  }

  // Match: sources/{slug}/permissions.json (source-level)
  const sourcePermMatch = relativePath.match(/^sources\/([^/]+)\/permissions\.json$/);
  if (sourcePermMatch) {
    return { type: 'permissions', ...(sourcePermMatch[1] !== undefined ? { slug: sourcePermMatch[1] } : {}), displayFile: `sources/${sourcePermMatch[1]}/permissions.json` };
  }

  return null;
}

/**
 * Detect if a file path corresponds to an app-level config file (outside workspace scope).
 * Checks paths relative to CONFIG_DIR (~/.craft-agent/).
 * Returns null if the path is not a recognized app-level config file.
 *
 * Matches patterns:
 * - ~/.craft-agent/tool-icons/tool-icons.json → tool icon mappings
 */
export function detectAppConfigFileType(filePath: string): ConfigFileDetection | null {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedConfigDir = CONFIG_DIR.replace(/\\/g, '/').replace(/\/?$/, '/');

  // Only check files within CONFIG_DIR
  if (!normalizedPath.startsWith(normalizedConfigDir)) {
    return null;
  }

  const relativePath = normalizedPath.slice(normalizedConfigDir.length);

  // Match: tool-icons/tool-icons.json
  if (relativePath === 'tool-icons/tool-icons.json') {
    return { type: 'tool-icons', displayFile: 'tool-icons/tool-icons.json' };
  }

  return null;
}

/**
 * Validate config file content based on its detected type.
 * Dispatches to the appropriate content-based validator.
 * Returns null if the detection type is unrecognized.
 */
export function validateConfigFileContent(
  detection: ConfigFileDetection,
  content: string,
  previousContent?: string,
): ValidationResult | null {
  switch (detection.type) {
    case 'source':
      return validateSourceConfigContent(content, {
        enforceMcpTransportWrite: true,
        ...(previousContent !== undefined ? { previousJsonString: previousContent } : {}),
      });
    case 'skill':
      return validateSkillContent(content, detection.slug || 'unknown');
    case 'statuses':
      return validateStatusesContent(content);
    case 'labels':
      return validateLabelsContent(content);
    case 'automations':
      return validateAutomationsContent(content, detection.displayFile);
    case 'permissions':
      return validatePermissionsContent(content, detection.displayFile);
    case 'tool-icons':
      return validateToolIconsContent(content);
    default:
      return null;
  }
}
