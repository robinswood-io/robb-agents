import * as React from 'react';


import type { Editor } from '@tiptap/react';
import { NodeSelection } from '@tiptap/pm/state';

import { cn } from "../../lib/utils";



// ============================================================================
// Bubble menu toolbar button
// ============================================================================

export function BubbleButton({
  onClick,
  isActive,
  title,
  children,
}: {
  onClick: () => void
  isActive?: boolean
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'tiptap-bubble-btn',
        isActive && 'is-active',
      )}
    >
      {children}
    </button>
  )
}


// ============================================================================
// Code block edit bubble menu — edit popover for mermaid / latex blocks
// ============================================================================

export const VISUAL_LANGUAGES = new Set(['mermaid', 'latex', 'math', 'tex', 'katex'])


export function getEditableBlockMeta(editor: Editor): { label: string; code: string; update: (next: string) => void } | null {
  const { selection } = editor.state

  if (selection instanceof NodeSelection) {
    const node = selection.node
    const pos = selection.from

    if (node.type.name === 'mermaidBlock') {
      return {
        label: 'Mermaid',
        code: String(node.attrs.code ?? ''),
        update: (next) => {
          editor.chain().focus().setNodeSelection(pos).updateAttributes('mermaidBlock', { code: next }).run()
        },
      }
    }

    if (node.type.name === 'latexBlock') {
      return {
        label: 'LaTeX',
        code: String(node.attrs.code ?? ''),
        update: (next) => {
          editor.chain().focus().setNodeSelection(pos).updateAttributes('latexBlock', { code: next }).run()
        },
      }
    }

    return null
  }

  // Legacy fallback while old docs/code paths still contain codeBlock language variants.
  const { $from } = selection
  for (let depth = $from.depth; depth >= 0; depth--) {
    const node = $from.node(depth)
    if (node.type.name !== 'codeBlock') continue

    const lang = (node.attrs.language as string | undefined)?.toLowerCase() ?? ''
    if (!VISUAL_LANGUAGES.has(lang)) return null

    const label = lang === 'mermaid' ? 'Mermaid' : 'LaTeX'
    const pos = $from.before(depth)

    return {
      label,
      code: node.textContent,
      update: (next) => {
        const tr = editor.state.tr.replaceWith(
          pos + 1,
          pos + node.nodeSize - 1,
          next.length > 0 ? editor.schema.text(next) : editor.schema.text(' '),
        )
        editor.view.dispatch(tr)
      },
    }
  }

  return null
}
