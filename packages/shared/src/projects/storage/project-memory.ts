/**
 * Project Storage
 *
 * CRUD operations for workspace-scoped projects.
 * Projects are stored at {workspaceRootPath}/projects/{projectSlug}/
 *
 * Note: All functions take `workspaceRootPath` (absolute path to workspace folder),
 * NOT a workspace slug. The `LoadedProject.workspaceId` is derived via basename().
 */
import { existsSync, readFileSync } from "fs";
import { debug } from "../../utils/debug.ts";
import { estimateTokensDensityAware } from "../../utils/large-response.ts";
import { loadProjectMemoryV2Context } from "../memory-v2.ts";
import { getProjectMemoryPath } from './paths.ts';

// ============================================================
// Memory Operations
// ============================================================

/**
 * Load a project's MEMORY.md, capped at `maxTokens` for prompt injection.
 *
 * Returns `null` when the file is missing or effectively empty. When the
 * content exceeds the budget it is **head-truncated** (the top is kept, since
 * the agent is instructed to write newest/most-important first) and a one-line
 * marker is appended. The returned string — marker included — stays within the
 * token budget.
 */
export function loadProjectMemory(
  workspaceRootPath: string,
  projectSlug: string,
  maxTokens = 5000,
  options: { query?: string; includeStructured?: boolean } = {},
): string | null {
  const structured = options.includeStructured === false ? null : loadProjectMemoryV2Context(workspaceRootPath, projectSlug, {
    maxTokens: Math.max(1, Math.floor(maxTokens * 0.65)),
    query: options.query,
    requireQueryMatch: !!options.query,
  });
  const legacy = loadLegacyProjectMemory(workspaceRootPath, projectSlug, maxTokens);

  // Exact backwards compatibility: projects without a v2 journal receive the
  // same MEMORY.md bytes (or the same legacy truncation) as before.
  if (!structured) return legacy;
  if (!legacy) return structured;

  return capProjectMemoryText(
    `${structured}\n\n# Legacy MEMORY.md\n${legacy}`,
    maxTokens,
    `\n\n…[project memory truncated at ${maxTokens}-token cap]`,
  );
}

function loadLegacyProjectMemory(
  workspaceRootPath: string,
  projectSlug: string,
  maxTokens: number,
): string | null {
  const memoryPath = getProjectMemoryPath(workspaceRootPath, projectSlug);
  if (!existsSync(memoryPath)) return null;

  let content: string;
  try {
    content = readFileSync(memoryPath, 'utf-8');
  } catch (error) {
    debug('[loadProjectMemory] Failed to read MEMORY.md:', projectSlug, error);
    return null;
  }

  if (!content.trim()) return null;

  const tokens = estimateTokensDensityAware(content);
  if (tokens <= maxTokens) return content;

  // Over budget: reserve room for the marker, then head-truncate. `charsPerToken`
  // is derived from the actual content so a density-corrected estimate (base64-heavy
  // memory) still maps back to a sensible character budget.
  const marker = `\n\n…[MEMORY.md truncated at ${maxTokens}-token cap — keep it shorter]`;
  const markerTokens = estimateTokensDensityAware(marker);
  if (markerTokens >= maxTokens) {
    return truncateTextToTokenBudget(marker, maxTokens);
  }
  const bodyBudget = Math.max(0, maxTokens - markerTokens);
  const charsPerToken = content.length / tokens;
  const charBudget = Math.floor(bodyBudget * charsPerToken);
  const head = content.slice(0, charBudget).trimEnd();
  return `${head}${marker}`;
}

function capProjectMemoryText(text: string, maxTokens: number, marker: string): string {
  const tokens = estimateTokensDensityAware(text);
  if (tokens <= maxTokens) return text;

  const markerTokens = estimateTokensDensityAware(marker);
  if (markerTokens >= maxTokens) {
    return truncateTextToTokenBudget(marker, maxTokens);
  }
  const bodyBudget = Math.max(0, maxTokens - markerTokens);
  let charBudget = Math.floor((text.length / tokens) * bodyBudget);
  let result = `${text.slice(0, charBudget).trimEnd()}${marker}`;

  while (charBudget > 0 && estimateTokensDensityAware(result) > maxTokens) {
    charBudget = Math.max(0, charBudget - Math.max(1, Math.ceil(charBudget * 0.05)));
    result = `${text.slice(0, charBudget).trimEnd()}${marker}`;
  }
  return result;
}

function truncateTextToTokenBudget(text: string, maxTokens: number): string {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw new Error('maxTokens must be a positive finite number');
  }
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokensDensityAware(text.slice(0, middle)) <= maxTokens) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return text.slice(0, low);
}
