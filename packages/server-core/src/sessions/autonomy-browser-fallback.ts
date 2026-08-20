export const AUTONOMY_BROWSER_FALLBACK_MARKER = '<automatic_browser_fallback';

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
