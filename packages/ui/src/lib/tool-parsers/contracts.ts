import type { ToolType } from "../../components/terminal/TerminalOutput";

// ============================================================================
// Overlay Data Types
// ============================================================================

export interface CodeOverlayData {
  type: 'code'
  filePath: string
  content: string
  mode: 'read' | 'write'
  startLine?: number | undefined
  totalLines?: number | undefined
  numLines?: number | undefined
  error?: string | undefined
  /** Original shell command (for Codex reads) - displayed in overlay */
  command?: string | undefined
}

export interface TerminalOverlayData {
  type: 'terminal'
  command: string
  output: string
  exitCode?: number | undefined
  toolType: ToolType
  description: string
  error?: string | undefined
}

export interface GenericOverlayData {
  type: 'generic'
  content: string
  title: string
  error?: string | undefined
}

export interface JSONOverlayData {
  type: 'json'
  data: unknown
  rawContent: string
  title: string
  error?: string | undefined
}

/** Rendered markdown document — used for Write tool results on .md/.txt files */
export interface DocumentOverlayData {
  type: 'document'
  content: string
  filePath: string
  /** Tool that produced this content (e.g. "Write") — used for the header type badge */
  toolName: string
  error?: string | undefined
}

export type OverlayData = CodeOverlayData | TerminalOverlayData | GenericOverlayData | JSONOverlayData | DocumentOverlayData

/** Generic overlay card model (tab item) for activity details. */
export interface OverlayCard {
  /** Stable card identifier (e.g. input, output, metadata) */
  id: string
  /** Display label shown in card navigator */
  label: string
  /** Card payload rendered by overlay */
  data: OverlayData
  /** Optional CLI-style command preview (shown on Input cards) */
  commandPreview?: string
}
