import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { exportResources } from '../resource-bundle';

import type { WebhookAction } from '../../automations/types';
import { createTestWorkspace, createTestSource, createTestSkill, createTestAutomations } from "./testing/resource-bundle-fixture.ts";


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

describe('exportResources', () => {
it('exports sources with sanitized config', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSource(wsDir, 'github', {
        isAuthenticated: true,
        connectionStatus: 'connected',
        connectionError: 'old error',
        lastTestedAt: 12345,
      })

      const { bundle } = exportResources(wsDir, { sources: 'all' })

      expect(bundle.version).toBe(1)
      expect(bundle.resources.sources).toHaveLength(1)

      const source = bundle.resources.sources![0]!
      expect(source.slug).toBe('github')
      // Auth state should be reset
      expect(source.config['isAuthenticated']).toBe(false)
      expect(source.config.connectionStatus).toBe('needs_auth')
      expect(source.config.connectionError).toBeUndefined()
      expect(source.config.lastTestedAt).toBeUndefined()
    })

it('strips known secret fields from source configs', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSource(wsDir, 'google-api', {
        provider: 'google',
        type: 'api',
        api: {
          baseUrl: 'https://gmail.googleapis.com',
          authType: 'oauth',
          googleOAuthClientSecret: 'super-secret',
          defaultHeaders: { 'X-Custom': 'value' },
        },
      })

      const { bundle, warnings } = exportResources(wsDir, { sources: ['google-api'] })

      const config = bundle.resources.sources![0]!.config
      expect(config.api?.googleOAuthClientSecret).toBeUndefined()
      expect(config.api?.defaultHeaders).toBeUndefined()
      expect(warnings.some(w => w.includes('googleOAuthClientSecret'))).toBe(true)
      expect(warnings.some(w => w.includes('defaultHeaders'))).toBe(true)
    })

it('strips mcp.env and mcp.headers from source configs', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSource(wsDir, 'mcp-server', {
        type: 'mcp',
        mcp: {
          url: 'https://mcp.example.com',
          authType: 'bearer',
          env: { SECRET_TOKEN: 'abc123' },
          headers: { 'Authorization': 'Bearer xyz' },
        },
      })

      const { bundle, warnings } = exportResources(wsDir, { sources: ['mcp-server'] })

      const config = bundle.resources.sources![0]!.config
      expect(config.mcp?.env).toBeUndefined()
      expect(config.mcp?.headers).toBeUndefined()
      expect(warnings.some(w => w.includes('mcp.env'))).toBe(true)
      expect(warnings.some(w => w.includes('mcp.headers'))).toBe(true)
    })

it('exports all non-hidden files from source folder', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSource(wsDir, 'postgres')

      // Add extra files
      const sourceDir = join(wsDir, 'sources', 'postgres')
      writeFileSync(join(sourceDir, 'INSTALL.md'), '# Installation')
      mkdirSync(join(sourceDir, 'templates'), { recursive: true })
      writeFileSync(join(sourceDir, 'templates', 'query.sql'), 'SELECT 1')

      const { bundle } = exportResources(wsDir, { sources: ['postgres'] })

      const files = bundle.resources.sources![0]!.files
      const paths = files.map(f => f.relativePath)
      expect(paths).toContain('guide.md')
      expect(paths).toContain('INSTALL.md')
      expect(paths).toContain('templates/query.sql')
      // config.json should NOT be in files (it's in the config field)
      expect(paths).not.toContain('config.json')
    })

it('does not export a source managed by a protected local overlay', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSource(wsDir, 'protected-source')
      writeFileSync(
        join(wsDir, 'sources', 'protected-source', '.robb-source-overlay.json'),
        '{"schemaVersion":1}',
      )

      const { bundle, warnings } = exportResources(wsDir, { sources: ['protected-source'] })

      expect(bundle.resources.sources).toEqual([])
      expect(warnings).toContain(
        "Source 'protected-source' uses a protected local overlay and cannot be exported as a portable resource",
      )
    })

it('never exports source or skill data through a top-level symlink', () => {
      const wsDir = createTestWorkspace(tmpDir)
      const outsideSource = join(tmpDir, 'outside-source')
      const outsideSkill = join(tmpDir, 'outside-skill')
      mkdirSync(outsideSource)
      mkdirSync(outsideSkill)
      writeFileSync(join(outsideSource, 'config.json'), JSON.stringify({
        id: 'linked_1', name: 'linked', slug: 'linked', enabled: true,
        provider: 'custom', type: 'api', api: { baseUrl: 'https://example.com', authType: 'none' },
      }))
      writeFileSync(join(outsideSource, 'private.txt'), 'OUTSIDE PRIVATE DATA')
      writeFileSync(join(outsideSkill, 'SKILL.md'), 'OUTSIDE SKILL DATA')
      symlinkSync(outsideSource, join(wsDir, 'sources', 'linked'), 'dir')
      symlinkSync(outsideSkill, join(wsDir, 'skills', 'linked'), 'dir')

      const { bundle, warnings } = exportResources(wsDir, { sources: ['linked'], skills: ['linked'] })

      expect(bundle.resources.sources).toEqual([])
      expect(bundle.resources.skills).toEqual([])
      expect(warnings.filter(warning => warning.includes('trusted resource boundary'))).toHaveLength(2)
      expect(JSON.stringify(bundle)).not.toContain('OUTSIDE')
    })

it('rejects a symlinked source config before reading external JSON', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSource(wsDir, 'linked-config')
      const externalConfig = join(tmpDir, 'external-config.json')
      writeFileSync(externalConfig, JSON.stringify({
        id: 'external', name: 'external', slug: 'linked-config', enabled: true,
        provider: 'custom', type: 'api', api: { baseUrl: 'https://outside.example', authType: 'none' },
      }))
      rmSync(join(wsDir, 'sources', 'linked-config', 'config.json'))
      symlinkSync(externalConfig, join(wsDir, 'sources', 'linked-config', 'config.json'))

      const { bundle, warnings } = exportResources(wsDir, { sources: ['linked-config'] })

      expect(bundle.resources.sources).toEqual([])
      expect(warnings.some(warning => warning.includes('unsafe config'))).toBe(true)
    })

it('skips export while an overlay transaction holds the shared source lock', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSource(wsDir, 'google-contacts')
      const lockPath = join(wsDir, 'sources', '.robb-source-transaction-google-contacts.lock')
      writeFileSync(lockPath, JSON.stringify({
        schemaVersion: 1,
        slug: 'google-contacts',
        pid: 999999,
        operation: 'overlay-install',
        createdAtUnixMs: Date.now(),
      }) + '\n', { mode: 0o600 })

      const { bundle, warnings } = exportResources(wsDir, { sources: ['google-contacts'] })

      expect(bundle.resources.sources).toEqual([])
      expect(warnings.some(warning => warning.includes('could not be locked for a consistent export'))).toBe(true)
      expect(existsSync(lockPath)).toBe(true)
    })

it('does not strand unrelated sources behind an unrecoverable overlay lock', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSource(wsDir, 'postgres')
      const unrelatedLock = join(wsDir, 'sources', '.robb-source-transaction-postgres.lock')
      writeFileSync(unrelatedLock, '{"legacy":"stale"}\n', { mode: 0o600 })

      const { bundle } = exportResources(wsDir, { sources: ['postgres'] })

      expect(bundle.resources.sources?.map(source => source.slug)).toEqual(['postgres'])
      expect(existsSync(unrelatedLock)).toBe(true)
    })

it('excludes non-hidden credential and private-key files from exports', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSource(wsDir, 'safe-source')
      createTestSkill(wsDir, 'safe-skill', {
        'credentials.json': '{"token":"must-not-export"}',
        'keys/client.pem': 'private-key-material',
        'guide.md': '# Extra guide',
      })
      writeFileSync(join(wsDir, 'sources', 'safe-source', 'oauth-token.yaml'), 'access_token: must-not-export')

      const { bundle, warnings } = exportResources(wsDir, { sources: 'all', skills: 'all' })
      const sourcePaths = bundle.resources.sources![0]!.files.map(file => file.relativePath)
      const skillPaths = bundle.resources.skills![0]!.files.map(file => file.relativePath)

      expect(sourcePaths).not.toContain('oauth-token.yaml')
      expect(skillPaths).not.toContain('credentials.json')
      expect(skillPaths).not.toContain('keys/client.pem')
      expect(skillPaths).toContain('SKILL.md')
      expect(warnings.filter(warning => warning.includes('excluded sensitive file'))).toHaveLength(3)
    })

it('exports skills with all auxiliary files', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSkill(wsDir, 'pdf', {
        'forms.md': '# Forms reference',
        'reference.md': '# PDF Reference',
        'scripts/extract.py': 'import pdf',
        'LICENSE.txt': 'MIT',
      })

      const { bundle } = exportResources(wsDir, { skills: 'all' })

      expect(bundle.resources.skills).toHaveLength(1)
      const skill = bundle.resources.skills![0]!
      const paths = skill.files.map(f => f.relativePath)
      expect(paths).toContain('SKILL.md')
      expect(paths).toContain('forms.md')
      expect(paths).toContain('reference.md')
      expect(paths).toContain('scripts/extract.py')
      expect(paths).toContain('LICENSE.txt')
    })

it('exports automations as per-entry array', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestAutomations(wsDir, {
        UserPromptSubmit: [
          { id: 'aaa111', name: 'Greeting', actions: [{ type: 'prompt', prompt: 'hello' }] },
        ],
        SessionStart: [
          { id: 'bbb222', name: 'Init', actions: [{ type: 'prompt', prompt: 'init' }] },
        ],
      })

      const { bundle } = exportResources(wsDir, { automations: true })

      expect(bundle.resources.automations).toHaveLength(2)
      const ids = bundle.resources.automations!.map(a => a.id)
      expect(ids).toContain('aaa111')
      expect(ids).toContain('bbb222')

      const greeting = bundle.resources.automations!.find(a => a.id === 'aaa111')!
      expect(greeting.name).toBe('Greeting')
      expect(greeting.event).toBe('UserPromptSubmit')
      expect(greeting.matcher.actions).toHaveLength(1)
    })

it('exports automations selectively by ID', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestAutomations(wsDir, {
        UserPromptSubmit: [
          { id: 'aaa111', name: 'First', actions: [{ type: 'prompt', prompt: 'a' }] },
          { id: 'bbb222', name: 'Second', actions: [{ type: 'prompt', prompt: 'b' }] },
        ],
      })

      const { bundle } = exportResources(wsDir, { automations: ['aaa111'] })

      expect(bundle.resources.automations).toHaveLength(1)
      expect(bundle.resources.automations![0]!.id).toBe('aaa111')
    })

it('exports automations selectively by name', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestAutomations(wsDir, {
        UserPromptSubmit: [
          { id: 'aaa111', name: 'My Automation', actions: [{ type: 'prompt', prompt: 'a' }] },
          { id: 'bbb222', name: 'Other', actions: [{ type: 'prompt', prompt: 'b' }] },
        ],
      })

      const { bundle } = exportResources(wsDir, { automations: ['My Automation'] })

      expect(bundle.resources.automations).toHaveLength(1)
      expect(bundle.resources.automations![0]!.id).toBe('aaa111')
    })

it('warns when name selector matches multiple automations', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestAutomations(wsDir, {
        UserPromptSubmit: [
          { id: 'aaa111', name: 'Dup Name', actions: [{ type: 'prompt', prompt: 'a' }] },
          { id: 'bbb222', name: 'Dup Name', actions: [{ type: 'prompt', prompt: 'b' }] },
        ],
      })

      const { bundle, warnings } = exportResources(wsDir, { automations: ['Dup Name'] })

      // Both should be included
      expect(bundle.resources.automations).toHaveLength(2)
      expect(warnings.some(w => w.includes('matched 2 automations'))).toBe(true)
    })

it('warns for unmatched automation selector', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestAutomations(wsDir, {
        UserPromptSubmit: [
          { id: 'aaa111', name: 'Real', actions: [{ type: 'prompt', prompt: 'a' }] },
        ],
      })

      const { warnings } = exportResources(wsDir, { automations: ['nonexistent'] })

      expect(warnings.some(w => w.includes("'nonexistent'") && w.includes('did not match'))).toBe(true)
    })

it('sanitizes webhook auth on export', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestAutomations(wsDir, {
        UserPromptSubmit: [{
          id: 'aaa111',
          name: 'Webhook Test',
          actions: [{
            type: 'webhook',
            url: 'https://api.example.com/hook',
            auth: { type: 'bearer', token: 'secret-token-123' },
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer hardcoded-secret',
            },
          }],
        }],
      })

      const { bundle, warnings } = exportResources(wsDir, { automations: 'all' })

      const action = bundle.resources.automations![0]!.matcher.actions[0] as WebhookAction
      expect(action.auth).toBeUndefined()
      expect(action.headers?.['Authorization']).toBeUndefined()
      // Content-Type should be preserved
      expect(action.headers?.['Content-Type']).toBe('application/json')
      expect(warnings.some(w => w.includes('auth credentials'))).toBe(true)
      expect(warnings.some(w => w.includes("header 'Authorization'"))).toBe(true)
    })

it('preserves templated header values on export', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestAutomations(wsDir, {
        UserPromptSubmit: [{
          id: 'aaa111',
          actions: [{
            type: 'webhook',
            url: 'https://api.example.com/hook',
            headers: { 'Authorization': 'Bearer $CRAFT_WH_TOKEN' },
          }],
        }],
      })

      const { bundle } = exportResources(wsDir, { automations: 'all' })

      const action = bundle.resources.automations![0]!.matcher.actions[0] as WebhookAction
      // Templated Authorization should be preserved
      expect(action.headers?.['Authorization']).toBe('Bearer $CRAFT_WH_TOKEN')
    })

it('automations: true is backward-compatible with "all"', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestAutomations(wsDir, {
        UserPromptSubmit: [
          { id: 'aaa111', actions: [{ type: 'prompt', prompt: 'a' }] },
        ],
      })

      const { bundle } = exportResources(wsDir, { automations: true })

      expect(bundle.resources.automations).toHaveLength(1)
    })

it('warns for non-existent sources', () => {
      const wsDir = createTestWorkspace(tmpDir)
      const { warnings } = exportResources(wsDir, { sources: ['nonexistent'] })

      expect(warnings.some(w => w.includes('nonexistent'))).toBe(true)
    })

it('rejects non-canonical source and skill export selectors before path access', () => {
      const wsDir = createTestWorkspace(tmpDir)
      const sourceExport = exportResources(wsDir, { sources: ['../outside'] })
      const skillExport = exportResources(wsDir, { skills: [String.raw`..\outside`] })

      expect(sourceExport.bundle.resources.sources).toEqual([])
      expect(sourceExport.warnings.some(w => w.includes('not canonical'))).toBe(true)
      expect(skillExport.bundle.resources.skills).toEqual([])
      expect(skillExport.warnings.some(w => w.includes('not canonical'))).toBe(true)
    })

it('skips skills without SKILL.md', () => {
      const wsDir = createTestWorkspace(tmpDir)
      // Create a skill dir with no SKILL.md
      mkdirSync(join(wsDir, 'skills', 'broken'), { recursive: true })
      writeFileSync(join(wsDir, 'skills', 'broken', 'readme.txt'), 'not a skill')

      const { bundle, warnings } = exportResources(wsDir, { skills: 'all' })

      expect(bundle.resources.skills).toHaveLength(0)
      expect(warnings.some(w => w.includes('SKILL.md'))).toBe(true)
    })

it('includes sourceWorkspace from workspace config', () => {
      const wsDir = createTestWorkspace(tmpDir)
      const { bundle } = exportResources(wsDir, { sources: 'all' })

      expect(bundle.sourceWorkspace).toBe('Test Workspace')
    })
});
});
