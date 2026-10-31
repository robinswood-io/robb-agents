import { isJsonObject, isUnknownArray, omitUndefined } from '@craft-agent/shared/utils/json'

/**
 * Pure helpers for MarkdownDocBlock.
 *
 * Extracted so we can unit-test the JSON-spec → preview-items normalization
 * without spinning up React. Component DOM behavior is covered by manual
 * Electron smoke (see plan).
 */

export interface MarkdownPreviewItem {
  src: string
  label?: string
  ratio?: number | undefined
}

export interface MarkdownPreviewSpec {
  src?: string | undefined
  title?: string | undefined
  items?: MarkdownPreviewItem[] | undefined
}

/**
 * Parse a `markdown-preview` JSON spec string.
 *
 * Returns `null` for invalid JSON or specs that lack both `src` and a non-empty
 * `items` array. Mirrors `MarkdownHtmlBlock`/`MarkdownPdfBlock` so the same
 * spec shape works across preview block types.
 */
export function parseMarkdownPreviewSpec(code: string): MarkdownPreviewSpec | null {
  let raw: unknown
  try {
    raw = JSON.parse(code)
  } catch {
    return null
  }

  if (!isJsonObject(raw)) return null
  const src = raw['src']
  const title = raw['title']
  const itemsField = raw['items']
  if (isUnknownArray(itemsField) && itemsField.length > 0) {
    const items: MarkdownPreviewItem[] = []
    for (const item of itemsField) {
      if (!isJsonObject(item)) continue
      const itemSrc = item['src']
      if (typeof itemSrc !== 'string' || itemSrc.length === 0) continue
      const label = item['label']
      const ratio = item['ratio']
      items.push(omitUndefined<MarkdownPreviewItem>({
        src: itemSrc,
        label: typeof label === 'string' ? label : undefined,
        ratio: typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0 ? ratio : undefined,
      }))
    }
    if (items.length === 0) return null
    return {
      src: typeof src === 'string' ? src : undefined,
      title: typeof title === 'string' ? title : undefined,
      items,
    }
  }
  if (typeof src === 'string' && src.length > 0) {
    return { src, title: typeof title === 'string' ? title : undefined }
  }

  return null
}

/**
 * Normalize a spec to a flat array of items.
 *
 * Single-item specs (only `src`) are wrapped into a one-element array so the
 * rest of the component can iterate uniformly. If both fields are present,
 * `items` wins (matches sibling preview blocks).
 */
export function normalizePreviewItems(spec: MarkdownPreviewSpec | null): MarkdownPreviewItem[] {
  if (!spec) return []
  if (spec.items && spec.items.length > 0) return spec.items
  if (spec.src) return [{ src: spec.src }]
  return []
}
