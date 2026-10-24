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
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { Plan } from "../../agent/plan-types.ts";
import { getSessionPlansPath } from './session-paths.ts';

// ============================================================
// Plan Storage (Session-Scoped)
// ============================================================

/**
 * Slugify a string for file names
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .trim();
}

/**
 * Generate a unique, readable file name for a plan
 */
export function generatePlanFileName(plan: Plan, plansDir: string): string {
  let name = plan.title || plan.context?.substring(0, 50) || 'untitled';
  let slug = slugify(name);

  if (slug.length > 40) {
    slug = slug.substring(0, 40).replace(/-$/, '');
  }

  const date = new Date().toISOString().split('T')[0];
  const baseName = `${date}-${slug}`;

  let fileName = baseName;
  let counter = 2;

  while (existsSync(join(plansDir, `${fileName}.md`))) {
    fileName = `${baseName}-${counter}`;
    counter++;
  }

  return fileName;
}

/**
 * Ensure the plans directory exists
 */
export function ensurePlansDir(workspaceRootPath: string, sessionId: string): string {
  const plansDir = getSessionPlansPath(workspaceRootPath, sessionId);
  if (!existsSync(plansDir)) {
    mkdirSync(plansDir, { recursive: true });
  }
  return plansDir;
}

/**
 * Format a plan as markdown
 */
export function formatPlanAsMarkdown(plan: Plan): string {
  const lines: string[] = [];

  lines.push(`# ${plan.title}`);
  lines.push('');
  lines.push(`**Status:** ${plan.state}`);
  lines.push(`**Created:** ${new Date(plan.createdAt).toISOString()}`);
  if (plan.updatedAt !== plan.createdAt) {
    lines.push(`**Updated:** ${new Date(plan.updatedAt).toISOString()}`);
  }
  lines.push('');

  if (plan.context) {
    lines.push('## Summary');
    lines.push('');
    lines.push(plan.context);
    lines.push('');
  }

  lines.push('## Steps');
  lines.push('');
  for (const step of plan.steps) {
    const checkbox = step.status === 'completed' ? '[x]' : '[ ]';
    const status = step.status === 'in_progress' ? ' *(in progress)*' : '';
    lines.push(`- ${checkbox} ${step.description}${status}`);
    if (step.details) {
      lines.push(`  - Tools: ${step.details}`);
    }
  }
  lines.push('');

  if (plan.refinementHistory && plan.refinementHistory.length > 0) {
    lines.push('## Refinement History');
    lines.push('');
    for (const entry of plan.refinementHistory) {
      lines.push(`### Round ${entry.round}`);
      lines.push(`**Feedback:** ${entry.feedback}`);
      if (entry.questions && entry.questions.length > 0) {
        lines.push(`**Questions:** ${entry.questions.join(', ')}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Parse a markdown plan file back to a Plan object
 */
export function parsePlanFromMarkdown(content: string, planId: string): Plan | null {
  try {
    const lines = content.split('\n');

    const titleLine = lines.find(l => l.startsWith('# '));
    const title = titleLine ? titleLine.substring(2).trim() : 'Untitled Plan';

    const statusLine = lines.find(l => l.startsWith('**Status:**'));
    const stateStr = statusLine ? statusLine.replace('**Status:**', '').trim() : 'ready';
    const state = (['creating', 'refining', 'ready', 'executing', 'completed', 'cancelled'].includes(stateStr)
      ? stateStr
      : 'ready') as Plan['state'];

    const summaryIdx = lines.findIndex(l => l === '## Summary');
    const stepsIdx = lines.findIndex(l => l === '## Steps');
    let context = '';
    if (summaryIdx !== -1 && stepsIdx !== -1) {
      context = lines.slice(summaryIdx + 2, stepsIdx).join('\n').trim();
    }

    const steps: Plan['steps'] = [];
    if (stepsIdx !== -1) {
      for (let i = stepsIdx + 2; i < lines.length; i++) {
        const line = lines[i];
        if (!line || line.startsWith('##')) break;
        if (line.startsWith('- [')) {
          const isCompleted = line.startsWith('- [x]');
          const isInProgress = line.includes('*(in progress)*');
          const description = line
            .replace(/^- \[[ x]\] /, '')
            .replace(' *(in progress)*', '')
            .trim();
          steps.push({
            id: `step-${steps.length + 1}`,
            description,
            status: isCompleted ? 'completed' : isInProgress ? 'in_progress' : 'pending',
          });
        }
      }
    }

    return {
      id: planId,
      title,
      state,
      context,
      steps,
      refinementRound: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  } catch {
    return null;
  }
}
