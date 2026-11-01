import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileSystem, type SessionToolContext } from './context.ts';
import { SESSION_TOOL_REGISTRY } from './tool-defs.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function contextFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'session-tool-arguments-'));
  directories.push(directory);
  const files = createNodeFileSystem();
  const submitted: string[] = [];
  let reads = 0;
  const context: SessionToolContext = {
    sessionId: 'argument-validation', workspacePath: directory,
    sourcesPath: join(directory, 'sources'), skillsPath: join(directory, 'skills'),
    plansFolderPath: directory,
    callbacks: { onPlanSubmitted: path => { submitted.push(path); }, onAuthRequest() {} },
    fs: { ...files, exists(path) { reads++; return files.exists(path); } },
    loadSourceConfig() { return null; },
  };
  return { context, directory, submitted, reads: () => reads };
}

describe('canonical session tool argument validation', () => {
  it.each([undefined, null, {}, { planPath: 123 }, { planPath: false }, { planPath: ['plan.md'] }])(
    'rejects invalid wire arguments before the handler reads or notifies: %j', async args => {
      const fixture = contextFixture();
      const definition = SESSION_TOOL_REGISTRY.get('SubmitPlan');
      if (!definition?.handler) throw new Error('Missing SubmitPlan registry handler');
      const result = await definition.handler(fixture.context, args);
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('Invalid arguments for SubmitPlan');
      expect(fixture.reads()).toBe(0);
      expect(fixture.submitted).toEqual([]);
    },
  );

  it('dispatches a valid plan through its existing handler exactly once', async () => {
    const fixture = contextFixture();
    const planPath = join(fixture.directory, 'plan.md');
    writeFileSync(planPath, '# QA plan\n');
    const definition = SESSION_TOOL_REGISTRY.get('SubmitPlan');
    if (!definition?.handler) throw new Error('Missing SubmitPlan registry handler');
    const result = await definition.handler(fixture.context, { planPath });
    expect(result.isError).toBe(false);
    expect(fixture.reads()).toBe(1);
    expect(fixture.submitted).toEqual([planPath]);
  });
});
