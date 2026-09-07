import * as React from 'react'
import { beforeAll, describe, expect, it, mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { Message } from '@craft-agent/core'
import type { ActivityItem } from '../TurnCard'
import {
  formatActivityAsMarkdown,
  getActivitySummary,
  groupMessagesByTurn,
  type AssistantTurn,
} from '../turn-utils'

const checkpoint = {
  schemaVersion: 1 as const,
  kind: 'tool-call-budget' as const,
  reason: 'Edit was not started before the safety lease expired.',
}

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('react-pdf', () => ({
  Document: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } },
}))

let TurnCard: typeof import('../TurnCard')['TurnCard']

beforeAll(async () => {
  ;({ TurnCard } = await import('../TurnCard'))
  await i18n.use(initReactI18next).init({
    lng: 'fr',
    fallbackLng: 'en',
    resources: {
      fr: { translation: { 'turnCard.notExecutedAutoResume': 'Non exécuté — reprise automatique' } },
      en: { translation: { 'turnCard.notExecutedAutoResume': 'Not executed — automatic recovery' } },
    },
    interpolation: { escapeValue: false },
  })
})

function checkpointActivity(): ActivityItem {
  return {
    id: 'tool-checkpoint',
    type: 'tool',
    status: 'checkpoint',
    toolName: 'Edit',
    toolUseId: 'edit-1',
    toolInput: {
      file_path: '/tmp/example.ts',
      old_string: 'before',
      new_string: 'after',
    },
    content: checkpoint.reason,
    executed: false,
    checkpoint,
    timestamp: 2,
  }
}

describe('tool checkpoint presentation', () => {
  it('maps persisted non-execution truth to a neutral checkpoint activity', () => {
    const messages: Message[] = [{
      id: 'user-1',
      role: 'user',
      content: 'Apply the edit.',
      timestamp: 1,
    }, {
      id: 'tool-checkpoint',
      role: 'tool',
      content: '',
      timestamp: 2,
      toolName: 'Edit',
      toolUseId: 'edit-1',
      toolResult: checkpoint.reason,
      toolStatus: 'completed',
      isError: false,
      toolExecuted: false,
      toolCheckpoint: checkpoint,
    }]

    const turn = groupMessagesByTurn(messages).find(item => item.type === 'assistant') as AssistantTurn
    expect(turn.activities[0]).toMatchObject({
      status: 'checkpoint',
      executed: false,
      checkpoint,
    })
    expect(getActivitySummary(turn)).toBe('1 not executed')
    expect(formatActivityAsMarkdown(turn.activities[0]!)).toContain('Non exécuté — reprise automatique')
  })

  it('renders the explicit recovery label and no green success treatment', () => {
    const html = renderToStaticMarkup(React.createElement(TurnCard, {
      turnId: 'turn-checkpoint',
      activities: [checkpointActivity()],
      isStreaming: false,
      isComplete: false,
      isExpanded: true,
      renderActionsMenu: () => null,
    }))

    expect(html).toContain('Non exécuté — reprise automatique')
    expect(html).toContain('data-tool-execution="checkpoint"')
    expect(html).not.toContain('text-success')
  })
})
