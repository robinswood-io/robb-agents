import { describe, expect, it } from 'bun:test';
import {
  buildAutonomyBrowserFallbackPrompt,
  isAutonomyBrowserFallbackPrompt,
} from './autonomy-browser-fallback.ts';

describe('autonomy browser fallback prompt', () => {
  it('requests a real alternative path without replaying ambiguous mutations', () => {
    const prompt = buildAutonomyBrowserFallbackPrompt('mcp__crm__lookup');
    expect(isAutonomyBrowserFallbackPrompt(prompt)).toBe(true);
    expect(prompt).toContain('Use the integrated browser now');
    expect(prompt).toContain('Do not retry the failed tool unchanged');
    expect(prompt).toContain('never duplicate an ambiguous side effect');
  });

  it('sanitizes provider-controlled tool names before embedding them in markup', () => {
    const prompt = buildAutonomyBrowserFallbackPrompt('tool"/><unsafe>');
    expect(prompt).not.toContain('<unsafe>');
    expect(prompt).toContain('failed_tool="tool____unsafe_"');
  });
});
