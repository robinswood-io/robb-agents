import { debug } from "../../utils/debug.ts";
import { safeJsonParse } from "../../utils/files.ts";
import { FEATURE_FLAGS } from "../../feature-flags.ts";
import { PermissionsConfigSchema, type PermissionsConfigFile, type CompiledBlockedCommandHint, type BlockedCommandHintRule } from "../mode-types.ts";
import type { PatternWithComment, PermissionsCustomConfig } from './contracts.ts';

// ============================================================
// JSON Parser
// ============================================================

/**
 * Parse and validate permissions.json file
 */
export function parsePermissionsJson(content: string): PermissionsCustomConfig {
  const emptyConfig: PermissionsCustomConfig = {
    allowedBashPatterns: [],
    allowedMcpPatterns: [],
    allowedApiEndpoints: [],
    allowedWritePaths: [],
    blockedCommandHints: [],
  };

  try {
    const json = safeJsonParse(content);
    const result = PermissionsConfigSchema.safeParse(json);

    if (!result.success) {
      debug('[SafeMode] Validation errors:', result.error.issues);
      // Log specific errors for debugging
      for (const issue of result.error.issues) {
        debug(`[SafeMode]   - ${issue.path.join('.')}: ${issue.message}`);
      }
      return emptyConfig;
    }

    const data = result.data;

    // Normalize patterns (extract string from pattern objects, but NOT for bash - preserve comments)
    const normalizePatterns = (patterns: Array<string | { pattern: string; comment?: string }> | undefined): string[] => {
      if (!patterns) return [];
      return patterns.map(p => typeof p === 'string' ? p : p.pattern);
    };

    // For bash patterns, preserve comments for helpful error messages
    const normalizeBashPatterns = (patterns: Array<string | { pattern: string; comment?: string }> | undefined): PatternWithComment[] => {
      if (!patterns) return [];
      return patterns.map(p => {
        if (typeof p === 'string') {
          return { pattern: p };
        }
        return { pattern: p.pattern, comment: p.comment };
      });
    };

    return {
      allowedBashPatterns: normalizeBashPatterns(data.allowedBashPatterns),
      allowedMcpPatterns: normalizePatterns(data.allowedMcpPatterns),
      allowedApiEndpoints: data.allowedApiEndpoints ?? [],
      allowedWritePaths: normalizePatterns(data.allowedWritePaths),
      blockedCommandHints: data.blockedCommandHints ?? [],
    };
  } catch (error) {
    debug('[SafeMode] JSON parse error:', error);
    return emptyConfig;
  }
}

/**
 * Validate a regex pattern string, return null if invalid
 */
export function validateRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

export function compileBlockedCommandHint(hint: BlockedCommandHintRule): CompiledBlockedCommandHint | null {
  const command = hint.command.trim().toLowerCase();
  if (!command) return null;

  let whenNotMatchingRegex: RegExp | undefined;
  if (hint.whenNotMatching) {
    const compiled = validateRegex(hint.whenNotMatching);
    if (!compiled) {
      debug(`[Permissions] Invalid blockedCommandHints.whenNotMatching regex, skipping: ${hint.whenNotMatching}`);
      return null;
    }
    whenNotMatchingRegex = compiled;
  }

  return {
    command,
    reason: hint.reason,
    context: hint.context,
    tryInstead: hint.tryInstead,
    example: hint.example,
    whenNotMatching: hint.whenNotMatching,
    whenNotMatchingRegex,
  };
}

export function shouldCompileBashPattern(pattern: string): boolean {
  if (!FEATURE_FLAGS.craftAgentsCli && pattern.startsWith('^craft-agent\\s')) {
    return false;
  }
  return true;
}

/**
 * Validate permissions config and return errors
 */
export function validatePermissionsConfig(config: PermissionsConfigFile): string[] {
  const errors: string[] = [];

  // Validate regex patterns
  const checkPatterns = (patterns: Array<string | { pattern: string }> | undefined, name: string) => {
    if (!patterns) return;
    for (let i = 0; i < patterns.length; i++) {
      const p = patterns[i];
      if (!p) continue;
      const patternStr = typeof p === 'string' ? p : p.pattern;
      if (!validateRegex(patternStr)) {
        errors.push(`${name}[${i}]: Invalid regex pattern: ${patternStr}`);
      }
    }
  };

  checkPatterns(config.allowedBashPatterns, 'allowedBashPatterns');
  checkPatterns(config.allowedMcpPatterns, 'allowedMcpPatterns');

  // Validate API endpoint patterns
  if (config.allowedApiEndpoints) {
    for (let i = 0; i < config.allowedApiEndpoints.length; i++) {
      const rule = config.allowedApiEndpoints[i];
      if (rule && !validateRegex(rule.path)) {
        errors.push(`allowedApiEndpoints[${i}].path: Invalid regex pattern: ${rule.path}`);
      }
    }
  }

  // Validate blocked command hint conditional regex patterns
  if (config.blockedCommandHints) {
    for (let i = 0; i < config.blockedCommandHints.length; i++) {
      const hint = config.blockedCommandHints[i];
      if (hint?.whenNotMatching && !validateRegex(hint.whenNotMatching)) {
        errors.push(`blockedCommandHints[${i}].whenNotMatching: Invalid regex pattern: ${hint.whenNotMatching}`);
      }
    }
  }

  return errors;
}
