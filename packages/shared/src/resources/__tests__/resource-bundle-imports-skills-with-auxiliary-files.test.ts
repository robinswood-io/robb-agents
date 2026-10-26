import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { importResources } from '../resource-bundle';

import type { ResourceBundle } from '../types';
import { createTestWorkspace, createTestSource, createTestSkill, makeBundleFile, noopDeps } from "./testing/resource-bundle-fixture.ts";


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

describe('importResources', () => {
it('imports skills with auxiliary files', async () => {
      const wsDir = createTestWorkspace(tmpDir)

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          skills: [{
            slug: 'pdf-tools',
            files: [
              makeBundleFile('SKILL.md', '---\nname: PDF Tools\ndescription: PDF stuff\n---\nInstructions'),
              makeBundleFile('forms.md', '# Forms'),
              makeBundleFile('scripts/extract.py', 'import pdf'),
            ],
          }],
        },
      }

      const result = await importResources(wsDir, bundle, 'skip', noopDeps)

      expect(result.skills.imported).toEqual(['pdf-tools'])
      expect(existsSync(join(wsDir, 'skills', 'pdf-tools', 'SKILL.md'))).toBe(true)
      expect(existsSync(join(wsDir, 'skills', 'pdf-tools', 'forms.md'))).toBe(true)
      expect(existsSync(join(wsDir, 'skills', 'pdf-tools', 'scripts', 'extract.py'))).toBe(true)
    })

it('skips existing resources in skip mode', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSource(wsDir, 'existing')
      createTestSkill(wsDir, 'existing-skill')

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'existing',
            config: { id: 'x', name: 'X', slug: 'existing', enabled: true, provider: 'x', type: 'api', api: { baseUrl: 'http://new', authType: 'none' }, createdAt: 1, updatedAt: 1 },
            files: [makeBundleFile('guide.md', '# New guide')],
          }],
          skills: [{
            slug: 'existing-skill',
            files: [makeBundleFile('SKILL.md', '---\nname: new\ndescription: new\n---\nNew')],
          }],
        },
      }

      const result = await importResources(wsDir, bundle, 'skip', noopDeps)

      expect(result.sources.skipped).toEqual(['existing'])
      expect(result.skills.skipped).toEqual(['existing-skill'])
      // Original content should be preserved
      expect(readFileSync(join(wsDir, 'sources', 'existing', 'guide.md'), 'utf-8')).toContain('Usage guide')
    })

it('replaces existing resources in overwrite mode', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSource(wsDir, 'target')

      // Add an extra file to the original that shouldn't survive overwrite
      writeFileSync(join(wsDir, 'sources', 'target', 'old-file.txt'), 'stale')

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'target',
            config: {
              id: 'target_new',
              name: 'Target',
              slug: 'target',
              enabled: true,
              provider: 'custom',
              type: 'api',
              api: { baseUrl: 'https://new-api.example.com', authType: 'none' },
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
            files: [makeBundleFile('guide.md', '# New guide')],
          }],
        },
      }

      const result = await importResources(wsDir, bundle, 'overwrite', noopDeps)

      expect(result.sources.imported).toEqual(['target'])
      // New content
      expect(readFileSync(join(wsDir, 'sources', 'target', 'guide.md'), 'utf-8')).toBe('# New guide')
      // Old stale file should be gone (full replacement)
      expect(existsSync(join(wsDir, 'sources', 'target', 'old-file.txt'))).toBe(false)
    })

it('refuses to overwrite a protected source even when no caller hook is provided', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSource(wsDir, 'protected-source')
      const sourceDir = join(wsDir, 'sources', 'protected-source')
      writeFileSync(join(sourceDir, '.robb-source-overlay.json'), '{"schemaVersion":1}')
      let credentialsCleared = false
      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'protected-source',
            config: {
              id: 'protected-source_new',
              name: 'Protected Source',
              slug: 'protected-source',
              enabled: true,
              provider: 'custom',
              type: 'api',
              api: { baseUrl: 'https://replacement.example.com', authType: 'none' },
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
            files: [makeBundleFile('guide.md', '# Replacement')],
          }],
        },
      }

      const result = await importResources(wsDir, bundle, 'overwrite', {
        clearSourceCredentials: async () => { credentialsCleared = true },
      })

      expect(result.sources.imported).toEqual([])
      expect(result.sources.failed[0]?.error).toContain('Protected source overlay cannot be replaced')
      expect(credentialsCleared).toBe(false)
      expect(readFileSync(join(sourceDir, 'guide.md'), 'utf-8')).toContain('Usage guide')
    })

it('refuses a staged overlay marker on an unprotected or new source', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'forged-overlay',
            config: {
              id: 'forged-overlay_x',
              name: 'Forged Overlay',
              slug: 'forged-overlay',
              enabled: true,
              provider: 'custom',
              type: 'api',
              api: { baseUrl: 'https://example.com', authType: 'none' },
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
            files: [
              makeBundleFile('guide.md', '# Guide'),
              makeBundleFile('.robb-source-overlay.json', '{"schemaVersion":1}'),
            ],
          }],
        },
      }

      const result = await importResources(wsDir, bundle, 'overwrite', noopDeps)

      expect(result.sources.imported).toEqual([])
      expect(result.sources.failed[0]?.error).toContain('cannot create a protected source overlay marker')
      expect(existsSync(join(wsDir, 'sources', 'forged-overlay'))).toBe(false)
    })

it('calls clearSourceCredentials on source overwrite', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSource(wsDir, 'creds-test')

      const cleared: string[] = []
      const deps = {
        clearSourceCredentials: async (_wsId: string, slug: string) => {
          cleared.push(slug)
        },
      }

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'creds-test',
            config: {
              id: 'creds-test_x',
              name: 'Creds Test',
              slug: 'creds-test',
              enabled: true,
              provider: 'custom',
              type: 'api',
              api: { baseUrl: 'https://api.example.com', authType: 'none' },
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
            files: [],
          }],
        },
      }

      await importResources(wsDir, bundle, 'overwrite', deps)
      expect(cleared).toEqual(['creds-test'])
    })

it('calls validateStagedSource with the fully restored source before import', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      const observed: Array<{ workspaceId: string; slug: string; stagedDir: string; guide: string }> = []
      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'validated-source',
            config: {
              id: 'validated-source_x',
              name: 'Validated Source',
              slug: 'validated-source',
              enabled: true,
              provider: 'custom',
              type: 'api',
              api: { baseUrl: 'https://api.example.com', authType: 'none' },
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
            files: [makeBundleFile('guide.md', '# Validated guide')],
          }],
        },
      }

      const result = await importResources(wsDir, bundle, 'skip', {
        ...noopDeps,
        validateStagedSource: async (workspaceId, slug, stagedDir) => {
          observed.push({
            workspaceId,
            slug,
            stagedDir,
            guide: readFileSync(join(stagedDir, 'guide.md'), 'utf-8'),
          })
          expect(existsSync(join(stagedDir, 'config.json'))).toBe(true)
          expect(existsSync(join(wsDir, 'sources', slug))).toBe(false)
        },
      })

      expect(result.sources.imported).toEqual(['validated-source'])
      expect(observed).toHaveLength(1)
      expect(observed[0]?.workspaceId).toBe('workspace')
      expect(observed[0]?.slug).toBe('validated-source')
      expect(observed[0]?.stagedDir).toContain('.tmp-validated-source-')
      expect(observed[0]?.guide).toBe('# Validated guide')
    })

it('keeps the live source and credentials intact when staged source validation rejects', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSource(wsDir, 'protected-source')
      const sourceDir = join(wsDir, 'sources', 'protected-source')
      writeFileSync(join(sourceDir, 'old-file.txt'), 'keep me')
      const originalConfig = readFileSync(join(sourceDir, 'config.json'), 'utf-8')
      let clearCredentialsCalls = 0

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'protected-source',
            config: {
              id: 'protected-source_new',
              name: 'Protected Source',
              slug: 'protected-source',
              enabled: true,
              provider: 'custom',
              type: 'api',
              api: { baseUrl: 'https://new-api.example.com', authType: 'none' },
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
            files: [makeBundleFile('guide.md', '# Replacement guide')],
          }],
        },
      }

      const result = await importResources(wsDir, bundle, 'overwrite', {
        clearSourceCredentials: async () => {
          clearCredentialsCalls++
        },
        validateStagedSource: async () => {
          throw new Error('staged source rejected')
        },
      })

      expect(result.sources.imported).toEqual([])
      expect(result.sources.failed).toEqual([{ id: 'protected-source', error: 'staged source rejected' }])
      expect(clearCredentialsCalls).toBe(0)
      expect(readFileSync(join(sourceDir, 'config.json'), 'utf-8')).toBe(originalConfig)
      expect(readFileSync(join(sourceDir, 'guide.md'), 'utf-8')).toContain('Usage guide')
      expect(readFileSync(join(sourceDir, 'old-file.txt'), 'utf-8')).toBe('keep me')
      expect(readdirSync(join(wsDir, 'sources')).some(name => name.startsWith('.tmp-protected-source-'))).toBe(false)
    })

it.each([
      ['a protected overlay marker', (stagedDir: string) => {
        writeFileSync(join(stagedDir, '.robb-source-overlay.json'), '{"forged":true}')
      }],
      ['the staged config', (stagedDir: string) => {
        const configPath = join(stagedDir, 'config.json')
        const config = JSON.parse(readFileSync(configPath, 'utf-8'))
        config.slug = 'retargeted-source'
        writeFileSync(configPath, JSON.stringify(config))
      }],
      ['a restored source file', (stagedDir: string) => {
        writeFileSync(join(stagedDir, 'guide.md'), '# Changed after validation')
      }],
    ] as const)('rejects when validateStagedSource writes %s', async (_label, mutateStaging) => {
      const wsDir = createTestWorkspace(tmpDir)
      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'hook-source',
            config: {
              id: 'hook-source_x',
              name: 'Hook Source',
              slug: 'hook-source',
              enabled: true,
              provider: 'custom',
              type: 'api',
              api: { baseUrl: 'https://api.example.com', authType: 'none' },
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
            files: [makeBundleFile('guide.md', '# Original guide')],
          }],
        },
      }
      let credentialsCleared = false

      const result = await importResources(wsDir, bundle, 'skip', {
        clearSourceCredentials: async () => { credentialsCleared = true },
        validateStagedSource: async (_workspaceId, _slug, stagedDir) => {
          mutateStaging(stagedDir)
        },
      })

      expect(result.sources.imported).toEqual([])
      expect(result.sources.failed[0]?.error).toContain('changed during validateStagedSource')
      expect(credentialsCleared).toBe(false)
      expect(existsSync(join(wsDir, 'sources', 'hook-source'))).toBe(false)
      expect(readdirSync(join(wsDir, 'sources')).some(name => name.startsWith('.tmp-hook-source-'))).toBe(false)
    })

it('rejects staged bytes changed by asynchronous credential cleanup before live promotion', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSource(wsDir, 'credential-race-source')
      const sourceDir = join(wsDir, 'sources', 'credential-race-source')
      const originalGuide = readFileSync(join(sourceDir, 'guide.md'), 'utf-8')
      let credentialCleanupCompleted = false
      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'credential-race-source',
            config: {
              id: 'credential-race-source_new',
              name: 'Credential Race Source',
              slug: 'credential-race-source',
              enabled: true,
              provider: 'custom',
              type: 'api',
              api: { baseUrl: 'https://new-api.example.com', authType: 'none' },
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
            files: [makeBundleFile('guide.md', '# Validated replacement')],
          }],
        },
      }

      const result = await importResources(wsDir, bundle, 'overwrite', {
        validateStagedSource: async () => undefined,
        clearSourceCredentials: async () => {
          credentialCleanupCompleted = true
          const stagedName = readdirSync(join(wsDir, 'sources'))
            .find(name => name.startsWith('.tmp-credential-race-source-'))
          expect(stagedName).toBeDefined()
          writeFileSync(
            join(wsDir, 'sources', stagedName!, 'guide.md'),
            '# Changed while credential cleanup awaited',
          )
        },
      })

      expect(credentialCleanupCompleted).toBe(true)
      expect(result.sources.imported).toEqual([])
      expect(result.sources.failed[0]?.error).toContain('changed during credential cleanup')
      expect(readFileSync(join(sourceDir, 'guide.md'), 'utf-8')).toBe(originalGuide)
      expect(readdirSync(join(wsDir, 'sources'))
        .some(name => name.startsWith('.tmp-credential-race-source-'))).toBe(false)
    })
});
});
