import { isUnknownArray } from '@craft-agent/shared/utils/json';
import { getSourcesBySlugs, type LoadedSource } from '@craft-agent/shared/sources'

/** Resolve only the canonical, selected source folders used by the live tools.
 * Unknown identities disable synthesis reuse; they never authorize another source.
 */
export function loadCollectionCacheSources(root: string, selected?: readonly string[]): LoadedSource[] | undefined {
  if (selected === undefined) return []
  const values: unknown = selected
  if (!isUnknownArray(values) || !values.every((slug): slug is string => typeof slug === 'string' && /^[a-z0-9-]+$/.test(slug))) return undefined
  const slugs = [...new Set(values)]
  const sources = getSourcesBySlugs(root, slugs)
  const resolved = new Set(sources.map(source => source.config.slug))
  if (sources.length !== slugs.length || resolved.size !== slugs.length || slugs.some(slug => !resolved.has(slug))) return undefined
  return sources.sort((left, right) => left.config.slug.localeCompare(right.config.slug))
}
