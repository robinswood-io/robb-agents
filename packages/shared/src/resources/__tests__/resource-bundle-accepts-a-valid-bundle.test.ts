import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { importResources, validateResourceBundle } from '../resource-bundle';

import type { ResourceBundle } from '../types';
import { createTestWorkspace, makeBundleFile, noopDeps } from "./testing/resource-bundle-fixture.ts";


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

describe('validateResourceBundle', () => {
it('accepts a valid bundle', () => {
      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'test',
            config: { id: 'test_1', name: 'Test', slug: 'test', enabled: true, provider: 'custom', type: 'api' },
            files: [makeBundleFile('guide.md', '# Test')],
          }],
          skills: [{
            slug: 'my-skill',
            files: [makeBundleFile('SKILL.md', '---\nname: test\ndescription: test\n---\nBody')],
          }],
        },
      }

      const { valid, errors } = validateResourceBundle(bundle)
      expect(valid).toBe(true)
      expect(errors).toHaveLength(0)
    })

it('rejects non-object', () => {
      const { valid } = validateResourceBundle('not an object')
      expect(valid).toBe(false)
    })

it('rejects wrong version', () => {
      const { valid, errors } = validateResourceBundle({ version: 2, exportedAt: 1, resources: {} })
      expect(valid).toBe(false)
      expect(errors.some(e => e.includes('version'))).toBe(true)
    })

it('rejects sensitive files before import', () => {
      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          skills: [{ slug: 'unsafe-skill', files: [
            makeBundleFile('SKILL.md', '# Safe-looking skill'),
            makeBundleFile('credentials.json', '{"token":"must-not-import"}'),
          ] }],
        },
      }

      const { valid, errors } = validateResourceBundle(bundle)
      expect(valid).toBe(false)
      expect(errors.some(error => error.includes("sensitive file 'credentials.json'"))).toBe(true)
    })

it('rejects duplicate source slugs', () => {
      const bundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [
            { slug: 'dup', config: { id: '1', name: 'A', slug: 'dup', enabled: true, provider: 'x', type: 'api' }, files: [] },
            { slug: 'dup', config: { id: '2', name: 'B', slug: 'dup', enabled: true, provider: 'x', type: 'api' }, files: [] },
          ],
        },
      }

      const { valid, errors } = validateResourceBundle(bundle)
      expect(valid).toBe(false)
      expect(errors.some(e => e.includes('duplicate slug'))).toBe(true)
    })

it('rejects duplicate skill slugs', () => {
      const bundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          skills: [
            { slug: 'dup', files: [makeBundleFile('SKILL.md', 'x')] },
            { slug: 'dup', files: [makeBundleFile('SKILL.md', 'y')] },
          ],
        },
      }

      const { valid, errors } = validateResourceBundle(bundle)
      expect(valid).toBe(false)
      expect(errors.some(e => e.includes('duplicate slug'))).toBe(true)
    })

it('rejects skills without SKILL.md', () => {
      const bundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          skills: [
            { slug: 'no-skill-md', files: [makeBundleFile('readme.md', 'hi')] },
          ],
        },
      }

      const { valid, errors } = validateResourceBundle(bundle)
      expect(valid).toBe(false)
      expect(errors.some(e => e.includes('missing SKILL.md'))).toBe(true)
    })

it('rejects path traversal in files', () => {
      const bundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'evil',
            config: { id: '1', name: 'Evil', slug: 'evil', enabled: true, provider: 'x', type: 'api' },
            files: [makeBundleFile('../escape.txt', 'pwned')],
          }],
        },
      }

      const { valid, errors } = validateResourceBundle(bundle)
      expect(valid).toBe(false)
      expect(errors.some(e => e.includes('traversal'))).toBe(true)
    })

it('rejects source with mismatched config.slug', () => {
      const bundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'github',
            config: { id: '1', name: 'Evil', slug: 'evil-proxy', enabled: true, provider: 'x', type: 'api' },
            files: [],
          }],
        },
      }

      const { valid, errors } = validateResourceBundle(bundle)
      expect(valid).toBe(false)
      expect(errors.some(e => e.includes('does not match'))).toBe(true)
    })

it('rejects traversing source and skill slugs before filesystem I/O', () => {
      const invalidSlugs = ['../victim', 'x/../../outside', String.raw`x\..\victim`, '..']
      for (const slug of invalidSlugs) {
        const sourceBundle = {
          version: 1,
          exportedAt: Date.now(),
          resources: {
            sources: [{
              slug,
              config: { id: '1', name: 'Unsafe', slug, enabled: true, provider: 'x', type: 'api' },
              files: [],
            }],
          },
        }
        const skillBundle = {
          version: 1,
          exportedAt: Date.now(),
          resources: {
            skills: [{ slug, files: [makeBundleFile('SKILL.md', '# Unsafe')] }],
          },
        }

        expect(validateResourceBundle(sourceBundle).valid).toBe(false)
        expect(validateResourceBundle(skillBundle).valid).toBe(false)
      }
    })

it('accepts canonical bounded source and skill slugs', () => {
      const slug = `a${'b'.repeat(62)}-`
      const bundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug,
            config: { id: '1', name: 'Safe', slug, enabled: true, provider: 'x', type: 'api' },
            files: [],
          }],
          skills: [{ slug, files: [makeBundleFile('SKILL.md', '# Safe')] }],
        },
      }

      expect(validateResourceBundle(bundle).valid).toBe(true)
    })

it('accepts valid automation entries', () => {
      const bundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          automations: [
            { id: 'aaa111', event: 'UserPromptSubmit', matcher: { id: 'aaa111', actions: [{ type: 'prompt', prompt: 'hi' }] } },
          ],
        },
      }

      const { valid } = validateResourceBundle(bundle)
      expect(valid).toBe(true)
    })

it('rejects duplicate automation IDs', () => {
      const bundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          automations: [
            { id: 'aaa111', event: 'UserPromptSubmit', matcher: { id: 'aaa111', actions: [{ type: 'prompt', prompt: 'a' }] } },
            { id: 'aaa111', event: 'SessionStart', matcher: { id: 'aaa111', actions: [{ type: 'prompt', prompt: 'b' }] } },
          ],
        },
      }

      const { valid, errors } = validateResourceBundle(bundle)
      expect(valid).toBe(false)
      expect(errors.some(e => e.includes('duplicate id'))).toBe(true)
    })

it('allows duplicate automation names', () => {
      const bundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          automations: [
            { id: 'aaa111', name: 'Same Name', event: 'UserPromptSubmit', matcher: { id: 'aaa111', actions: [{ type: 'prompt', prompt: 'a' }] } },
            { id: 'bbb222', name: 'Same Name', event: 'SessionStart', matcher: { id: 'bbb222', actions: [{ type: 'prompt', prompt: 'b' }] } },
          ],
        },
      }

      const { valid } = validateResourceBundle(bundle)
      expect(valid).toBe(true)
    })

it('rejects automation with unknown event', () => {
      const bundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          automations: [
            { id: 'aaa111', event: 'FakeEvent', matcher: { id: 'aaa111', actions: [{ type: 'prompt', prompt: 'a' }] } },
          ],
        },
      }

      const { valid, errors } = validateResourceBundle(bundle)
      expect(valid).toBe(false)
      expect(errors.some(e => e.includes('unknown event'))).toBe(true)
    })

it('rejects automation without actions', () => {
      const bundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          automations: [
            { id: 'aaa111', event: 'UserPromptSubmit', matcher: { id: 'aaa111', actions: [] } },
          ],
        },
      }

      const { valid, errors } = validateResourceBundle(bundle)
      expect(valid).toBe(false)
      expect(errors.some(e => e.includes('at least one action'))).toBe(true)
    })

it('rejects duplicate file paths', () => {
      const bundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'test',
            config: { id: '1', name: 'Test', slug: 'test', enabled: true, provider: 'x', type: 'api' },
            files: [
              makeBundleFile('guide.md', 'first'),
              makeBundleFile('guide.md', 'second'),
            ],
          }],
        },
      }

      const { valid, errors } = validateResourceBundle(bundle)
      expect(valid).toBe(false)
      expect(errors.some(e => e.includes('duplicate path'))).toBe(true)
    })

it('rejects source files that shadow the reserved staged config', () => {
      for (const relativePath of ['config.json', './config.json']) {
        const bundle: ResourceBundle = {
          version: 1,
          exportedAt: Date.now(),
          resources: {
            sources: [{
              slug: 'shadow',
              config: {
                id: 'shadow_1', name: 'shadow', slug: 'shadow', enabled: true,
                provider: 'custom', type: 'api', api: { baseUrl: 'https://safe.example', authType: 'none' },
              },
              files: [makeBundleFile(relativePath, JSON.stringify({
                slug: 'shadow', type: 'mcp', mcp: { transport: 'stdio', command: '/bin/sh' },
              }))],
            }],
          },
        }
        const validation = validateResourceBundle(bundle)
        expect({ relativePath, validation }).toMatchObject({ relativePath, validation: { valid: false } })
      }
    })
});

describe('importResources', () => {
it('imports sources into workspace', async () => {
      const wsDir = createTestWorkspace(tmpDir)

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'imported-api',
            config: {
              id: 'imported-api_abc',
              name: 'Imported API',
              slug: 'imported-api',
              enabled: true,
              provider: 'custom',
              type: 'api',
              api: { baseUrl: 'https://api.example.com', authType: 'none' },
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
            files: [makeBundleFile('guide.md', '# Imported\n\nGuide content.')],
          }],
        },
      }

      const result = await importResources(wsDir, bundle, 'skip', noopDeps)

      expect(result.sources.imported).toEqual(['imported-api'])
      expect(existsSync(join(wsDir, 'sources', 'imported-api', 'config.json'))).toBe(true)
      expect(existsSync(join(wsDir, 'sources', 'imported-api', 'guide.md'))).toBe(true)
      expect(readFileSync(join(wsDir, 'sources', 'imported-api', 'guide.md'), 'utf-8')).toBe('# Imported\n\nGuide content.')
    })

it('refuses imports when sources or skills escape through collection symlinks', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      const outside = join(tmpDir, 'outside-collection')
      mkdirSync(outside)
      rmSync(join(wsDir, 'sources'), { recursive: true })
      rmSync(join(wsDir, 'skills'), { recursive: true })
      symlinkSync(outside, join(wsDir, 'sources'), 'dir')
      symlinkSync(outside, join(wsDir, 'skills'), 'dir')
      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'escaped',
            config: {
              id: 'escaped_1', name: 'escaped', slug: 'escaped', enabled: true,
              provider: 'custom', type: 'api', api: { baseUrl: 'https://safe.example', authType: 'none' },
            },
            files: [makeBundleFile('guide.md', '# safe')],
          }],
          skills: [{ slug: 'escaped-skill', files: [makeBundleFile('SKILL.md', '# safe')] }],
        },
      }

      const result = await importResources(wsDir, bundle, 'overwrite', noopDeps)

      expect(result.sources.failed[0]?.error).toContain('workspace boundary is unsafe')
      expect(result.skills.failed[0]?.error).toContain('workspace boundary is unsafe')
      expect(readdirSync(outside)).toEqual([])
    })

it('rejects new legacy SSE sources from resource bundles', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'legacy-sse',
            config: {
              id: 'legacy-sse_abc',
              name: 'Legacy SSE',
              slug: 'legacy-sse',
              enabled: true,
              provider: 'custom',
              type: 'mcp',
              mcp: {
                transport: 'sse',
                url: 'https://legacy.example.com/sse',
                authType: 'none',
              },
            },
            files: [],
          }],
        },
      }

      const result = await importResources(wsDir, bundle, 'skip', noopDeps)

      expect(result.sources.imported).toEqual([])
      expect(result.sources.failed[0]?.error).toContain('Legacy MCP SSE transport')
      expect(existsSync(join(wsDir, 'sources', 'legacy-sse'))).toBe(false)
    })
});
});
