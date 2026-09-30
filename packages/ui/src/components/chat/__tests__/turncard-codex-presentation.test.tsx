import * as React from 'react'
import { beforeAll, describe, expect, it, mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { ActivityItem } from '../TurnCard'

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
    lng: 'en',
    fallbackLng: 'en',
    resources: {
      en: {
        translation: {
          'common.copy': 'Copy',
          'common.copied': 'Copied',
          'common.viewFullscreen': 'View fullscreen',
          'chat.branchOptions': 'Branch options',
          'chat.branch': 'Branch',
        },
      },
    },
    interpolation: { escapeValue: false },
  })
})

function completedActivity(): ActivityItem {
  return {
    id: 'read-1',
    type: 'tool',
    status: 'completed',
    toolName: 'Read',
    timestamp: 1,
  }
}

describe('TurnCard Codex presentation', () => {
  it('keeps the default response card when presentation is omitted', () => {
    const html = renderToStaticMarkup(React.createElement(TurnCard, {
      turnId: 'default-card',
      activities: [],
      response: { text: 'A normal response.', isStreaming: false },
      isStreaming: false,
      isComplete: true,
      renderActionsMenu: () => null,
    }))

    expect(html).toContain('bg-background shadow-minimal rounded-[8px]')
    expect(html).not.toContain('data-response-presentation="codex"')
  })

  it('renders ordinary responses inline with a compact, informative activity disclosure', () => {
    const html = renderToStaticMarkup(React.createElement(TurnCard, {
      turnId: 'codex-inline',
      activities: [completedActivity()],
      response: { text: 'A response that stays in the conversation flow.', isStreaming: false, messageId: 'response-1' },
      isStreaming: false,
      isComplete: true,
      isExpanded: true,
      displayMode: 'informative',
      presentation: 'codex',
      onPopOut: () => undefined,
      onBranch: () => undefined,
      renderActionsMenu: () => null,
    }))

    expect(html).toContain('data-turncard-presentation="codex"')
    expect(html).toContain('data-activity-presentation="codex"')
    expect(html).toContain('Worked · 1 step')
    expect(html).toContain('data-response-presentation="codex"')
    expect(html).toContain('data-response-content="inline"')
    expect(html).toContain('data-turncard-actions="codex"')
    expect(html).toContain('aria-label="Copy"')
    expect(html).toContain('aria-label="Markdown"')
    expect(html).toContain('aria-label="Branch options"')
    expect(html).toContain('title="View fullscreen"')
    expect(html).not.toContain('max-height:540px')
    expect(html).not.toContain('overflow-y-auto')
  })

  it('keeps an already-visible streaming response inline', () => {
    const html = renderToStaticMarkup(React.createElement(TurnCard, {
      turnId: 'codex-streaming',
      activities: [],
      response: {
        text: Array.from({ length: 60 }, () => 'streaming').join(' '),
        isStreaming: true,
        streamStartTime: 1,
      },
      isStreaming: true,
      isComplete: false,
      presentation: 'codex',
      renderActionsMenu: () => null,
    }))

    expect(html).toContain('data-response-presentation="codex"')
    expect(html).toContain('data-response-content="inline"')
    expect(html).toContain('Streaming...')
    expect(html).not.toContain('max-height:540px')
    expect(html).not.toContain('overflow-y-auto')
  })

  it('keeps plans in their existing card treatment', () => {
    const html = renderToStaticMarkup(React.createElement(TurnCard, {
      turnId: 'codex-plan',
      activities: [],
      response: { text: '1. Verify the result.', isStreaming: false, isPlan: true },
      isStreaming: false,
      isComplete: true,
      presentation: 'codex',
      renderActionsMenu: () => null,
    }))

    expect(html).toContain('bg-background shadow-minimal rounded-[8px]')
    expect(html).not.toContain('data-response-presentation="codex"')
    expect(html).not.toContain('data-response-content="inline"')
  })
})
