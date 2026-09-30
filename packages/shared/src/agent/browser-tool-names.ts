/**
 * Browser tool naming helpers.
 *
 * Canonical runtime tool is `browser_tool`, but we retain compatibility with
 * legacy split tool names (browser_open, browser_snapshot, etc.) that may
 * appear in older sessions/tests/logs.
 */

/** Legacy split browser tool aliases that map to canonical `browser_tool`. */
export const LEGACY_BROWSER_TOOL_ALIASES = new Set<string>([
  'browser_open',
  'browser_close',
  'browser_navigate',
  'browser_navigate_back',
  'browser_navigate_forward',
  'browser_snapshot',
  'browser_click',
  'browser_click_at',
  'browser_drag',
  'browser_hover',
  'browser_fill',
  'browser_fill_form',
  'browser_type',
  'browser_paste',
  'browser_upload',
  'browser_file_upload',
  'browser_select',
  'browser_select_option',
  'browser_screenshot',
  'browser_take_screenshot',
  'browser_screenshot_region',
  'browser_console',
  'browser_console_messages',
  'browser_window_resize',
  'browser_resize',
  'browser_network',
  'browser_network_requests',
  'browser_wait',
  'browser_wait_for',
  'browser_key',
  'browser_press_key',
  'browser_downloads',
  'browser_scroll',
  'browser_back',
  'browser_forward',
  'browser_evaluate',
  'browser_run_code',
  'browser_handle_dialog',
  'browser_tabs',
  'browser_pdf_save',
]);

/** Explicit browser providers whose external MCP tools use either a bare
 * operation (`mcp__puppeteer__screenshot`) or a provider-prefixed operation
 * (`mcp__playwright__playwright_navigate`). Keep both sets closed so an
 * unrelated business tool that merely contains "browser" is not captured. */
const EXTERNAL_BROWSER_PROVIDERS = new Set([
  'browser',
  'browser-tool',
  'browser_tool',
  'playwright',
  'puppeteer',
]);

const EXTERNAL_BROWSER_OPERATIONS = new Set([
  'open',
  'close',
  'navigate',
  'navigate_back',
  'navigate_forward',
  'snapshot',
  'click',
  'click_at',
  'drag',
  'hover',
  'fill',
  'fill_form',
  'type',
  'paste',
  'upload',
  'file_upload',
  'select',
  'select_option',
  'screenshot',
  'take_screenshot',
  'screenshot_region',
  'console',
  'console_messages',
  'window_resize',
  'resize',
  'network',
  'network_requests',
  'wait',
  'wait_for',
  'key',
  'press_key',
  'downloads',
  'scroll',
  'back',
  'forward',
  'evaluate',
  'run_code',
  'handle_dialog',
  'tabs',
  'pdf_save',
]);

function isExternalBrowserProviderAlias(toolName: string): boolean {
  const parts = toolName.split('__');
  const leaf = parts.at(-1) ?? '';
  const namespace = parts.length > 1 ? parts.at(-2) ?? '' : '';

  for (const provider of EXTERNAL_BROWSER_PROVIDERS) {
    if (leaf.startsWith(`${provider}_`)
      && EXTERNAL_BROWSER_OPERATIONS.has(leaf.slice(provider.length + 1))) return true;
  }
  return EXTERNAL_BROWSER_PROVIDERS.has(namespace)
    && EXTERNAL_BROWSER_OPERATIONS.has(leaf);
}

/**
 * Normalize canonical browser tool names (`browser_tool`) with optional namespaces.
 * Does NOT accept legacy aliases.
 */
export function normalizeCanonicalBrowserToolName(toolName: string): 'browser_tool' | null {
  const normalized = toolName.trim();
  if (!normalized) return null;

  // Accept direct and namespaced canonical forms, e.g.:
  // - browser_tool
  // - mcp__session__browser_tool
  // - mcp__workspace__browser_tool
  return /(?:^|__)browser_tool$/i.test(normalized) ? 'browser_tool' : null;
}

/**
 * Normalize browser tool names (canonical + legacy aliases) to `browser_tool`.
 */
export function normalizeBrowserToolName(toolName: string): 'browser_tool' | null {
  const canonical = normalizeCanonicalBrowserToolName(toolName);
  if (canonical) return canonical;

  const normalized = toolName.trim().toLowerCase();
  if (!normalized) return null;

  const leaf = normalized.split('__').at(-1) ?? '';
  return LEGACY_BROWSER_TOOL_ALIASES.has(leaf) || isExternalBrowserProviderAlias(normalized)
    ? 'browser_tool'
    : null;
}

/**
 * True when a tool name is the canonical browser tool (with optional namespace prefix).
 */
export function isCanonicalBrowserToolName(toolName: string): boolean {
  return normalizeCanonicalBrowserToolName(toolName) === 'browser_tool';
}

/**
 * True when a tool name is the canonical browser tool or a supported legacy alias.
 */
export function isBrowserToolNameOrAlias(toolName: string): boolean {
  return normalizeBrowserToolName(toolName) === 'browser_tool';
}
