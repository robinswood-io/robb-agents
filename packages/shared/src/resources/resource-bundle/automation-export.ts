/**
 * Resource Bundle — Export/Import Logic
 *
 * Exports workspace resources (sources, skills, automations) to a portable
 * ResourceBundle, and imports bundles into a target workspace.
 *
 * Key behaviors:
 * - Source configs are sanitized (secrets stripped, auth state reset)
 * - All non-hidden files are included per resource (not just known file types)
 * - Import uses staging + atomic rename per resource (single watcher event)
 * - Source overwrite clears stored credentials
 * - Automations overwrite clears history + retry queue
 * - Relies on existing ConfigWatcher for change notifications (no manual events)
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { AUTOMATIONS_CONFIG_FILE } from "../../automations/constants.ts";
import { validateAutomationsConfig } from "../../automations/validation.ts";
import { generateShortId } from "../../automations/resolve-config-path.ts";
import type { AutomationMatcher } from "../../automations/types.ts";
import type { AutomationBundleEntry } from "../types.ts";

// ============================================================
// Export: Automations
// ============================================================

/** Header keys that are known to carry secrets (case-insensitive match) */
const SECRET_HEADER_PATTERNS = [
  /^authorization$/i,
  /^proxy-authorization$/i,
  /api[-_]?key/i,
]

function isSecretHeader(key: string): boolean {
  return SECRET_HEADER_PATTERNS.some(p => p.test(key))
}

/** Returns true if the value references an env var template like $VAR_NAME or ${VAR} (safe to keep) */
function isTemplatedValue(value: string): boolean {
  return /\$[A-Z_]|\$\{/.test(value)
}

/**
 * Sanitize a single automation matcher for export.
 * Strips webhook auth credentials and known auth headers.
 */
function sanitizeAutomationMatcher(
  matcher: AutomationMatcher,
  label: string,
  warnings: string[],
): AutomationMatcher {
  // Deep clone to avoid mutating the original
  const sanitized: AutomationMatcher = JSON.parse(JSON.stringify(matcher))

  if (!sanitized.actions) return sanitized

  for (const action of sanitized.actions) {
    if (action.type !== 'webhook') continue

    // Strip auth field entirely (bearer tokens, basic auth passwords)
    if (action.auth) {
      delete (action as unknown as Record<string, unknown>).auth
      warnings.push(`Automation '${label}': stripped webhook auth credentials`)
    }

    // Strip known auth headers (unless templated)
    if (action.headers) {
      const keysToStrip = Object.keys(action.headers).filter(
        key => isSecretHeader(key) && !isTemplatedValue(action.headers![key]!),
      )
      for (const key of keysToStrip) {
        delete action.headers[key]
        warnings.push(`Automation '${label}': stripped webhook header '${key}'`)
      }
      // Clean up empty headers object
      if (Object.keys(action.headers).length === 0) {
        delete (action as unknown as Record<string, unknown>).headers
      }
    }
  }

  return sanitized
}

export function exportAutomations(
  workspaceRootPath: string,
  selection: string[] | 'all',
  warnings: string[],
): AutomationBundleEntry[] {
  const automationsPath = join(workspaceRootPath, AUTOMATIONS_CONFIG_FILE)

  if (!existsSync(automationsPath)) {
    warnings.push('No automations.json found in workspace')
    return []
  }

  // Read and validate via the full validation pipeline
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(automationsPath, 'utf-8'))
  } catch (err) {
    warnings.push(`Failed to read automations.json: ${err}`)
    return []
  }

  const validation = validateAutomationsConfig(raw)
  if (!validation.valid || !validation.config) {
    warnings.push(`automations.json is invalid: ${validation.errors.join('; ')}`)
    return []
  }

  // Flatten { event: matchers[] } into individual entries
  const allEntries: AutomationBundleEntry[] = []
  for (const [event, matchers] of Object.entries(validation.config.automations)) {
    if (!matchers) continue
    for (const matcher of matchers) {
      // Ensure every matcher has an ID (backfill if missing)
      const id = matcher.id || generateShortId()
      allEntries.push({
        id,
        name: matcher.name,
        event,
        matcher: { ...matcher, id },
      })
    }
  }

  // Apply selection filter
  let selected: AutomationBundleEntry[]
  if (selection === 'all') {
    selected = allEntries
  } else {
    const matched = new Set<string>()
    selected = []
    for (const selector of selection) {
      const matches = allEntries.filter(
        e => e.id === selector || (e.name !== undefined && e.name === selector),
      )
      if (matches.length === 0) {
        warnings.push(`Automation selector '${selector}' did not match any automation`)
      } else if (matches.length > 1 && matches.every(m => m.id !== selector)) {
        // Name matched multiple — warn about ambiguity but include all
        warnings.push(`Automation name '${selector}' matched ${matches.length} automations`)
      }
      for (const m of matches) {
        if (!matched.has(m.id)) {
          matched.add(m.id)
          selected.push(m)
        }
      }
    }
  }

  // Sanitize each entry
  return selected.map(entry => ({
    ...entry,
    matcher: sanitizeAutomationMatcher(
      entry.matcher,
      entry.name ?? entry.id,
      warnings,
    ),
  }))
}
