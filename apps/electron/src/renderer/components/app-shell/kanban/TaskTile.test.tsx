import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { TaskTile } from './TaskTile'
import type { KanbanTask } from './types'

const i18n = createInstance()
await i18n.init({ lng: 'en', resources: { en: { translation: {} } } })

function renderTile(props: React.ComponentProps<typeof TaskTile>): string {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}><TaskTile {...props} /></I18nextProvider>)
}

const task: KanbanTask = {
  id: 'user-task',
  title: 'Préparer le dossier client',
  column: 'in-progress',
  statusId: 'in-progress',
  model: 'claude-sonnet-4-6',
  subtasks: [
    { id: 'child-a', sessionId: 'child-a', title: 'Internal research agent', model: 'claude-haiku-4-5', runState: 'done' },
    { id: 'child-b', sessionId: 'child-b', title: 'Internal checking agent', model: 'claude-opus-4-6', runState: 'running' },
  ],
}

describe('TaskTile conversation visibility', () => {
  it('shows task progress without agent chats or model details, even for a saved expanded tile', () => {
    const html = renderTile({ task, treatment: 'stripe', expanded: true, onSubtaskClick: () => {}, onAddSubtask: () => {} })
    expect(html).toContain('Préparer le dossier client')
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('aria-valuenow="1"')
    expect(html).toContain('aria-valuemax="2"')
    expect(html).not.toContain('Internal research agent')
    expect(html).not.toContain('Internal checking agent')
    expect(html).not.toContain('claude-')
    expect(html).not.toContain('kanban.addSubtask')
  })

  it('keeps independent user tasks visible when they have no delegated sessions', () => {
    const html = renderTile({ task: { ...task, title: 'Envoyer le dossier', subtasks: [] }, treatment: 'stripe', expanded: false })
    expect(html).toContain('Envoyer le dossier')
    expect(html).not.toContain('role="progressbar"')
  })
})
