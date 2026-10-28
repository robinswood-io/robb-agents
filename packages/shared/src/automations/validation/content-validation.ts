import { isUnknownArray } from '../../utils/json.ts';
import { AUTOMATIONS_CONFIG_FILE } from "../constants.ts";
import { AutomationsConfigSchema, zodErrorToIssues, DEPRECATED_EVENT_ALIASES } from "../schemas.ts";
import { Cron } from "croner";
import type { ValidationResult, ValidationIssue } from "../../config/validators.ts";
import type { AutomationsConfig, AutomationsValidationResult } from "../types.ts";
import { validateConditionsArray } from './conditions.ts';

/**
 * Validate automations config (internal - returns parsed config)
 */
export function validateAutomationsConfig(content: unknown): AutomationsValidationResult {
  const result = AutomationsConfigSchema.safeParse(content);

  if (!result.success) {
    const errors = result.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    return { valid: false, errors, config: null };
  }

  const schemaConfig = result.data as AutomationsConfig;
  const semanticErrors: ValidationIssue[] = [];
  runMatcherSemanticValidations(schemaConfig, AUTOMATIONS_CONFIG_FILE, semanticErrors, []);

  if (semanticErrors.length > 0) {
    const errors = semanticErrors.map((issue) => issue.path ? `${issue.path}: ${issue.message}` : issue.message);
    return { valid: false, errors, config: null };
  }

  return { valid: true, errors: [], config: schemaConfig };
}

/**
 * Run semantic validation checks for matcher definitions.
 * Shared by both object-based runtime validation and JSON-content validation.
 */
function runMatcherSemanticValidations(
  config: AutomationsConfig,
  file: string,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
): void {
  for (const [event, matchers] of Object.entries(config.automations)) {
    if (!matchers) continue;
    for (let i = 0; i < matchers.length; i++) {
      const matcher = matchers[i];
      if (!matcher) continue;
      // Warn about allow-all permission mode
      if (matcher.permissionMode === 'allow-all') {
        warnings.push({
          file,
          path: `automations.${event}[${i}].permissionMode`,
          message: 'permissionMode "allow-all" bypasses all security checks — use with caution',
          severity: 'warning',
          suggestion: 'Consider using "safe" or "ask" permission mode instead',
        });
      }

      if (matcher.matcher) {
        // ReDoS prevention: limit regex complexity
        const MAX_REGEX_LENGTH = 500;
        if (matcher.matcher.length > MAX_REGEX_LENGTH) {
          errors.push({
            file,
            path: `automations.${event}[${i}].matcher`,
            message: `Regex pattern too long (${matcher.matcher.length} chars, max ${MAX_REGEX_LENGTH})`,
            severity: 'error',
            suggestion: 'Simplify the regex pattern or split into multiple matchers',
          });
        } else {
          try {
            // Validate regex syntax
            new RegExp(matcher.matcher);

            // Reject catastrophic backtracking (ReDoS) patterns
            // Detect nested quantifiers: a group containing a quantifier that itself has a quantifier
            const nestedQuantifiers = /\([^)]*[+*][^)]*\)[+*{]/;
            // Also detect repeated alternation like (a|a)+ and adjacent greedy quantifiers like .*.*
            const riskyPatterns = /(\.\*){2,}|(\.\+){2,}|\([^)]*\|[^)]*\)[+*{]/;
            if (nestedQuantifiers.test(matcher.matcher) || riskyPatterns.test(matcher.matcher)) {
              errors.push({
                file,
                path: `automations.${event}[${i}].matcher`,
                message: 'Regex pattern rejected: potential catastrophic backtracking (ReDoS)',
                severity: 'error',
                suggestion: 'Avoid nested quantifiers like (a+)+, (.*)+, (.+)*, ([a-z]+)+, and repeated alternation like (a|a)+',
              });
            }
          } catch (e) {
            errors.push({
              file,
              path: `automations.${event}[${i}].matcher`,
              message: `Invalid regex pattern: ${e instanceof Error ? e.message : 'Unknown error'}`,
              severity: 'error',
              suggestion: 'Fix the regex pattern or remove the matcher to match all events',
            });
          }
        }
      }

      // Validate cron expressions
      if (matcher.cron) {
        try {
          new Cron(matcher.cron);
        } catch (e) {
          errors.push({
            file,
            path: `automations.${event}[${i}].cron`,
            message: `Invalid cron expression: ${e instanceof Error ? e.message : 'Unknown error'}`,
            severity: 'error',
            suggestion: 'Use standard 5-field cron format: minute hour day-of-month month day-of-week',
          });
        }
      }

      // Validate timezone
      if (matcher.timezone) {
        try {
          Intl.DateTimeFormat(undefined, { timeZone: matcher.timezone });
        } catch {
          errors.push({
            file,
            path: `automations.${event}[${i}].timezone`,
            message: `Invalid timezone: ${matcher.timezone}`,
            severity: 'error',
            suggestion: 'Use IANA timezone format like "Europe/Budapest" or "America/New_York"',
          });
        }
      }

      // Warn about webhook URLs with $VAR templates (can't validate until runtime)
      if (matcher.actions) {
        for (let j = 0; j < matcher.actions.length; j++) {
          const action = matcher.actions[j];
          if (action && typeof action === 'object' && 'type' in action && action.type === 'webhook' && 'url' in action && typeof action.url === 'string' && action.url.includes('$')) {
            warnings.push({
              file,
              path: `automations.${event}[${i}].actions[${j}].url`,
              message: 'Webhook URL contains variable templates — will be validated at runtime after expansion',
              severity: 'warning',
              suggestion: 'Ensure the referenced CRAFT_WH_* variables are set in your shell profile',
            });
          }
        }
      }

      // Warn if cron is used on non-SchedulerTick event
      if (matcher.cron && event !== 'SchedulerTick') {
        warnings.push({
          file,
          path: `automations.${event}[${i}].cron`,
          message: 'Cron expressions are only used for SchedulerTick events',
          severity: 'warning',
          suggestion: 'Move this automation to the SchedulerTick event or use matcher instead',
        });
      }

      // Validate conditions
      if (matcher.conditions && isUnknownArray(matcher.conditions)) {
        validateConditionsArray(matcher.conditions, `automations.${event}[${i}].conditions`, event, file, errors, warnings, 0);
      }
    }
  }
}

/**
 * Validate automations config from a JSON string (no disk reads).
 * Used by PreToolUse automation to validate before writing to disk.
 * Follows the same pattern as other config validators in validators.ts.
 */
export function validateAutomationsContent(jsonString: string, fileName?: string): ValidationResult {
  const file = fileName ?? AUTOMATIONS_CONFIG_FILE;
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Parse JSON
  let content: unknown;
  try {
    content = JSON.parse(jsonString);
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
  const result = AutomationsConfigSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, file));
    return { valid: false, errors, warnings };
  }

  // Semantic validations
  const config = result.data;

  // Check for empty automations
  const matcherCount = Object.values(config.automations).reduce(
    (sum, matchers) => sum + (matchers?.length ?? 0),
    0
  );
  if (matcherCount === 0) {
    warnings.push({
      file,
      path: 'automations',
      message: 'No automations configured',
      severity: 'warning',
      suggestion: 'Add automation definitions under event names like SessionStatusChange, LabelAdd, etc.',
    });
  }

  // Check for deprecated event aliases in the raw JSON (before transform rewrites them)
  try {
    const rawConfig = JSON.parse(jsonString) as { automations?: Record<string, unknown> };
    if (rawConfig.automations) {
      for (const event of Object.keys(rawConfig.automations)) {
        const canonical = DEPRECATED_EVENT_ALIASES[event];
        if (canonical) {
          warnings.push({
            file,
            path: `automations.${event}`,
            message: `Event '${event}' has been renamed to '${canonical}'. The old name still works but is deprecated.`,
            severity: 'warning',
            suggestion: `Rename '${event}' to '${canonical}' in your config`,
          });
        }
      }
    }
  } catch {
    // JSON already validated above, this shouldn't happen
  }

  runMatcherSemanticValidations(config, file, errors, warnings);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
