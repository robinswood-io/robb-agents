export const AUTONOMY_BROWSER_FALLBACK_MARKER = '<automatic_browser_fallback';
export const AUTONOMY_STRUCTURED_FALLBACK_MARKER = '<automatic_structured_fallback';

export function buildAutonomyBrowserFallbackPrompt(toolName: string): string {
  const safeToolName = toolName.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 160);
  return [
    `<automatic_browser_fallback failed_tool="${safeToolName}">`,
    'The preceding tool failed. Use the integrated browser now as the next materially different access path when it can reach the same in-scope outcome.',
    'Do not retry the failed tool unchanged. Before any external mutation, verify whether the prior attempt already took effect; never duplicate an ambiguous side effect.',
    'Continue autonomously and verify the observable result.',
    '</automatic_browser_fallback>',
  ].join('\n');
}

export function isAutonomyBrowserFallbackPrompt(message: string): boolean {
  return message.trimStart().startsWith(AUTONOMY_BROWSER_FALLBACK_MARKER);
}

export function buildAutonomyStructuredFallbackPrompt(toolName: string): string {
  const safeToolName = toolName.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 160);
  return [
    `<automatic_structured_fallback failed_tool="${safeToolName}">`,
    'The browser or remote-desktop path failed. Stop coordinate and pixel retries now.',
    'Inspect the connected tools and continue through the narrowest equivalent structured route: native remote agent, SSH, database connection, application API, or source connector.',
    'Do not replay an external mutation whose result is ambiguous. Read back state first, keep the original objective and scope, then verify the observable outcome.',
    'Use the browser again only for an unavoidable UI-only step, interactive authentication, or final rendered-journey verification.',
    '</automatic_structured_fallback>',
  ].join('\n');
}

export function isAutonomyStructuredFallbackPrompt(message: string): boolean {
  return message.trimStart().startsWith(AUTONOMY_STRUCTURED_FALLBACK_MARKER);
}
