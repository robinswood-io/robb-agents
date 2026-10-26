import { expect, it } from 'bun:test'
import { Fragment, Schema } from '@tiptap/pm/model'
import { Transform } from '@tiptap/pm/transform'
import { Fragment as MarkdownFragment } from 'prosemirror-model'
import { Transform as MarkdownTransform } from 'prosemirror-transform'

it('accepts Markdown fragments and editing steps in the native Tiptap document', () => {
  const schema = new Schema({
    nodes: { doc: { content: 'text*' }, text: { group: 'inline' } },
  })
  // Separate module copies used to throw here on an ordinary editor input.
  const document = schema.node('doc', null, MarkdownFragment.from(schema.text('QA')))
  expect(document.textContent).toBe('QA')

  const inserted = new MarkdownTransform(document).insert(2, schema.text('!')).doc
  expect(inserted.textContent).toBe('QA!')
  expect(new Transform(inserted).delete(2, 3).doc.textContent).toBe('QA')
  expect(MarkdownFragment.empty).toBe(Fragment.empty)
})
