import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseTaskYaml } from './storage'

const fixturePath = join(
  import.meta.dir,
  '../../../../examples/missions/operational-financial-reconciliation/task.yaml',
)

describe('operational and financial reconciliation reference vertical', () => {
  test('is a valid governed mission graph with no unresolved graph warning', () => {
    const result = parseTaskYaml(readFileSync(fixturePath, 'utf8'))
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.spec?.nodes.filter((node) => node.effect === 'external-mutation')).toHaveLength(2)
    expect(result.spec?.nodes.some((node) => node.kind === 'approval')).toBe(true)
  })

  test('keeps the provider swap in one enum parameter rather than the mission graph', () => {
    const result = parseTaskYaml(readFileSync(fixturePath, 'utf8'))
    if (!result.spec) throw new Error('Reference vertical did not parse')
    const packParameter = result.spec.params?.find((parameter) => parameter.name === 'productivity_pack')
    expect(packParameter?.enum).toEqual(['googleWorkspace', 'microsoft365'])
    const prompts = result.spec.nodes.map((node) => node.prompt ?? '').join('\n')
    expect(prompts).not.toContain('Google Workspace')
    expect(prompts).not.toContain('Microsoft 365')
    expect(prompts).toContain('${params.productivity_pack}')
  })
})
