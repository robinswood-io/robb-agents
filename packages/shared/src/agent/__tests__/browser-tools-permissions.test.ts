/**
 * Tests for browser tool permission handling across permission modes.
 *
 * Explore permits browser observations, but browser interactions that can
 * mutate a remote page remain behind Ask/Execute.
 */
import { describe, it, expect } from 'bun:test';
import { shouldAllowToolInMode } from '../../agent/mode-manager.ts';

const observationalCalls = [
  ['browser_tool', { command: 'snapshot' }],
  ['mcp__session__browser_tool', { command: 'navigate https://example.com/status' }],
  ['browser_snapshot', {}],
  ['browser_open', {}],
  ['mcp__session__browser_snapshot', {}],
  ['mcp__session__browser_navigate', { url: 'https://example.com/status' }],
] as const;

const mutatingCalls = [
  ['browser_tool', { command: 'click @e1' }],
  ['mcp__session__browser_tool', { command: 'fill @e1 changed' }],
  ['browser_tool', { command: 'type changed' }],
  ['mcp__session__browser_tool', { command: 'key Enter' }],
  ['browser_tool', { command: 'select @e1 changed' }],
  ['mcp__session__browser_tool', { command: 'upload @e1 /tmp/file' }],
  ['browser_tool', { command: 'paste changed' }],
  ['mcp__session__browser_tool', { command: 'evaluate 1+1' }],
  ['browser_click', {}],
  ['mcp__session__browser_fill', {}],
  ['browser_type', {}],
  ['mcp__session__browser_key', {}],
  ['browser_select', {}],
  ['mcp__session__browser_upload', {}],
  ['browser_paste', {}],
  ['mcp__session__browser_evaluate', {}],
] as const;

describe('browser tools permission mode handling', () => {
  it('allows only observational browser calls in safe mode', () => {
    for (const [toolName, input] of observationalCalls) {
      const result = shouldAllowToolInMode(toolName, input, 'safe');
      expect(result.allowed).toBe(true);
    }
    for (const [toolName, input] of mutatingCalls) {
      const result = shouldAllowToolInMode(toolName, input, 'safe');
      expect(result.allowed).toBe(false);
    }
    expect(shouldAllowToolInMode('browser_tool', { command: 'snapshot; click @e1' }, 'safe').allowed).toBe(false);
    expect(shouldAllowToolInMode('browser_tool', { command: 'teleport somewhere' }, 'safe').allowed).toBe(false);
  });

  it('does not turn the mode manager into an extra browser gate in ask mode', () => {
    for (const [toolName, input] of [...observationalCalls, ...mutatingCalls]) {
      const result = shouldAllowToolInMode(toolName, input, 'ask');
      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.requiresPermission).toBeFalsy();
      }
    }
  });

  it('keeps browser observations and mutations available in allow-all mode', () => {
    for (const [toolName, input] of [...observationalCalls, ...mutatingCalls]) {
      const result = shouldAllowToolInMode(toolName, input, 'allow-all');
      expect(result.allowed).toBe(true);
    }
  });
});
