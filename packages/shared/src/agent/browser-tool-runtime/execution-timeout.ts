import { BROWSER_TOOL_TIMEOUT_GRACE_MS, DEFAULT_BROWSER_TOOL_EXECUTION_TIMEOUT_MS, MAX_BROWSER_TOOL_EXECUTION_TIMEOUT_MS, MAX_BROWSER_TOOL_REQUESTED_TIMEOUT_MS } from "../browser-tool-execution-watchdog.ts";
import { NAVIGATION_COMMANDS, splitBatchCommands, tokenizeCommand } from './command-syntax.ts';

function finitePositiveTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function boundedBrowserCommandTimeout(raw: string, command: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${command} timeout "${raw}". Expected a finite number.`);
  }
  return Math.max(100, Math.min(MAX_BROWSER_TOOL_REQUESTED_TIMEOUT_MS, parsed));
}

function requestedBrowserCommandTimeoutMs(parts: string[]): number | undefined {
  const cmd = parts[0]?.toLowerCase();
  if (!cmd) return undefined;

  if (cmd === 'resume') {
    return finitePositiveTimeout(parts[1]) ?? 120_000;
  }
  if (cmd === 'click') {
    return finitePositiveTimeout(parts[3]);
  }
  if (cmd === 'wait') {
    return finitePositiveTimeout(parts[1]?.toLowerCase() === 'network-idle' ? parts[2] : parts[3]);
  }
  if (cmd === 'downloads' && parts[1]?.toLowerCase() === 'wait') {
    return finitePositiveTimeout(parts[2]);
  }
  if (cmd === 'select') {
    const timeoutIndex = parts.indexOf('--timeout');
    return timeoutIndex >= 0 ? finitePositiveTimeout(parts[timeoutIndex + 1]) : undefined;
  }
  return undefined;
}

/** 45s of work plus the shared 15s receipt grace preserves the 60s default. */
const DEFAULT_BROWSER_COMMAND_EXECUTION_BUDGET_MS =
  DEFAULT_BROWSER_TOOL_EXECUTION_TIMEOUT_MS - BROWSER_TOOL_TIMEOUT_GRACE_MS;

/**
 * Keep ordinary actions responsive while preserving the explicit long waits
 * supported by `wait`, `resume`, `click`, `select`, and `downloads wait`.
 * Even an excessive caller-provided timeout is capped at five minutes plus a
 * short transport/result grace period.
 */
export function resolveBrowserToolExecutionTimeoutMs(
  command: string | string[],
  invalidCommandTimeoutMs = DEFAULT_BROWSER_TOOL_EXECUTION_TIMEOUT_MS,
): number {
  const invalidFallback = Number.isFinite(invalidCommandTimeoutMs)
    ? Math.min(MAX_BROWSER_TOOL_EXECUTION_TIMEOUT_MS,
      Math.max(DEFAULT_BROWSER_TOOL_EXECUTION_TIMEOUT_MS, invalidCommandTimeoutMs))
    : DEFAULT_BROWSER_TOOL_EXECUTION_TIMEOUT_MS;
  let commandParts: string[][];
  try {
    commandParts = Array.isArray(command)
      ? [command]
      : splitBatchCommands(command.trim()).map(tokenizeCommand);
  } catch {
    // The command executor will return the actual parse error. The watchdog
    // resolver must never turn malformed input into an unbounded execution.
    return invalidFallback;
  }

  if (commandParts.length === 0) return invalidFallback;

  // Batches execute serially. Sum their individual budgets rather than taking
  // the maximum (two valid 90s waits need about 180s), add transport/result
  // grace once, and saturate during accumulation to avoid numeric overflow.
  let totalBudgetMs = BROWSER_TOOL_TIMEOUT_GRACE_MS;
  for (const parts of commandParts) {
    const commandBudgetMs = Math.min(
      requestedBrowserCommandTimeoutMs(parts) ?? DEFAULT_BROWSER_COMMAND_EXECUTION_BUDGET_MS,
      MAX_BROWSER_TOOL_EXECUTION_TIMEOUT_MS,
    );
    totalBudgetMs = Math.min(
      MAX_BROWSER_TOOL_EXECUTION_TIMEOUT_MS,
      totalBudgetMs + commandBudgetMs,
    );
    // The executor deliberately stops a batch after any navigation-capable
    // command so the caller can inspect the changed page before continuing.
    // Do not reserve time for commands that can never run.
    const commandName = parts[0]?.toLowerCase();
    if (commandName && NAVIGATION_COMMANDS.has(commandName)) break;
  }

  return Math.max(DEFAULT_BROWSER_TOOL_EXECUTION_TIMEOUT_MS, totalBudgetMs);
}
