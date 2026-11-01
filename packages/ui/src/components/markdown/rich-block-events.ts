import type {} from '@tiptap/core'

declare module '@tiptap/core' {
  interface EditorEvents {
    richBlockEdit: []
    inlineMathEdit: []
  }
}

export const RICH_BLOCK_EDIT_EVENT = 'richBlockEdit'
