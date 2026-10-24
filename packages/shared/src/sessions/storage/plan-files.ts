/**
 * Session Storage
 *
 * Workspace-scoped session CRUD operations.
 * Sessions are stored at {workspaceRootPath}/sessions/{id}/session.jsonl
 * Each session folder contains:
 * - session.jsonl (main data in JSONL format: line 1 = header, lines 2+ = messages)
 * - attachments/ (file attachments)
 * - plans/ (plan files for Safe Mode)
 * - data/ (transform_data tool output: JSON files for datatable/spreadsheet blocks)
 * - long_responses/ (full tool results that were summarized due to size limits)
 * - downloads/ (binary files downloaded from API sources: PDFs, images, archives, etc.)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { join, basename } from "path";
import type { Plan } from "../../agent/plan-types.ts";
import { ensurePlansDir, formatPlanAsMarkdown, generatePlanFileName, parsePlanFromMarkdown } from './plan-format.ts';
import { getSessionAttachmentsPath, getSessionPlansPath } from './session-paths.ts';

/**
 * Save a plan to a markdown file
 */
export function savePlanToFile(
  workspaceRootPath: string,
  sessionId: string,
  plan: Plan,
  fileName?: string
): string {
  const plansDir = ensurePlansDir(workspaceRootPath, sessionId);
  const name = fileName || generatePlanFileName(plan, plansDir);
  const filePath = join(plansDir, `${name}.md`);
  const content = formatPlanAsMarkdown(plan);

  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * Load a plan from a markdown file by name
 */
export function loadPlanFromFile(
  workspaceRootPath: string,
  sessionId: string,
  fileName: string
): Plan | null {
  const plansDir = getSessionPlansPath(workspaceRootPath, sessionId);
  const filePath = join(plansDir, `${fileName}.md`);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    return parsePlanFromMarkdown(content, fileName);
  } catch {
    return null;
  }
}

/**
 * Load a plan from a full file path
 */
export function loadPlanFromPath(filePath: string): Plan | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const fileName = basename(filePath).replace('.md', '') || 'unknown';
    return parsePlanFromMarkdown(content, fileName);
  } catch {
    return null;
  }
}

/**
 * List all plan files in a session
 */
export function listPlanFiles(
  workspaceRootPath: string,
  sessionId: string
): Array<{ name: string; path: string; modifiedAt: number }> {
  const plansDir = getSessionPlansPath(workspaceRootPath, sessionId);
  if (!existsSync(plansDir)) {
    return [];
  }

  try {
    const files = readdirSync(plansDir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const filePath = join(plansDir, f);
        const stats = existsSync(filePath) ? statSync(filePath) : null;
        return {
          name: f.replace('.md', ''),
          path: filePath,
          modifiedAt: stats?.mtimeMs || 0,
        };
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt);

    return files;
  } catch {
    return [];
  }
}

/**
 * Delete a plan file
 */
export function deletePlanFile(
  workspaceRootPath: string,
  sessionId: string,
  fileName: string
): boolean {
  const plansDir = getSessionPlansPath(workspaceRootPath, sessionId);
  const filePath = join(plansDir, `${fileName}.md`);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
    return true;
  }
  return false;
}

/**
 * Get the most recent plan file for a session
 */
export function getMostRecentPlanFile(
  workspaceRootPath: string,
  sessionId: string
): { name: string; path: string } | null {
  const files = listPlanFiles(workspaceRootPath, sessionId);
  return files.length > 0 ? files[0]! : null;
}

// ============================================================
// Attachments Directory
// ============================================================

/**
 * Ensure attachments directory exists
 */
export function ensureAttachmentsDir(workspaceRootPath: string, sessionId: string): string {
  const dir = getSessionAttachmentsPath(workspaceRootPath, sessionId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}
