import 'katex/dist/katex.min.css'






















/**
 * Names of preview-block code-fence types that recursive `Markdown` callers
 * may want to suppress. Used by `MarkdownDocBlock` to prevent
 * `markdown-preview` self-recursion while leaving other preview blocks
 * (mermaid, datatable, …) intact.
 */
export type DisablablePreviewBlock =
  | 'markdown-preview'
  | 'html-preview'
  | 'pdf-preview'
  | 'image-preview'


/**
 * Render modes for markdown content:
 *
 * - 'terminal': Raw output with minimal formatting, control chars visible
 *   Best for: Debug output, raw logs, when you want to see exactly what's there
 *
 * - 'minimal': Clean rendering with syntax highlighting but no extra chrome
 *   Best for: Chat messages, inline content, when you want readability without clutter
 *
 * - 'full': Rich rendering with beautiful tables, styled code blocks, proper typography
 *   Best for: Documentation, long-form content, when presentation matters
 */
export type RenderMode = 'terminal' | 'minimal' | 'full'


/** Context for collapsible sections */
export interface CollapsibleContext {
  collapsedSections: Set<string>
  toggleSection: (id: string) => void
}


/**
 * Create custom components based on render mode.
 *
 * @param firstMermaidCodeRef - Ref holding the code of the first mermaid block
 *   when the markdown message starts with a mermaid fence. Used to hide the
 *   inline expand button on that block (TurnCard's own fullscreen button
 *   occupies the same top-right position). A ref is used so the closure can
 *   read the latest value without adding content to the memo deps — that would
 *   cause component re-mounting on every streaming update.
 * @param hideFirstMermaidExpand - Whether to hide the expand button on the first
 *   mermaid block when the message starts with a mermaid fence. Defaults to true.
 */
export function stableHash(input: string): string {
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}
