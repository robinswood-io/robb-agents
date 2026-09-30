import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { JourneyOutcome } from '../JourneyProgress'
import type { ConversationOutcome } from '../conversation-presentation'

const i18n = createInstance()
await i18n.init({ lng: 'fr', resources: { fr: { translation: {
  'common.retry': 'Réessayer', 'common.retrying': 'Nouvelle tentative…',
} } } })
const outcome: ConversationOutcome = {
  objectiveText: 'Préparer le rapport', state: 'interrupted', hasFinalResponse: false,
  remainingWork: [], retryUserMessageId: 'original-user-request',
}
const render = (props: React.ComponentProps<typeof JourneyOutcome>) => renderToStaticMarkup(
  <I18nextProvider i18n={i18n}><JourneyOutcome {...props} /></I18nextProvider>,
)

describe('interrupted request retry button', () => {
  it('renders one explicit button for the existing request', () => {
    const html = render({ outcome, onRetry: () => {} })
    expect(html).toContain('data-testid="retry-interrupted-request"')
    expect(html.match(/<button/g)).toHaveLength(1)
    expect(html).toContain('Réessayer')
    expect(html).not.toContain('<textarea')
    expect(html).not.toContain('original-user-request')
  })

  it('disables retry until the host acknowledges the command', () => {
    const html = render({ outcome, onRetry: () => {}, retrying: true })
    expect(html).toContain('disabled=""')
    expect(html).toContain('Nouvelle tentative…')
  })

  it('omits retry for a resolved request or an unavailable command handler', () => {
    expect(render({ outcome })).not.toContain('<button')
    expect(render({ outcome: { ...outcome, state: 'succeeded', retryUserMessageId: undefined }, onRetry: () => {} }))
      .not.toContain('<button')
  })
})
