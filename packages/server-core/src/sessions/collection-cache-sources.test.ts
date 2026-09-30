import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as sources from '@craft-agent/shared/sources'
import { loadCollectionCacheSources } from './collection-cache-sources'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'collection-cache-sources-')); roots.push(root)
  const add = (slug: string, configSlug = slug) => {
    const dir = join(root, 'sources', slug); mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ id: slug, name: slug, slug: configSlug, enabled: true, provider: 'fixture', type: 'local', local: { path: root } }))
    writeFileSync(join(dir, 'guide.md'), `# ${slug}\nUnselected guide content stays outside the cache boundary.`)
  }
  return { root, add }
}

describe('collection synthesis source boundary', () => {
  it('preserves selected configurations and ordering while deduplicating only identical slugs', () => {
    const f = fixture(); for (const slug of ['zeta', 'alpha', 'unused']) f.add(slug)
    const selected = ['zeta', 'alpha', 'zeta']
    const expected = sources.loadAllSources(f.root).filter(source => selected.includes(source.config.slug)).sort((a,b) => a.config.slug.localeCompare(b.config.slug))
    expect(loadCollectionCacheSources(f.root, selected)).toEqual(expected)
    expect(selected).toEqual(['zeta', 'alpha', 'zeta'])
  })
  it('loads the selected canonical sources once without enumerating the workspace', () => {
    const f = fixture(); f.add('selected'); f.add('unrelated')
    const load = sources.getSourcesBySlugs
    const calls: string[][] = []
    const targeted = spyOn(sources, 'getSourcesBySlugs').mockImplementation((root, slugs) => { calls.push([...slugs]); return load(root, slugs) })
    const inventory = spyOn(sources, 'loadAllSources').mockImplementation(() => { throw new Error('Full inventory must not be read') })
    try {
      expect(loadCollectionCacheSources(f.root, ['selected', 'selected'])?.map(source => source.config.slug)).toEqual(['selected'])
      expect(calls).toEqual([['selected']])
    } finally { targeted.mockRestore(); inventory.mockRestore() }
  })
  it.each([['../outside'], ['/absolute'], ['bad/source'], ['UPPER'], [''], [null], 'selected'].map(selected => ({ selected })))(
    'does not resolve malformed identities %j', ({ selected }) => {
      const load = spyOn(sources, 'getSourcesBySlugs').mockImplementation(() => { throw new Error('No lookup allowed') })
      try { expect(loadCollectionCacheSources('/unused', selected as never)).toBeUndefined(); expect(load).not.toHaveBeenCalled() }
      finally { load.mockRestore() }
    },
  )
  it('disables reuse for unavailable, corrupt or mismatched selected configuration', () => {
    const f = fixture(); f.add('wrong-folder', 'other-identity'); f.add('broken')
    writeFileSync(join(f.root, 'sources', 'broken', 'config.json'), '{')
    for (const slug of ['missing', 'wrong-folder', 'broken']) expect(loadCollectionCacheSources(f.root, [slug])).toBeUndefined()
  })
  it('does not invent an obsolete builtin source or require a folder for empty selection', () => {
    const f = fixture()
    expect(loadCollectionCacheSources(f.root)).toEqual([])
    expect(loadCollectionCacheSources(f.root, [])).toEqual([])
    expect(sources.getBuiltinSources('fixture', f.root)).toEqual([])
    expect(loadCollectionCacheSources(f.root, ['craft-agents-docs'])).toBeUndefined()
  })
  it('preserves a builtin returned by the canonical resolver and rejects ambiguous results', () => {
    const f = fixture(), builtin = sources.getDocsSource('fixture', f.root)
    const load = spyOn(sources, 'getSourcesBySlugs').mockReturnValue([builtin])
    try {
      expect(loadCollectionCacheSources(f.root, ['craft-agents-docs'])).toEqual([builtin])
      load.mockReturnValue([builtin, builtin]); expect(loadCollectionCacheSources(f.root, ['craft-agents-docs'])).toBeUndefined()
    } finally { load.mockRestore() }
  })
})
