/**
 * Shared PreToolUse utilities and centralized PreToolUse pipeline.
 *
 * Individual utility functions (path expansion, skill qualification, etc.)
 * are used by the centralized `runPreToolUseChecks()` pipeline, which both
 * agent backends (Claude and Pi) call with normalized input and then translate
 * the result to their SDK-specific format. Pi hosts non-Anthropic model
 * providers (OpenAI, GitHub Copilot, Bedrock, etc.) under a single backend,
 * so they inherit this pipeline transparently.
 *
 * Pipeline steps:
 * 1. Permission mode check: Block tools disallowed by current mode
 * 2. Source blocking: Block tools from inactive MCP sources
 * 3. Prerequisite check: Block source tools until guide.md is read
 * 4. call_llm detection: Intercept mcp__session__call_llm
 * 5. Input transforms: Path expansion, config validation, skill qualification, metadata stripping
 * 6. Ask-mode prompt decision: Determine if user approval is needed
 */
import { isObservationalBrowserCommand } from "../../browser-tool-runtime.ts";
import { isCanonicalBrowserToolName } from "../../browser-tool-names.ts";

const OBSERVATIONAL_LEGACY_BROWSER_OPERATIONS = new Set([
  'open',
  'navigate',
  'read',
  'snapshot',
  'screenshot',
  'screenshot-region',
  'get',
  'get-clipboard',
  'find',
  'search',
  'console',
  'network',
  'wait',
  'resume',
  'downloads',
  'scroll',
  'back',
  'forward',
  'focus',
  'windows',
]);

type BrowserObjectiveAuthority = 'not-browser' | 'observational' | 'mutation-or-unknown';

export function classifyBrowserObjectiveAuthority(
  toolName: string,
  input: Record<string, unknown>,
): BrowserObjectiveAuthority {
  if (isCanonicalBrowserToolName(toolName)) {
    return isObservationalBrowserCommand(input["command"])
      ? 'observational'
      : 'mutation-or-unknown';
  }

  const leafName = toolName.split('__').at(-1)?.trim().toLowerCase();
  if (!leafName?.startsWith('browser_')) return 'not-browser';

  const operation = leafName.slice('browser_'.length).replaceAll('_', '-');
  if (!OBSERVATIONAL_LEGACY_BROWSER_OPERATIONS.has(operation)) {
    return 'mutation-or-unknown';
  }
  if (operation === 'navigate') {
    const target = [input["url"], input["href"], input["target"]]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    return target && isObservationalBrowserCommand(['navigate', target])
      ? 'observational'
      : 'mutation-or-unknown';
  }
  if (operation === 'downloads') {
    const action = typeof input["action"] === 'string' ? input["action"].trim().toLowerCase() : 'list';
    return action === 'list' || action === 'wait' ? 'observational' : 'mutation-or-unknown';
  }
  return 'observational';
}
