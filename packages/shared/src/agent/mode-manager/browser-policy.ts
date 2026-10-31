import { isUnknownArray } from '../../utils/json.ts';
/// <reference path="../../types/incr-regex-package.d.ts" />
import { isBrowserToolNameOrAlias, isCanonicalBrowserToolName } from "../browser-tool-names.ts";
import { isObservationalBrowserCommand } from "../browser-tool-runtime.ts";
import type { ToolCheckResult } from './contracts.ts';

/**
 * Tools that are always allowed in any mode (read-only by nature)
 */
export const ALWAYS_ALLOWED_TOOLS = new Set([
  'Read', 'Glob', 'Grep',           // File reading
  'Task', 'TaskOutput',             // Agent orchestration
  'TaskStop', 'KillShell',          // Cancellation/cleanup of agent-owned work
  'Skill',                          // Host-reviewed instruction loading
  'WebFetch', 'WebSearch',          // Web research
  'TodoWrite',                      // Task tracking
  'SubmitPlan',                     // Plan submission
  'LSP',                            // Language server (read-only)
]);

const OBSERVATIONAL_LEGACY_BROWSER_OPERATIONS = new Set([
  'open',
  'navigate',
  'snapshot',
  'screenshot',
  'screenshot-region',
  'console',
  'network',
  'wait',
  'downloads',
  'scroll',
  'back',
  'forward',
]);

/** Explore mode is a read boundary, including inside the multiplexed browser
 * tool. Unknown, malformed and mutating browser commands fail closed. */
export function browserSafeModeDecision(toolName: string, toolInput: unknown): ToolCheckResult | undefined {
  const input = toolInput && typeof toolInput === 'object' && !isUnknownArray(toolInput)
    ? toolInput as Record<string, unknown>
    : {};
  if (isCanonicalBrowserToolName(toolName)) {
    return isObservationalBrowserCommand(input["command"])
      ? { allowed: true }
      : { allowed: false, reason: 'Browser mutations and unknown browser commands are blocked in Explore mode.' };
  }
  if (!isBrowserToolNameOrAlias(toolName)) return undefined;

  const leafName = toolName.split('__').at(-1)?.toLowerCase() ?? '';
  const operation = leafName.slice('browser_'.length).replaceAll('_', '-');
  if (!OBSERVATIONAL_LEGACY_BROWSER_OPERATIONS.has(operation)) {
    return { allowed: false, reason: 'Browser mutations and unknown browser commands are blocked in Explore mode.' };
  }
  if (operation === 'navigate') {
    const target = [input["url"], input["href"], input["target"]]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    if (!target || !isObservationalBrowserCommand(['navigate', target])) {
      return { allowed: false, reason: 'Browser mutations and unknown browser commands are blocked in Explore mode.' };
    }
  }
  if (operation === 'downloads') {
    const action = typeof input["action"] === 'string' ? input["action"].trim().toLowerCase() : 'list';
    if (action !== 'list' && action !== 'wait') {
      return { allowed: false, reason: 'Browser mutations and unknown browser commands are blocked in Explore mode.' };
    }
  }
  return { allowed: true };
}
