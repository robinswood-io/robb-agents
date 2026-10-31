import { isUnknownArray } from "../../../../shared/src/utils/json.ts";
/**
 * JSONPreviewOverlay - Interactive JSON tree viewer overlay
 *
 * Uses @uiw/react-json-view for expand/collapse tree navigation.
 * Wraps PreviewOverlay for consistent presentation with other overlays.
 */


import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import JsonView from '@uiw/react-json-view'
import { ContentFrame } from './ContentFrame'

/**
 * Recursively parse stringified JSON within JSON values.
 * Handles nested patterns like {"result": "{\"nested\": \"value\"}"}
 * so they display as expandable tree nodes instead of plain strings.
 */
function deepParseJson(value: unknown): unknown {
  // Handle null/undefined
  if (value === null || value === undefined) return value

  // If it's a string, try to parse it as JSON
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        // Recursively parse the result in case of multiple nesting levels
        return deepParseJson(JSON.parse(trimmed))
      } catch {
        // Not valid JSON, return original string
        return value
      }
    }
    return value
  }

  // If it's an array, recursively process each element
  if (isUnknownArray(value)) {
    return value.map(deepParseJson)
  }

  // If it's an object, recursively process each property
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = deepParseJson(val)
    }
    return result
  }

  // Primitives (number, boolean) - return as-is
  return value
}
import { vscodeTheme } from '@uiw/react-json-view/vscode'
import { githubLightTheme } from '@uiw/react-json-view/githubLight'
import { Braces } from 'lucide-react'
import { PreviewOverlay } from './PreviewOverlay'

export interface JSONPreviewOverlayProps {
  /** Whether the overlay is visible */
  isOpen: boolean
  /** Callback when the overlay should close */
  onClose: () => void
  /** Parsed JSON data to display */
  data: unknown
  /** File path — shows dual-trigger menu badge with "Open" + "Reveal in {file manager}" */
  filePath?: string | undefined
  /** Title to display in header (fallback when no filePath) */
  title?: string | undefined
  /** Theme mode */
  theme?: 'light' | 'dark' | undefined
  /** Optional error message */
  error?: string | undefined
  /** Render inline without dialog (for playground) */
  embedded?: boolean | undefined
}

/**
 * Custom theme that adapts to our app's CSS variables.
 * Falls back to VS Code dark theme colors for JSON-specific styling.
 */
const craftAgentDarkTheme = {
  ...vscodeTheme,
  '--w-rjv-font-family': 'var(--font-mono, ui-monospace, monospace)',
  '--w-rjv-background-color': 'transparent',
}

const craftAgentLightTheme = {
  ...githubLightTheme,
  '--w-rjv-font-family': 'var(--font-mono, ui-monospace, monospace)',
  '--w-rjv-background-color': 'transparent',
}

export function JSONPreviewOverlay({
  isOpen,
  onClose,
  data,
  filePath,
  title = 'JSON',
  theme = 'dark',
  error,
  embedded,
}: JSONPreviewOverlayProps) {
  const { t } = useTranslation()
  // Select theme based on mode
  const jsonTheme = useMemo(() => {
    return theme === 'dark' ? craftAgentDarkTheme : craftAgentLightTheme
  }, [theme])

  // Recursively parse any stringified JSON within the data for better display.
  // Guard: @uiw/react-json-view crashes on null/undefined/primitive values — wrap them
  // in an object so the viewer can render them safely.
  const processedData = useMemo(() => {
    const parsed = deepParseJson(data)
    if (parsed === null || parsed === undefined) return { '(empty)': null }
    if (typeof parsed !== 'object') return { '(root)': parsed }
    return parsed as object
  }, [data])

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      typeBadge={{
        icon: Braces,
        label: 'JSON',
        variant: 'blue',
      }}
      filePath={filePath}
      title={title}
      theme={theme}
      error={error ? { label: t('preview.parseError'), message: error } : undefined}
      embedded={embedded}
      className="bg-foreground-3"
    >
      <ContentFrame title="JSON">
        <div className="flex-1 overflow-y-auto min-h-0 p-4">
          <div className="p-4">
            <JsonView
              value={processedData}
              style={jsonTheme}
              collapsed={false}
              enableClipboard={true}
              displayDataTypes={false}
              shortenTextAfterLength={100} />
          </div>
        </div>
      </ContentFrame>
    </PreviewOverlay>
  )
}
