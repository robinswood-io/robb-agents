import { basename } from "path";
import type { ResourceBundle, ResourceImportMode, ResourceImportResult, ResourceImportDeps } from "../types.ts";
import { importAutomations } from './automation-import.ts';
import { validateResourceBundle } from './bundle-validation.ts';
import { emptyBucketResult } from './resource-import-empty-bucket-result.ts';
import { importSkills } from './skill-import.ts';
import { importSources } from './source-import.ts';

// ============================================================
// Import
// ============================================================

/**
 * Import a ResourceBundle into a target workspace.
 *
 * Uses staging + atomic rename per resource to minimize watcher churn
 * and ensure true replacement on overwrite.
 *
 * @param workspaceRootPath - Absolute path to target workspace
 * @param bundle - The validated ResourceBundle to import
 * @param mode - 'skip' (keep existing) or 'overwrite' (replace)
 * @param deps - Injected dependencies for staged-source validation and credential cleanup
 */
export async function importResources(
  workspaceRootPath: string,
  bundle: ResourceBundle,
  mode: ResourceImportMode,
  deps: ResourceImportDeps,
): Promise<ResourceImportResult> {
  // Validate bundle first
  const validation = validateResourceBundle(bundle)
  if (!validation.valid) {
    const errorMsg = `Invalid bundle: ${validation.errors.join('; ')}`
    const failedBucket = { imported: [], skipped: [], failed: [{ id: '*', error: errorMsg }], warnings: [] }
    return {
      sources: { ...failedBucket },
      skills: { ...failedBucket },
      automations: { ...failedBucket },
    }
  }

  const workspaceId = basename(workspaceRootPath)

  // Import each resource type
  const sourcesResult = bundle.resources.sources
    ? await importSources(workspaceRootPath, workspaceId, bundle.resources.sources, mode, deps)
    : emptyBucketResult()

  const skillsResult = bundle.resources.skills
    ? importSkills(workspaceRootPath, bundle.resources.skills, mode)
    : emptyBucketResult()

  const automationsResult = bundle.resources.automations?.length
    ? importAutomations(workspaceRootPath, bundle.resources.automations, mode)
    : emptyBucketResult()

  return {
    sources: sourcesResult,
    skills: skillsResult,
    automations: automationsResult,
  }
}
