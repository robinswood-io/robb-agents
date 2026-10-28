import { isUnknownArray } from '../../utils/json.ts';
import { type BundleFile, MAX_BUNDLE_SIZE_BYTES, validateBundleFile } from "../../utils/bundle-files.ts";
import { isBuiltinSource } from "../../sources/builtin-sources.ts";
import { VALID_EVENTS } from "../../automations/schemas.ts";
import { isSensitiveResourceBundleFile } from './resource-paths.ts';
import { isCanonicalResourceSlug } from './source-transaction.ts';

// ============================================================
// Validation
// ============================================================

/**
 * Validate a ResourceBundle structure.
 * Returns { valid, errors } rather than a type guard, so callers get diagnostics.
 */
export function validateResourceBundle(bundle: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!bundle || typeof bundle !== 'object') {
    return { valid: false, errors: ['Bundle is not an object'] }
  }

  const b = bundle as Record<string, unknown>

  if (b["version"] !== 1) {
    errors.push(`Unsupported bundle version: ${b["version"]}`)
  }

  if (typeof b["exportedAt"] !== 'number') {
    errors.push('Missing or invalid exportedAt')
  }

  if (!b["resources"] || typeof b["resources"] !== 'object') {
    errors.push('Missing or invalid resources')
    return { valid: false, errors }
  }

  const res = b["resources"] as Record<string, unknown>

  // Validate sources
  if (res["sources"] !== undefined) {
    if (!isUnknownArray(res["sources"])) {
      errors.push('resources.sources must be an array')
    } else {
      const slugs = new Set<string>()
      for (let i = 0; i < res["sources"].length; i++) {
        const entry = res["sources"][i]
        const prefix = `sources[${i}]`

        if (!entry || typeof entry !== 'object') {
          errors.push(`${prefix}: not an object`)
          continue
        }

        const e = entry as Record<string, unknown>

        if (typeof e["slug"] !== 'string' || !e["slug"]) {
          errors.push(`${prefix}: missing or invalid slug`)
          continue
        }
        if (!isCanonicalResourceSlug(e["slug"])) {
          errors.push(`${prefix}: slug must be 1-64 lowercase alphanumeric characters or hyphens`)
          continue
        }

        if (slugs.has(e["slug"] as string)) {
          errors.push(`${prefix}: duplicate slug '${e["slug"]}'`)
        }
        slugs.add(e["slug"] as string)

        // Check for builtin/reserved slugs
        if (isBuiltinSource(e["slug"] as string)) {
          errors.push(`${prefix}: '${e["slug"]}' is a reserved builtin source slug`)
        }

        if (!e["config"] || typeof e["config"] !== 'object') {
          errors.push(`${prefix}: missing or invalid config`)
        } else {
          const cfg = e["config"] as Record<string, unknown>
          if (typeof cfg["slug"] === 'string' && cfg["slug"] !== e["slug"]) {
            errors.push(`${prefix}: config.slug '${cfg["slug"]}' does not match entry slug '${e["slug"]}'`)
          }
        }

        if (!isUnknownArray(e["files"])) {
          errors.push(`${prefix}: files must be an array`)
        } else {
          for (let j = 0; j < e["files"].length; j++) {
            const file = e["files"][j] as BundleFile | undefined
            if (file && typeof file.relativePath === 'string'
              && file.relativePath.toLowerCase() === 'config.json') {
              errors.push(`${prefix}.files[${j}]: reserved source path 'config.json' is not allowed`)
            }
          }
          validateFileEntries(e["files"] as BundleFile[], prefix, errors)
        }
      }
    }
  }

  // Validate skills
  if (res["skills"] !== undefined) {
    if (!isUnknownArray(res["skills"])) {
      errors.push('resources.skills must be an array')
    } else {
      const slugs = new Set<string>()
      for (let i = 0; i < res["skills"].length; i++) {
        const entry = res["skills"][i]
        const prefix = `skills[${i}]`

        if (!entry || typeof entry !== 'object') {
          errors.push(`${prefix}: not an object`)
          continue
        }

        const e = entry as Record<string, unknown>

        if (typeof e["slug"] !== 'string' || !e["slug"]) {
          errors.push(`${prefix}: missing or invalid slug`)
          continue
        }
        if (!isCanonicalResourceSlug(e["slug"])) {
          errors.push(`${prefix}: slug must be 1-64 lowercase alphanumeric characters or hyphens`)
          continue
        }

        if (slugs.has(e["slug"] as string)) {
          errors.push(`${prefix}: duplicate slug '${e["slug"]}'`)
        }
        slugs.add(e["slug"] as string)

        if (!isUnknownArray(e["files"])) {
          errors.push(`${prefix}: files must be an array`)
        } else {
          // Validate SKILL.md is present
          const hasSkillMd = (e["files"] as BundleFile[]).some(f =>
            typeof f === 'object' && f && (f as BundleFile).relativePath === 'SKILL.md',
          )
          if (!hasSkillMd) {
            errors.push(`${prefix}: missing SKILL.md`)
          }
          validateFileEntries(e["files"] as BundleFile[], prefix, errors)
        }
      }
    }
  }

  // Validate automations
  if (res["automations"] !== undefined) {
    if (!isUnknownArray(res["automations"])) {
      errors.push('resources.automations must be an array')
    } else {
      const ids = new Set<string>()
      for (let i = 0; i < res["automations"].length; i++) {
        const entry = res["automations"][i]
        const prefix = `automations[${i}]`

        if (!entry || typeof entry !== 'object') {
          errors.push(`${prefix}: not an object`)
          continue
        }

        const e = entry as Record<string, unknown>

        if (typeof e["id"] !== 'string' || !e["id"]) {
          errors.push(`${prefix}: missing or invalid id`)
          continue
        }

        if (ids.has(e["id"] as string)) {
          errors.push(`${prefix}: duplicate id '${e["id"]}'`)
        }
        ids.add(e["id"] as string)

        if (typeof e["event"] !== 'string' || !e["event"]) {
          errors.push(`${prefix}: missing or invalid event`)
        } else if (!VALID_EVENTS.includes(e["event"] as string)) {
          errors.push(`${prefix}: unknown event type '${e["event"]}'`)
        }

        if (!e["matcher"] || typeof e["matcher"] !== 'object') {
          errors.push(`${prefix}: missing or invalid matcher`)
        } else {
          const m = e["matcher"] as Record<string, unknown>
          if (!isUnknownArray(m["actions"]) || m["actions"].length === 0) {
            errors.push(`${prefix}: matcher must have at least one action`)
          }
        }
      }
    }
  }

  // Validate total bundle size
  try {
    const size = Buffer.byteLength(JSON.stringify(bundle))
    if (size > MAX_BUNDLE_SIZE_BYTES) {
      errors.push(`Bundle size ${size} exceeds max ${MAX_BUNDLE_SIZE_BYTES}`)
    }
  } catch {
    errors.push('Bundle is not serializable')
  }

  return { valid: errors.length === 0, errors }
}

function validateFileEntries(files: BundleFile[], prefix: string, errors: string[]): void {
  const paths = new Set<string>()

  for (let j = 0; j < files.length; j++) {
    const file = files[j]
    if (!file || typeof file !== 'object') {
      errors.push(`${prefix}.files[${j}]: not an object`)
      continue
    }

    // Check for duplicate paths
    if (paths.has(file.relativePath)) {
      errors.push(`${prefix}.files[${j}]: duplicate path '${file.relativePath}'`)
    }
    paths.add(file.relativePath)

    const fileError = validateBundleFile(file)
    if (fileError) {
      errors.push(`${prefix}.files[${j}]: ${fileError}`)
    } else if (isSensitiveResourceBundleFile(file.relativePath)) {
      errors.push(`${prefix}.files[${j}]: sensitive file '${file.relativePath}' is not allowed in a resource bundle`)
    }
  }
}
