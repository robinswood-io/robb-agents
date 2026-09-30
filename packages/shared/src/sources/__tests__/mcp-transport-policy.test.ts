import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { validateSourceConfigContent } from '../../config/validators.ts'
import { getSourcePath, loadSourceConfig, saveSourceConfig } from '../storage.ts'
import type { FolderSourceConfig } from '../types.ts'

const roots: string[] = []

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'robb-mcp-transport-'))
  roots.push(root)
  return root
}

function config(
  transport: 'http' | 'sse' | 'stdio',
  overrides: Partial<FolderSourceConfig> = {},
): FolderSourceConfig {
  return {
    id: 'source-1',
    name: 'Source One',
    slug: 'source-one',
    enabled: true,
    provider: 'custom',
    type: 'mcp',
    mcp: transport === 'stdio'
      ? { transport, command: 'mcp-server' }
      : { transport, url: 'https://example.test/mcp', authType: 'none' },
    ...overrides,
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('legacy MCP SSE transport policy', () => {
  it('blocks creation through storage and pre-write content validation', () => {
    const root = workspace()
    const legacy = config('sse')

    expect(() => saveSourceConfig(root, legacy)).toThrow('Legacy MCP SSE transport')
    const validation = validateSourceConfigContent(JSON.stringify(legacy), {
      enforceMcpTransportWrite: true,
    })
    expect(validation.valid).toBe(false)
    expect(validation.errors[0]?.path).toBe('mcp.transport')
  })

  it('keeps persisted SSE readable and permits bookkeeping-only saves', () => {
    const root = workspace()
    const legacy = config('sse')
    const sourceDir = getSourcePath(root, legacy.slug)
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'config.json'), JSON.stringify(legacy, null, 2))

    const loaded = loadSourceConfig(root, legacy.slug)
    expect(loaded?.mcp?.transport).toBe('sse')
    expect(() => saveSourceConfig(root, {
      ...legacy,
      isAuthenticated: true,
      connectionStatus: 'connected',
    })).not.toThrow()

    const preWrite = validateSourceConfigContent(JSON.stringify({
      ...legacy,
      connectionStatus: 'connected',
    }), {
      enforceMcpTransportWrite: true,
      previousJsonString: JSON.stringify(legacy),
    })
    expect(preWrite.valid).toBe(true)
    expect(preWrite.warnings.some((warning) => warning.path === 'mcp.transport')).toBe(true)
  })

  it('rejects reconfiguration in SSE but permits migration to Streamable HTTP', () => {
    const root = workspace()
    const legacy = config('sse')
    const sourceDir = getSourcePath(root, legacy.slug)
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'config.json'), JSON.stringify(legacy, null, 2))

    expect(() => saveSourceConfig(root, {
      ...legacy,
      mcp: { ...legacy.mcp, url: 'https://other.example.test/sse' },
    })).toThrow('Legacy MCP SSE transport')

    expect(() => saveSourceConfig(root, config('http'))).not.toThrow()
    expect(loadSourceConfig(root, legacy.slug)?.mcp?.transport).toBe('http')
  })
})
