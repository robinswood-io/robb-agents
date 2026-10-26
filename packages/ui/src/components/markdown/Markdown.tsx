import * as React from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css'
import { cn } from '../../lib/utils';
import "./CodeBlock";
import "./MarkdownDiffBlock";
import "./MarkdownJsonBlock";
import "./MarkdownMermaidBlock";
import "./MarkdownDatatableBlock";
import "./MarkdownSpreadsheetBlock";
import "./MarkdownHtmlBlock";
import "./MarkdownImageBlock";
import "./MarkdownLatexBlock";
import "./MarkdownPdfBlock";
import "./MarkdownDocBlock";
import { preprocessLinks } from './linkify';
import "./link-target";
import remarkCollapsibleSections from './remarkCollapsibleSections';
import "./CollapsibleSection";
import { useCollapsibleMarkdown } from './CollapsibleMarkdownContext';
import { wrapWithSafeProxy } from './safe-components';
import { MARKDOWN_MATH_OPTIONS } from './math-options';
import { markdownUrlTransform } from './url-transform';
export { CodeBlock, InlineCode } from './CodeBlock'
export { CollapsibleMarkdownProvider } from './CollapsibleMarkdownContext'

import { createComponents } from "./markdown-renderers";
import { type DisablablePreviewBlock, type RenderMode } from "./markdown-context";
export { type DisablablePreviewBlock, type RenderMode } from "./markdown-context";




























export interface MarkdownProps {
  children: string
  /**
   * Render mode controlling formatting level
   * @default 'minimal'
   */
  mode?: RenderMode
  className?: string
  /**
   * Message ID for memoization (optional)
   * When provided, memoizes parsed blocks to avoid re-parsing during streaming
   */
  id?: string
  /**
   * Callback when a URL is clicked
   */
  onUrlClick?: (url: string) => void
  /**
   * Callback when a file path is clicked
   */
  onFileClick?: (path: string) => void
  /**
   * Enable collapsible headings
   * Requires wrapping in CollapsibleMarkdownProvider
   * @default false
   */
  collapsible?: boolean
  /**
   * Hide expand button on first mermaid block (when message starts with mermaid)
   * Used in chat to avoid overlap with TurnCard's fullscreen button
   * @default true
   */
  hideFirstMermaidExpand?: boolean
  /**
   * Disable specific preview-block handlers for nested rendering.
   *
   * When a preview-block component renders user-supplied markdown through
   * `Markdown` again (e.g. `MarkdownDocBlock`), it can pass the names of the
   * preview-block types it wants to suppress to prevent infinite recursion.
   * Suppressed blocks fall through to the default `CodeBlock` renderer.
   *
   * Default behavior (prop omitted): all preview blocks are registered.
   */
  disablePreviewBlocks?: ReadonlySet<DisablablePreviewBlock>
}

/**
 * Markdown - Customizable markdown renderer with multiple render modes
 *
 * Features:
 * - Three render modes: terminal, minimal, full
 * - Syntax highlighting via Shiki
 * - GFM support (tables, task lists, strikethrough)
 * - Clickable links and file paths
 * - Memoization for streaming performance
 */
export function Markdown({
  children,
  mode = 'minimal',
  className,
  id,
  onUrlClick,
  onFileClick,
  collapsible = false,
  hideFirstMermaidExpand = true,
  disablePreviewBlocks,
}: MarkdownProps) {
  // Get collapsible context if enabled
  const collapsibleContext = useCollapsibleMarkdown()

  // Extract the first mermaid code block's content when the message starts
  // with a mermaid fence. Stored in a ref so createComponents can read it
  // without adding `children` to the memo deps (which would remount all
  // components on every streaming update, breaking internal state).
  const firstMermaidCodeRef = React.useRef<string | null>(null)
  const trimmed = children.trimStart()
  if (trimmed.startsWith('```mermaid')) {
    const m = trimmed.match(/^```mermaid\n([\s\S]*?)```/)
    firstMermaidCodeRef.current = m?.[1] ? m[1].replace(/\n$/, '') : null
  } else {
    firstMermaidCodeRef.current = null
  }

  const components = React.useMemo(
    () => wrapWithSafeProxy(createComponents(mode, onUrlClick, onFileClick, collapsible ? collapsibleContext : null, firstMermaidCodeRef, hideFirstMermaidExpand, disablePreviewBlocks)),
    [mode, onUrlClick, onFileClick, collapsible, collapsibleContext, hideFirstMermaidExpand, disablePreviewBlocks]
  )

  // Preprocess to convert raw URLs and file paths to markdown links
  const processedContent = React.useMemo(
    () => preprocessLinks(children),
    [children]
  )

  // Conditionally include the collapsible sections plugin.
  // IMPORTANT: Disable single-dollar inline math so currency like $2M–$4M
  // stays plain text. Math should use $$...$$ delimiters.
  const remarkPlugins = React.useMemo(
    () => {
      const mathPlugin: [typeof remarkMath, typeof MARKDOWN_MATH_OPTIONS] = [
        remarkMath,
        MARKDOWN_MATH_OPTIONS
      ]
      return collapsible
        ? [remarkGfm, mathPlugin, remarkCollapsibleSections]
        : [remarkGfm, mathPlugin]
    },
    [collapsible]
  )

  return (
    <div className={cn('markdown-content', className)}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={[rehypeKatex, rehypeRaw]}
        components={components}
        urlTransform={markdownUrlTransform}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  )
}

/**
 * MemoizedMarkdown - Optimized for streaming scenarios
 *
 * Splits content into blocks and memoizes each block separately,
 * so only new/changed blocks re-render during streaming.
 */
export const MemoizedMarkdown = React.memo(
  Markdown,
  (prevProps, nextProps) => {
    // If id is provided, use it for memoization
    if (prevProps.id && nextProps.id) {
      return (
        prevProps.id === nextProps.id &&
        prevProps.children === nextProps.children &&
        prevProps.mode === nextProps.mode &&
        prevProps.disablePreviewBlocks === nextProps.disablePreviewBlocks
      )
    }
    // Otherwise compare content and mode
    return (
      prevProps.children === nextProps.children &&
      prevProps.mode === nextProps.mode &&
      prevProps.disablePreviewBlocks === nextProps.disablePreviewBlocks
    )
  }
)
MemoizedMarkdown.displayName = 'MemoizedMarkdown'

// Re-export for convenience
