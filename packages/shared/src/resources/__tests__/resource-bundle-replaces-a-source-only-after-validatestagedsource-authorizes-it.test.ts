import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { importResources } from '../resource-bundle';

import type { ResourceBundle } from '../types';
import type { AutomationMatcher } from '../../automations/types';
import { createTestWorkspace, createTestSource, makeBundleFile, createTestAutomations, makeAutomationEntry, noopDeps } from "./testing/resource-bundle-fixture.ts";


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
it('replaces a source only after validateStagedSource authorizes it', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSource(wsDir, 'authorized-source')
      const events: string[] = []
      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'authorized-source',
            config: {
              id: 'authorized-source_new',
              name: 'Authorized Source',
              slug: 'authorized-source',
              enabled: true,
              provider: 'custom',
              type: 'api',
              api: { baseUrl: 'https://new-api.example.com', authType: 'none' },
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
            files: [makeBundleFile('guide.md', '# Authorized replacement')],
          }],
        },
      }

      const result = await importResources(wsDir, bundle, 'overwrite', {
        validateStagedSource: async (_workspaceId, _slug, stagedDir) => {
          expect(readFileSync(join(stagedDir, 'guide.md'), 'utf-8')).toBe('# Authorized replacement')
          expect(readFileSync(join(wsDir, 'sources', 'authorized-source', 'guide.md'), 'utf-8')).toContain('Usage guide')
          events.push('validated')
        },
        clearSourceCredentials: async () => {
          events.push('credentials-cleared')
        },
      })

      expect(result.sources.imported).toEqual(['authorized-source'])
      expect(events).toEqual(['validated', 'credentials-cleared'])
      expect(readFileSync(join(wsDir, 'sources', 'authorized-source', 'guide.md'), 'utf-8')).toBe('# Authorized replacement')
    })

it('never imports the protected overlay slug from a portable bundle', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSource(wsDir, 'google-contacts')
      const sourceDir = join(wsDir, 'sources', 'google-contacts')
      const lockPath = join(wsDir, 'sources', '.robb-source-transaction-google-contacts.lock')
      writeFileSync(lockPath, JSON.stringify({
        schemaVersion: 1,
        slug: 'google-contacts',
        pid: 999999,
        operation: 'overlay-install',
        createdAtUnixMs: Date.now(),
      }) + '\n', { mode: 0o600 })
      let credentialsCleared = false
      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'google-contacts',
            config: {
              id: 'google-contacts_new',
              name: 'Locked Source',
              slug: 'google-contacts',
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
      expect(result.sources.failed[0]?.error).toContain('cannot be imported from a portable resource bundle')
      expect(credentialsCleared).toBe(false)
      expect(readFileSync(join(sourceDir, 'guide.md'), 'utf-8')).toContain('Usage guide')
      expect(existsSync(lockPath)).toBe(true)
    })

it('imports automations into workspace with no existing file', async () => {
      const wsDir = createTestWorkspace(tmpDir)

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          automations: [
            makeAutomationEntry({ id: 'aaa111', name: 'Auto 1', event: 'UserPromptSubmit' }),
          ],
        },
      }

      const result = await importResources(wsDir, bundle, 'skip', noopDeps)

      expect(result.automations.imported).toEqual(['Auto 1'])
      const config = JSON.parse(readFileSync(join(wsDir, 'automations.json'), 'utf-8'))
      expect(config.version).toBe(2)
      expect(config.automations.UserPromptSubmit).toHaveLength(1)
      expect(config.automations.UserPromptSubmit[0].id).toBe('aaa111')
    })

it('merges automations into existing config', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestAutomations(wsDir, {
        UserPromptSubmit: [
          { id: 'existing1', name: 'Existing', actions: [{ type: 'prompt', prompt: 'old' }] },
        ],
      })

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          automations: [
            makeAutomationEntry({ id: 'new1', name: 'New Auto', event: 'SessionStart' }),
          ],
        },
      }

      const result = await importResources(wsDir, bundle, 'skip', noopDeps)

      expect(result.automations.imported).toEqual(['New Auto'])
      const config = JSON.parse(readFileSync(join(wsDir, 'automations.json'), 'utf-8'))
      // Existing automation should be preserved
      expect(config.automations.UserPromptSubmit).toHaveLength(1)
      expect(config.automations.UserPromptSubmit[0].id).toBe('existing1')
      // New automation should be added
      expect(config.automations.SessionStart).toHaveLength(1)
      expect(config.automations.SessionStart[0].id).toBe('new1')
    })

it('skips automations with existing ID in skip mode', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestAutomations(wsDir, {
        UserPromptSubmit: [
          { id: 'aaa111', name: 'Original', actions: [{ type: 'prompt', prompt: 'original' }] },
        ],
      })

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          automations: [
            makeAutomationEntry({ id: 'aaa111', name: 'Updated', event: 'UserPromptSubmit' }),
          ],
        },
      }

      const result = await importResources(wsDir, bundle, 'skip', noopDeps)

      expect(result.automations.skipped).toEqual(['Updated'])
      // Original should be preserved
      const config = JSON.parse(readFileSync(join(wsDir, 'automations.json'), 'utf-8'))
      expect(config.automations.UserPromptSubmit[0].name).toBe('Original')
    })

it('overwrites automation by ID in overwrite mode', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestAutomations(wsDir, {
        UserPromptSubmit: [
          { id: 'aaa111', name: 'Original', actions: [{ type: 'prompt', prompt: 'original' }] },
          { id: 'bbb222', name: 'Untouched', actions: [{ type: 'prompt', prompt: 'keep' }] },
        ],
      })

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          automations: [
            makeAutomationEntry({ id: 'aaa111', name: 'Replaced', event: 'UserPromptSubmit' }),
          ],
        },
      }

      const result = await importResources(wsDir, bundle, 'overwrite', noopDeps)

      expect(result.automations.imported).toEqual(['Replaced'])
      const config = JSON.parse(readFileSync(join(wsDir, 'automations.json'), 'utf-8'))
      // Replaced automation
      const names = config.automations.UserPromptSubmit.map((m: AutomationMatcher) => m.name)
      expect(names).toContain('Replaced')
      // Untouched automation should survive
      expect(names).toContain('Untouched')
    })

it('preserves existing version field on import', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestAutomations(wsDir, {
        UserPromptSubmit: [
          { id: 'existing1', actions: [{ type: 'prompt', prompt: 'old' }] },
        ],
      }, 2)

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          automations: [
            makeAutomationEntry({ id: 'new1', event: 'SessionStart' }),
          ],
        },
      }

      await importResources(wsDir, bundle, 'skip', noopDeps)

      const config = JSON.parse(readFileSync(join(wsDir, 'automations.json'), 'utf-8'))
      expect(config.version).toBe(2)
    })

it('selectively clears history and retry queue for overwritten IDs', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestAutomations(wsDir, {
        UserPromptSubmit: [
          { id: 'aaa111', actions: [{ type: 'prompt', prompt: 'old' }] },
          { id: 'bbb222', actions: [{ type: 'prompt', prompt: 'keep' }] },
        ],
      })

      // Write history with entries for both IDs
      const historyLines = [
        JSON.stringify({ automationId: 'aaa111', ts: 1, ok: true }),
        JSON.stringify({ automationId: 'bbb222', ts: 2, ok: true }),
        JSON.stringify({ automationId: 'aaa111', ts: 3, ok: false }),
      ]
      writeFileSync(join(wsDir, 'automations-history.jsonl'), historyLines.join('\n') + '\n')

      // Write retry queue
      const retryLines = [
        JSON.stringify({ matcherId: 'aaa111', id: 'r1', nextRetryAt: Date.now() }),
        JSON.stringify({ matcherId: 'bbb222', id: 'r2', nextRetryAt: Date.now() }),
      ]
      writeFileSync(join(wsDir, 'automations-retry-queue.jsonl'), retryLines.join('\n') + '\n')

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          automations: [
            makeAutomationEntry({ id: 'aaa111', event: 'UserPromptSubmit' }),
          ],
        },
      }

      await importResources(wsDir, bundle, 'overwrite', noopDeps)

      // History for aaa111 should be removed, bbb222 should survive
      const history = readFileSync(join(wsDir, 'automations-history.jsonl'), 'utf-8')
      expect(history).not.toContain('aaa111')
      expect(history).toContain('bbb222')

      // Retry queue for aaa111 should be removed, bbb222 should survive
      const retries = readFileSync(join(wsDir, 'automations-retry-queue.jsonl'), 'utf-8')
      expect(retries).not.toContain('aaa111')
      expect(retries).toContain('bbb222')
    })

it('fails import when existing automations.json is invalid in skip mode', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      writeFileSync(join(wsDir, 'automations.json'), 'not valid json {{{')

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          automations: [
            makeAutomationEntry({ id: 'aaa111', event: 'UserPromptSubmit' }),
          ],
        },
      }

      const result = await importResources(wsDir, bundle, 'skip', noopDeps)

      expect(result.automations.failed).toHaveLength(1)
      expect(result.automations.imported).toHaveLength(0)
    })

it('starts fresh when existing automations.json is invalid in overwrite mode', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      writeFileSync(join(wsDir, 'automations.json'), 'not valid json {{{')

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          automations: [
            makeAutomationEntry({ id: 'aaa111', name: 'Fresh Start', event: 'UserPromptSubmit' }),
          ],
        },
      }

      const result = await importResources(wsDir, bundle, 'overwrite', noopDeps)

      expect(result.automations.imported).toEqual(['Fresh Start'])
      const config = JSON.parse(readFileSync(join(wsDir, 'automations.json'), 'utf-8'))
      expect(config.version).toBe(2)
      expect(config.automations.UserPromptSubmit[0].id).toBe('aaa111')
    })

it('rejects import when merged config has invalid regex', async () => {
      const wsDir = createTestWorkspace(tmpDir)

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          automations: [{
            id: 'aaa111',
            event: 'UserPromptSubmit',
            matcher: {
              id: 'aaa111',
              matcher: '(a+)+$', // ReDoS pattern
              actions: [{ type: 'prompt', prompt: 'test' }],
            },
          }],
        },
      }

      const result = await importResources(wsDir, bundle, 'skip', noopDeps)

      expect(result.automations.failed).toHaveLength(1)
      expect(result.automations.failed[0]!.error).toContain('invalid')
    })

it('rejects invalid bundle with error in result', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      const result = await importResources(wsDir, { version: 99 } as unknown as ResourceBundle, 'skip', noopDeps)

      expect(result.sources.failed).toHaveLength(1)
      expect(result.sources.failed[0]!.error).toContain('Invalid bundle')
    })

it('handles partial failures gracefully', async () => {
      const wsDir = createTestWorkspace(tmpDir)

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [
            {
              slug: 'good-source',
              config: {
                id: 'good_1',
                name: 'Good',
                slug: 'good-source',
                enabled: true,
                provider: 'custom',
                type: 'api',
                api: { baseUrl: 'https://api.example.com', authType: 'none' },
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
              files: [makeBundleFile('guide.md', '# Good')],
            },
          ],
          skills: [
            {
              slug: 'good-skill',
              files: [makeBundleFile('SKILL.md', '---\nname: Good\ndescription: Good\n---\nBody')],
            },
          ],
        },
      }

      const result = await importResources(wsDir, bundle, 'skip', noopDeps)

      expect(result.sources.imported).toEqual(['good-source'])
      expect(result.skills.imported).toEqual(['good-skill'])
    })

it('cleans up temp dirs on failure', async () => {
      const wsDir = createTestWorkspace(tmpDir)

      // Import should complete without leaving temp dirs
      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'test',
            config: { id: 'test_1', name: 'Test', slug: 'test', enabled: true, provider: 'x', type: 'api', api: { baseUrl: 'http://x', authType: 'none' }, createdAt: 1, updatedAt: 1 },
            files: [makeBundleFile('guide.md', '# Test')],
          }],
        },
      }

      await importResources(wsDir, bundle, 'skip', noopDeps)

      // No .tmp-* dirs should remain
      const sourcesDir = join(wsDir, 'sources')
      const entries = readdirSync(sourcesDir)
      const tmpDirs = entries.filter(e => e.startsWith('.tmp-'))
      expect(tmpDirs).toHaveLength(0)
    })
});
});
