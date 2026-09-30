import { getSourcesBySlugs, type LoadedSource } from '@craft-agent/shared/sources'

/** Resolve only the canonical, selected source folders used by the live tools.
 * Unknown identities disable synthesis reuse; they never authorize another source.
 */
export function loadCollectionCacheSources(root: string, selected?: readonly string[]): LoadedSource[] | undefined {
  if (selected === undefined) return []
  if (!Array.isArray(selected) || selected.some(slug => typeof slug !== 'string' || !/^[a-z0-9-]+$/.test(slug))) return undefined
  const slugs = [...new Set(selected)]
  const sources = getSourcesBySlugs(root, slugs)
  const resolved = new Set(sources.map(source => source.config.slug))
  if (sources.length !== slugs.length || resolved.size !== slugs.length || slugs.some(slug => !resolved.has(slug))) return undefined
  return sources.sort((left, right) => left.config.slug.localeCompare(right.config.slug))
}
