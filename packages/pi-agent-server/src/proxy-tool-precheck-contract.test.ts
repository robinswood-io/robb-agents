import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';

const sources = new Map(readdirSync(new URL('./index/', import.meta.url))
  .filter(name => name.endsWith('.ts'))
  .map(name => [name, readFileSync(new URL('./index/' + name, import.meta.url), 'utf8')]));
const source = [readFileSync(new URL('./index.ts', import.meta.url), 'utf8'), ...sources.values()].join('\n');

function sourceFunction(file: string, name: string): string {
  const text = sources.get(file);
  if (!text) throw new Error('Missing Pi runtime source: ' + file);
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration) throw new Error('Missing Pi runtime function: ' + name);
  return declaration.getText(ast);
}

describe('Pi proxy PreToolUse contract', () => {
  it('admits every proxy invocation exactly once through the outer tool wrapper', () => {
    const wrapper = sourceFunction('tool-execution.ts', 'wrapSingleTool');
    const proxyBuilder = sourceFunction('tool-execution.ts', 'buildProxyTools');

    expect(wrapper.match(/requestPreToolUseApproval\(/g)).toHaveLength(1);
    expect(proxyBuilder).not.toContain('requestPreToolUseApproval(');
    expect(proxyBuilder).toContain('const approvedInput = params as Record<string, unknown>;');
  });

  it('never dispatches a proxy from the planned assistant batch before PreToolUse', () => {
    const eventHandler = sourceFunction('events.ts', 'handleSessionEvent');

    expect(eventHandler).not.toContain("type: 'tool_execute_request'");
    expect(eventHandler).not.toContain('waitForProxyToolResponse(');
    expect(source).not.toContain('prefetchCache');
  });
});
