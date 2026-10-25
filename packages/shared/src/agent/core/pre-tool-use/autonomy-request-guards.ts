import { posix } from "node:path";
import { normalizeAutonomyGuardText } from './tool-names.ts';

const RBW_OSS_WHOLE_CATALOG_READ_TOOL = 'mcp__rbw-agents-oss__oss_read_file';

const RBW_OSS_OVERSIZED_CATALOG_GUIDANCE = new Map<string, string>([
  [
    '/srv/rbw-agents-oss/config/command-manifest.json',
    'Use `oss_list_automations` to inspect bounded wrapper metadata, then call `oss_run_automation` directly with the already-known `legacyId`; do not load the full command manifest.',
  ],
  [
    '/srv/rbw-agents-oss/config/automation-mapping.json',
    'Use `oss_list_automations` to inspect bounded wrapper metadata, then call `oss_run_automation` directly with the already-known `legacyId`; do not load the full automation mapping.',
  ],
  [
    '/srv/rbw-agents-oss/config/temporal/schedules.json',
    'Use `oss_schedule_status` for the bounded live schedule view; do not load the full schedule catalog.',
  ],
]);

/**
 * Refuse only known whole-catalog reads whose connector currently exposes no
 * offset/limit contract. This happens after normal mode/source/prerequisite
 * checks but before connector execution, so a rejected read cannot spend a
 * remote call or poison the model context. Ordinary OSS files and archived
 * snapshots remain available through the normal pipeline.
 */
export function oversizedRbwOssCatalogReadGuidance(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (toolName !== RBW_OSS_WHOLE_CATALOG_READ_TOOL || typeof input.path !== 'string') {
    return undefined;
  }
  const rawPath = input.path.trim();
  // Connector paths are POSIX paths. Canonicalize dot segments as well as
  // duplicate separators so a spelling alias cannot bypass a known-catalog
  // guard, while a path that genuinely resolves elsewhere remains available.
  const normalizedPath = rawPath.startsWith('/') ? posix.normalize(rawPath) : rawPath;
  return RBW_OSS_OVERSIZED_CATALOG_GUIDANCE.get(normalizedPath);
}

export const REQUEST_USER_INPUT_TOOL_NAMES = new Set([
  'request_user_input',
  'session__request_user_input',
  'mcp__session__request_user_input',
]);

/** A read-only Sellsy OAuth start is an admitted connector observation. Do
 * not turn that available step into an extra Robb Agents permission question.
 * A real provider consent or MFA callback is handled by the OAuth flow. */
export function redundantlyAsksPermissionForSellsyReadOnlyOAuth(
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (!REQUEST_USER_INPUT_TOOL_NAMES.has(toolName)
    || !Array.isArray(input.questions)
    || input.questions.length !== 1) return false;
  const question = input.questions[0];
  if (!question || typeof question !== 'object' || Array.isArray(question)) return false;
  const text = typeof question.question === 'string'
    ? normalizeAutonomyGuardText(question.question) : '';
  return /\bsellsy\b/u.test(text)
    && /\boauth\b/u.test(text)
    && /\bsubscriptions\.read\b/u.test(text)
    && /\blecture seule\b/u.test(text)
    && /\bautoris/u.test(text)
    && !/\b(?:write|ecriture|modifier|modification)\b/u.test(text);
}
