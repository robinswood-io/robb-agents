import { isUnknownArray } from '../../utils/json.ts';
import type { ValidationIssue } from "../../config/validators.ts";
import { MAX_CONDITION_DEPTH_EXCLUSIVE, CONDITION_DEPTH_WARNING_THRESHOLD } from "../conditions-constants.ts";

// ============================================================================
// Condition Validation Helpers
// ============================================================================

const VALID_WEEKDAYS = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

const HH_MM_RE = /^\d{2}:\d{2}$/;

/** Events that have transition fields (from/to) */
const TRANSITION_EVENTS = new Set(['PermissionModeChange', 'SessionStatusChange']);

export function validateConditionsArray(
  conditions: unknown[],
  basePath: string,
  event: string,
  file: string,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
  depth: number,
): void {
  // Depth starts at 0 for top-level conditions; allowed depth indexes are
  // 0..MAX_CONDITION_DEPTH_EXCLUSIVE-1.
  if (depth > CONDITION_DEPTH_WARNING_THRESHOLD) {
    warnings.push({
      file,
      path: basePath,
      message: `Condition nesting depth ${depth} — consider simplifying`,
      severity: 'warning',
    });
  }
  if (depth >= MAX_CONDITION_DEPTH_EXCLUSIVE) {
    errors.push({
      file,
      path: basePath,
      message: `Condition nesting exceeds maximum depth of ${MAX_CONDITION_DEPTH_EXCLUSIVE}`,
      severity: 'error',
    });
    return;
  }

  for (let j = 0; j < conditions.length; j++) {
    const cond = conditions[j] as Record<string, unknown>;
    if (!cond || typeof cond !== 'object') continue;
    const path = `${basePath}[${j}]`;

    switch (cond["condition"]) {
      case 'time':
        validateTimeCondition(cond, path, file, errors);
        break;
      case 'state':
        validateStateCondition(cond, path, event, file, errors, warnings);
        break;
      case 'and':
      case 'or':
      case 'not':
        if (isUnknownArray(cond["conditions"]) && cond["conditions"].length > 0) {
          validateConditionsArray(cond["conditions"], `${path}.conditions`, event, file, errors, warnings, depth + 1);
        }
        break;
    }
  }
}

function validateTimeCondition(
  cond: Record<string, unknown>,
  path: string,
  file: string,
  errors: ValidationIssue[],
): void {
  if (cond["after"] !== undefined && typeof cond["after"] === 'string') {
    if (!HH_MM_RE.test(cond["after"])) {
      errors.push({ file, path: `${path}.after`, message: `Invalid time format: "${cond["after"]}" (expected HH:MM)`, severity: 'error' });
    } else {
      const [h, m] = cond["after"].split(':').map(Number);
      if ((h ?? 0) > 23 || (m ?? 0) > 59) {
        errors.push({ file, path: `${path}.after`, message: `Invalid time value: "${cond["after"]}"`, severity: 'error' });
      }
    }
  }
  if (cond["before"] !== undefined && typeof cond["before"] === 'string') {
    if (!HH_MM_RE.test(cond["before"])) {
      errors.push({ file, path: `${path}.before`, message: `Invalid time format: "${cond["before"]}" (expected HH:MM)`, severity: 'error' });
    } else {
      const [h, m] = cond["before"].split(':').map(Number);
      if ((h ?? 0) > 23 || (m ?? 0) > 59) {
        errors.push({ file, path: `${path}.before`, message: `Invalid time value: "${cond["before"]}"`, severity: 'error' });
      }
    }
  }
  if (cond["weekday"] !== undefined && isUnknownArray(cond["weekday"])) {
    for (const day of cond["weekday"]) {
      if (typeof day === 'string' && !VALID_WEEKDAYS.has(day)) {
        errors.push({ file, path: `${path}.weekday`, message: `Invalid weekday: "${day}" (expected mon-sun)`, severity: 'error' });
      }
    }
  }
  if (cond["timezone"] !== undefined && typeof cond["timezone"] === 'string') {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: cond["timezone"] });
    } catch {
      errors.push({ file, path: `${path}.timezone`, message: `Invalid timezone: "${cond["timezone"]}"`, severity: 'error' });
    }
  }
}

function validateStateCondition(
  cond: Record<string, unknown>,
  path: string,
  event: string,
  file: string,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
): void {
  // Check operator exclusivity
  const hasValue = cond["value"] !== undefined;
  const hasFrom = cond["from"] !== undefined;
  const hasTo = cond["to"] !== undefined;
  const hasContains = cond["contains"] !== undefined;
  const hasNotValue = cond["not_value"] !== undefined;

  const operatorCount = (hasValue ? 1 : 0) + ((hasFrom || hasTo) ? 1 : 0) + (hasContains ? 1 : 0) + (hasNotValue ? 1 : 0);
  if (operatorCount === 0) {
    errors.push({ file, path, message: 'State condition must have at least one operator (value, from/to, contains, or not_value)', severity: 'error' });
  } else if (operatorCount > 1) {
    errors.push({ file, path, message: 'State condition must use exactly one operator group (value, from/to, contains, or not_value)', severity: 'error' });
  }

  // Warn if from/to used on non-transition events
  if ((hasFrom || hasTo) && !TRANSITION_EVENTS.has(event)) {
    warnings.push({
      file,
      path,
      message: `from/to transition checks are typically used with PermissionModeChange or SessionStatusChange events, not ${event}`,
      severity: 'warning',
    });
  }
}
