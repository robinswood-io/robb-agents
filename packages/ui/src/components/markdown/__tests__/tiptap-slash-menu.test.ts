import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { afterEach } from 'bun:test';
const editors: Editor[] = [];
afterEach(() => { for (const editor of editors.splice(0)) editor.destroy(); });
import { describe, it, expect } from 'bun:test'
import { createSlashCommandItems, filterSlashCommandItems } from '../TiptapSlashMenu'
import { RICH_BLOCK_EDIT_EVENT } from '../rich-block-events'

function createMockEditor() {
  const calls: string[] = []
  const editor = new Editor({ element: null, extensions: [StarterKit],
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Fixture content for slash commands.' }] }] },
  })
  editors.push(editor)
  const state = EditorState.create({ schema: editor.schema, doc: editor.state.doc,
    selection: TextSelection.create(editor.state.doc, 5) })
  Object.defineProperty(editor, 'state', { get: () => state })
  const chainApi = editor.chain()
  Object.assign(chainApi, ({
    focus: () => {
      calls.push('focus')
      return chainApi
    },
    setParagraph: () => {
      calls.push('setParagraph')
      return chainApi
    },
    toggleHeading: ({ level }: { level: number }) => {
      calls.push(`toggleHeading:${level}`)
      return chainApi
    },
    toggleBulletList: () => {
      calls.push('toggleBulletList')
      return chainApi
    },
    toggleOrderedList: () => {
      calls.push('toggleOrderedList')
      return chainApi
    },
    toggleTaskList: () => {
      calls.push('toggleTaskList')
      return chainApi
    },
    setBlockquote: () => {
      calls.push('setBlockquote')
      return chainApi
    },
    setHorizontalRule: () => {
      calls.push('setHorizontalRule')
      return chainApi
    },
    setCodeBlock: (attributes) => {
      calls.push(`setCodeBlock:${attributes?.language}`)
      return chainApi
    },
    insertContent: (payload: unknown) => {
      calls.push(`insertContent:${JSON.stringify(payload)}`)
      return chainApi
    },
    insertContentAt: (pos, payload) => {
      calls.push(`insertContentAt:${pos}:${JSON.stringify(payload)}`)
      return chainApi
    },
    setTextSelection: (selection: number | { from: number; to: number }) => {
      calls.push(`setTextSelection:${JSON.stringify(selection)}`)
      return chainApi
    },
    setNodeSelection: (pos: number) => {
      calls.push(`setNodeSelection:${pos}`)
      return chainApi
    },
    run: () => {
      calls.push('run')
      return true
    },
  } satisfies Partial<ReturnType<Editor['chain']>>))
  const can = editor.can()
  can.setCodeBlock = () => true
  editor.can = () => can
  editor.isActive = () => false
  editor.getAttributes = () => ({})
  editor.chain = () => chainApi
  const nativeEmit = editor.emit.bind(editor)
  editor.emit = (event, ...args) => { calls.push('emit:' + event); return nativeEmit(event, ...args) }
  return { editor, calls }
}

describe('tiptap slash menu', () => {
  it('filters by title, description, and aliases', () => {
    const { editor } = createMockEditor()
    const items = createSlashCommandItems(editor)

    expect(filterSlashCommandItems(items, 'heading').some((item) => item.id === 'heading-1')).toBe(true)
    expect(filterSlashCommandItems(items, 'divider').some((item) => item.id === 'horizontal-rule')).toBe(true)
    expect(filterSlashCommandItems(items, 'flow').some((item) => item.id === 'mermaid-code-block')).toBe(true)
    expect(filterSlashCommandItems(items, 'checklist').some((item) => item.id === 'task-list')).toBe(true)
  })

  it('returns all items for empty query and includes icons', () => {
    const { editor } = createMockEditor()
    const items = createSlashCommandItems(editor)
    const filtered = filterSlashCommandItems(items, '   ')

    expect(filtered.length).toBe(items.length)
    expect(filtered.every((item) => item.icon.length > 0)).toBe(true)
    expect(filtered.some((item) => (item as { group: string }).group === 'Visual')).toBe(false)
  })

  it('maps commands to expected chain calls', async () => {
    const { editor, calls } = createMockEditor()
    const items = createSlashCommandItems(editor)

    const heading = items.find((item) => item.id === 'heading-1')
    heading?.run(editor)
    expect(calls.slice(-3)).toEqual(['focus', 'toggleHeading:1', 'run'])

    const code = items.find((item) => item.id === 'code-block')
    code?.run(editor)
    expect(calls).toContain('insertContentAt:5:{"type":"codeBlock","attrs":{"language":"plaintext"},"content":[{"type":"text","text":" "}]}')
    expect(calls).toContain('setTextSelection:{"from":6,"to":6}')

    const taskList = items.find((item) => item.id === 'task-list')
    taskList?.run(editor)
    expect(calls.slice(-3)).toEqual(['focus', 'toggleTaskList', 'run'])

    const quote = items.find((item) => item.id === 'blockquote')
    quote?.run(editor, 5)
    expect(calls.slice(-4)).toEqual(['focus', 'setTextSelection:5', 'setBlockquote', 'run'])
    expect(calls).not.toContain('toggleBlockquote')

    const mermaid = items.find((item) => item.id === 'mermaid-code-block')
    mermaid?.run(editor, 5)
    await Promise.resolve()

    expect(calls).toContain('insertContentAt:5:{"type":"mermaidBlock","attrs":{"code":"graph TD\\n  A[Start] --> B[End]"}}')
    expect(calls).toContain('setNodeSelection:5')
    expect(calls).toContain(`emit:${RICH_BLOCK_EDIT_EVENT}`)

    const latex = items.find((item) => item.id === 'latex-code-block')
    latex?.run(editor, 5)
    await Promise.resolve()

    expect(calls).toContain('insertContentAt:5:{"type":"latexBlock","attrs":{"code":"E = mc^2"}}')
  })
})
