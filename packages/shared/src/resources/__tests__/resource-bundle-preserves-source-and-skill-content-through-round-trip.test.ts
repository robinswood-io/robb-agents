import { AutomationsConfigSchema } from '../../automations/schemas.ts';
import { parseJsonObject } from '../../utils/json.ts';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { exportResources, importResources } from '../resource-bundle';

import { createTestWorkspace, createTestSource, createTestSkill, createTestAutomations, noopDeps } from "./testing/resource-bundle-fixture.ts";


describe('resource-bundle', () => {
let tmpDir: string

beforeEach(() => {
    tmpDir = join(tmpdir(), `resource-bundle-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
  })

afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true })
    }
  })

describe('round-trip export → import', () => {
it('preserves source and skill content through round-trip', async () => {
      // Create source workspace with resources
      const srcDir = createTestWorkspace(join(tmpDir, 'src'))
      createTestSource(srcDir, 'my-api')
      createTestSkill(srcDir, 'my-skill', {
        'helper.ts': 'export function help() {}',
      })

      // Export
      const { bundle } = exportResources(srcDir, { sources: 'all', skills: 'all' })

      // Import into fresh workspace
      const dstDir = createTestWorkspace(join(tmpDir, 'dst'))
      const result = await importResources(dstDir, bundle, 'skip', noopDeps)

      expect(result.sources.imported).toEqual(['my-api'])
      expect(result.skills.imported).toEqual(['my-skill'])

      // Verify source files
      expect(existsSync(join(dstDir, 'sources', 'my-api', 'config.json'))).toBe(true)
      expect(existsSync(join(dstDir, 'sources', 'my-api', 'guide.md'))).toBe(true)

      // Verify skill files
      expect(existsSync(join(dstDir, 'skills', 'my-skill', 'SKILL.md'))).toBe(true)
      expect(existsSync(join(dstDir, 'skills', 'my-skill', 'helper.ts'))).toBe(true)
      expect(readFileSync(join(dstDir, 'skills', 'my-skill', 'helper.ts'), 'utf-8')).toBe('export function help() {}')

      // Imported source config should have auth reset
      const importedConfig = parseJsonObject(readFileSync(join(dstDir, 'sources', 'my-api', 'config.json'), 'utf-8'))
      expect(importedConfig["isAuthenticated"]).toBe(false)
    })

it('preserves automations through round-trip', async () => {
      const srcDir = createTestWorkspace(join(tmpDir, 'src'))
      createTestAutomations(srcDir, {
        UserPromptSubmit: [
          { id: 'aaa111', name: 'Greet', actions: [{ type: 'prompt', prompt: 'hello' }] },
        ],
        SchedulerTick: [
          { id: 'bbb222', name: 'Daily Check', cron: '0 9 * * 1-5', timezone: 'Europe/Budapest', actions: [{ type: 'prompt', prompt: 'check' }] },
        ],
      })

      // Export
      const { bundle } = exportResources(srcDir, { automations: 'all' })
      expect(bundle.resources.automations).toHaveLength(2)

      // Import into fresh workspace
      const dstDir = createTestWorkspace(join(tmpDir, 'dst'))
      const result = await importResources(dstDir, bundle, 'skip', noopDeps)

      expect(result.automations.imported).toHaveLength(2)

      const config = AutomationsConfigSchema.parse(JSON.parse(readFileSync(join(dstDir, 'automations.json'), 'utf-8')))
      expect(config["version"]).toBe(2)
      expect(config.automations["UserPromptSubmit"]).toHaveLength(1)
      expect(config.automations["UserPromptSubmit"]?.[0]?.name).toBe('Greet')
      expect(config.automations["SchedulerTick"]).toHaveLength(1)
      expect(config.automations["SchedulerTick"]?.[0]?.cron).toBe('0 9 * * 1-5')
    })
});
});
