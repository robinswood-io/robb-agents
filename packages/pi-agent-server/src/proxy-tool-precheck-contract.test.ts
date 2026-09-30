import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

function sourceBetween(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe('Pi proxy PreToolUse contract', () => {
  it('admits every proxy invocation exactly once through the outer tool wrapper', () => {
    const wrapper = sourceBetween(
      'function wrapSingleTool(',
      '// ============================================================\n// Proxy Tools',
    );
    const proxyBuilder = sourceBetween(
      'function buildProxyTools()',
      '// ============================================================\n// LLM Query',
    );

    expect(wrapper.match(/requestPreToolUseApproval\(/g)).toHaveLength(1);
    expect(proxyBuilder).not.toContain('requestPreToolUseApproval(');
    expect(proxyBuilder).toContain('const approvedInput = params as Record<string, unknown>;');
  });

  it('never dispatches a proxy from the planned assistant batch before PreToolUse', () => {
    const eventHandler = sourceBetween(
      'function handleSessionEvent(',
      'async function handleInit(',
    );

    expect(eventHandler).not.toContain("type: 'tool_execute_request'");
    expect(eventHandler).not.toContain('waitForProxyToolResponse(');
    expect(source).not.toContain('prefetchCache');
  });
});
