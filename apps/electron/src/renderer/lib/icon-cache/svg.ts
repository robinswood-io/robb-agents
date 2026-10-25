import { readWorkspaceImage } from './cache.ts';

// ============================================================================
// SVG Theming
// ============================================================================

/**
 * Get the current foreground color from CSS custom properties.
 * Returns the computed value of --foreground or a fallback.
 */
export function getForegroundColor(): string {
  if (typeof document === 'undefined') {
    // SSR/Node fallback - dark theme default
    return '#e3e2e5'
  }

  const computedColor = getComputedStyle(document.documentElement)
    .getPropertyValue('--foreground')
    .trim()

  // If we got an oklch value, return it as-is (browsers handle it)
  // If empty, return a sensible default
  return computedColor || '#e3e2e5'
}

/**
 * Process SVG content to inject theme foreground color.
 *
 * This fixes SVGs that use currentColor or have no fill specified,
 * which would otherwise render as black when used as background-image
 * (since CSS color inheritance doesn't work for background images).
 *
 * @param svgContent - Raw SVG string content
 * @param foregroundColor - Color to inject (defaults to current theme foreground)
 * @returns Processed SVG string with colors injected
 */
export function themeSvgContent(
  svgContent: string,
  foregroundColor?: string
): string {
  const color = foregroundColor ?? getForegroundColor()

  let processed = svgContent

  // Replace all currentColor references with the actual color
  processed = processed.replace(/currentColor/gi, color)

  // For SVGs with no fill attribute on the root element, add one
  // This catches SVGs that rely on default black fill
  processed = processed.replace(
    /<svg([^>]*)>/i,
    (match, attrs) => {
      // Don't add fill if already has fill attribute (even fill="none")
      if (/\bfill\s*=/i.test(attrs)) {
        return match
      }
      // Add fill attribute to SVG root
      return `<svg${attrs} fill="${color}">`
    }
  )

  return processed
}

/**
 * Convert SVG content to a themed data URL.
 * Injects foreground color and encodes as base64.
 */
export function svgToThemedDataUrl(svgContent: string, foregroundColor?: string): string {
  const themedSvg = themeSvgContent(svgContent, foregroundColor)
  return `data:image/svg+xml;base64,${btoa(themedSvg)}`
}

/**
 * Load a single icon file by relative path.
 * Handles SVG theming, colorability detection, and sanitization.
 *
 * For colorable SVGs (those using currentColor), returns rawSvg for inline rendering
 * so CSS color classes can cascade into SVG fills/strokes.
 */
export async function loadIconFile(
  workspaceId: string,
  relativePath: string
): Promise<{ dataUrl: string; colorable: boolean; rawSvg?: string } | null> {
  try {
    const content = await readWorkspaceImage(workspaceId, relativePath)
    // IPC returns null for missing files (silent fallback)
    if (!content) {
      return null
    }

    if (relativePath.endsWith('.svg')) {
      // Detect if SVG uses currentColor (colorable)
      const colorable = content.includes('currentColor')
      // Theme SVG: inject foreground color for data URL usage
      const dataUrl = svgToThemedDataUrl(content)

      if (colorable) {
        // Sanitize SVG for inline rendering (XSS prevention)
        const rawSvg = sanitizeSvgForInline(content)
        return { dataUrl, colorable, rawSvg }
      }

      return { dataUrl, colorable }
    }

    // Raster image (PNG, JPG) - not colorable
    return { dataUrl: content, colorable: false }
  } catch {
    // File doesn't exist or failed to load
    return null
  }
}

/**
 * Sanitize SVG content for safe inline rendering via dangerouslySetInnerHTML.
 * Removes script tags, event handlers, and JavaScript URLs.
 * Also strips width/height attributes so SVG fills its container.
 */
export function sanitizeSvgForInline(svg: string): string {
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml')
  if (document.querySelector('parsererror') || document.documentElement.localName !== 'svg') {
    return ''
  }

  const forbiddenElements = [
    'script',
    'foreignObject',
    'iframe',
    'object',
    'embed',
    'link',
    'style',
    'animate',
    'animateMotion',
    'animateTransform',
    'set',
  ]
  for (const selector of forbiddenElements) {
    document.querySelectorAll(selector).forEach(element => element.remove())
  }

  document.querySelectorAll('*').forEach(element => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on') || name === 'style') {
        element.removeAttribute(attribute.name)
        continue
      }
      if (name === 'href' || name === 'xlink:href') {
        const value = attribute.value.trim()
        if (!value.startsWith('#')) element.removeAttribute(attribute.name)
      }
    }
  })

  document.documentElement.removeAttribute('width')
  document.documentElement.removeAttribute('height')
  return new XMLSerializer().serializeToString(document.documentElement)
}
