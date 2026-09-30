import { describe, it, expect } from 'bun:test';
import {
  normalizeCanonicalBrowserToolName,
  normalizeBrowserToolName,
  isCanonicalBrowserToolName,
  isBrowserToolNameOrAlias,
} from '../browser-tool-names.ts';

describe('browser tool name normalization', () => {
  it('normalizes canonical names', () => {
    expect(normalizeCanonicalBrowserToolName('browser_tool')).toBe('browser_tool');
    expect(normalizeCanonicalBrowserToolName('mcp__session__browser_tool')).toBe('browser_tool');
    expect(normalizeCanonicalBrowserToolName('mcp__workspace__browser_tool')).toBe('browser_tool');
    expect(normalizeCanonicalBrowserToolName('session__browser_tool')).toBe('browser_tool');

    expect(normalizeBrowserToolName('browser_tool')).toBe('browser_tool');
    expect(normalizeBrowserToolName('mcp__session__browser_tool')).toBe('browser_tool');
    expect(normalizeBrowserToolName('session__browser_tool')).toBe('browser_tool');
  });

  it('canonical helper rejects legacy aliases', () => {
    expect(normalizeCanonicalBrowserToolName('browser_open')).toBeNull();
    expect(normalizeCanonicalBrowserToolName('mcp__session__browser_snapshot')).toBeNull();
    expect(isCanonicalBrowserToolName('browser_tool')).toBe(true);
    expect(isCanonicalBrowserToolName('browser_open')).toBe(false);
  });

  it('normalizes legacy aliases', () => {
    expect(normalizeBrowserToolName('browser_open')).toBe('browser_tool');
    expect(normalizeBrowserToolName('browser_snapshot')).toBe('browser_tool');
    expect(normalizeBrowserToolName('mcp__session__browser_open')).toBe('browser_tool');
    expect(normalizeBrowserToolName('mcp__session__browser_click_at')).toBe('browser_tool');
    expect(normalizeBrowserToolName('mcp__playwright__browser_snapshot')).toBe('browser_tool');
    expect(normalizeBrowserToolName('mcp__playwright__playwright_navigate')).toBe('browser_tool');
    expect(normalizeBrowserToolName('mcp__puppeteer__puppeteer_click')).toBe('browser_tool');
    expect(normalizeBrowserToolName('mcp__puppeteer__screenshot')).toBe('browser_tool');
  });

  it('returns null for non-browser tools', () => {
    expect(normalizeBrowserToolName('Read')).toBeNull();
    expect(normalizeBrowserToolName('mcp__session__source_test')).toBeNull();
    expect(normalizeBrowserToolName('mcp__crm__browser_usage_report')).toBeNull();
    expect(normalizeBrowserToolName('mcp__crm__playwright_account')).toBeNull();
    expect(normalizeBrowserToolName('mcp__business-browser__search')).toBeNull();
  });

  it('detects canonical + aliases with boolean helper', () => {
    expect(isBrowserToolNameOrAlias('browser_tool')).toBe(true);
    expect(isBrowserToolNameOrAlias('mcp__session__browser_snapshot')).toBe(true);
    expect(isBrowserToolNameOrAlias('mcp__playwright__browser_snapshot')).toBe(true);
    expect(isBrowserToolNameOrAlias('mcp__puppeteer__puppeteer_click')).toBe(true);
    expect(isBrowserToolNameOrAlias('Write')).toBe(false);
  });
});
