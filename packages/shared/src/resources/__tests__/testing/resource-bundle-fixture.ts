import { mkdirSync, writeFileSync } from "fs";

import { join } from "path";

import type { AutomationBundleEntry } from "../../types";

import type { FolderSourceConfig } from "../../../sources/types";

import type { AutomationMatcher } from "../../../automations/types";



// ============================================================
// Helpers
// ============================================================

export function createTestWorkspace(rootDir: string): string {
  const wsDir = join(rootDir, 'workspace')
  mkdirSync(join(wsDir, 'sources'), { recursive: true })
  mkdirSync(join(wsDir, 'skills'), { recursive: true })
  writeFileSync(join(wsDir, 'config.json'), JSON.stringify({ name: 'Test Workspace' }))
  return wsDir
}

export function createTestSource(wsDir: string, slug: string, config?: Partial<FolderSourceConfig>): void {
  const sourceDir = join(wsDir, 'sources', slug)
  mkdirSync(sourceDir, { recursive: true })

  const defaultConfig: FolderSourceConfig = {
    id: `${slug}_abc123`,
    name: slug,
    slug,
    enabled: true,
    provider: 'custom',
    type: 'api',
    api: { baseUrl: 'https://api.example.com', authType: 'bearer' },
    isAuthenticated: true,
    connectionStatus: 'connected',
    lastTestedAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...config,
  }

  writeFileSync(join(sourceDir, 'config.json'), JSON.stringify(defaultConfig, null, 2))
  writeFileSync(join(sourceDir, 'guide.md'), `# ${slug}\n\nUsage guide.`)
}

export function createTestSkill(wsDir: string, slug: string, extraFiles?: Record<string, string>): void {
  const skillDir = join(wsDir, 'skills', slug)
  mkdirSync(skillDir, { recursive: true })

  writeFileSync(join(skillDir, 'SKILL.md'), `---
name: ${slug}
description: Test skill ${slug}
---

Instructions for ${slug}.
`)

  if (extraFiles) {
    for (const [name, content] of Object.entries(extraFiles)) {
      const filePath = join(skillDir, name)
      const dir = join(skillDir, ...name.split('/').slice(0, -1))
      if (dir !== skillDir) mkdirSync(dir, { recursive: true })
      writeFileSync(filePath, content)
    }
  }
}

export function makeBundleFile(path: string, content: string) {
  const buf = Buffer.from(content)
  return {
    relativePath: path,
    contentBase64: buf.toString('base64'),
    size: buf.length,
  }
}

export function createTestAutomations(
  wsDir: string,
  automations: Record<string, AutomationMatcher[]>,
  version = 2,
): void {
  writeFileSync(join(wsDir, 'automations.json'), JSON.stringify({ version, automations }, null, 2))
}

export function makeAutomationEntry(overrides: Partial<AutomationBundleEntry> & { id: string; event: string }): AutomationBundleEntry {
  return {
    matcher: {
      id: overrides.id,
      name: overrides.name,
      actions: [{ type: 'prompt', prompt: 'test' }],
    },
    ...overrides,
  }
}

// Minimal valid deps for import
export const noopDeps = {
  clearSourceCredentials: async () => {},
}
