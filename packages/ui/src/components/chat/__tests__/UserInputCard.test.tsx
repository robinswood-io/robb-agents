import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import type { UserInputRequest } from '@craft-agent/core/types'
import { UserInputCard, answersFromUserInputDrafts, userInputAnswersComplete } from '../UserInputCard'

const request: UserInputRequest = {
  id: 'request-1', sessionId: 'child-1', originWorkspaceId: 'workspace-1', status: 'pending', createdAt: 1,
  questions: [{ id: 'audience', question: 'Quels lecteurs ?', options: [{ id: 'existing', label: 'Lecteurs actuels', recommended: true }, { id: 'new', label: 'Nouveaux lecteurs' }] }],
}
const i18n = createInstance()
await i18n.init({ lng: 'fr', resources: { fr: { translation: {} } } })
const render = (node: React.ReactNode) => renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>)

describe('user input card', () => {
  it('uses explicit native choices without preselecting the recommendation', () => {
    const html = render(<UserInputCard request={request} onRespond={async () => ({ status: 'accepted' })} />)
    expect(html).toContain('<fieldset')
    expect(html).toContain('<legend')
    expect(html.match(/type="radio"/g)).toHaveLength(2)
    expect(html).not.toContain(' checked')
    expect(html).toContain('<textarea')
    expect(html).toContain('type="submit"')
    expect(html).not.toContain('child-1')
  })

  it('accepts free text alone and enforces single/multiple choices through the shared validator', () => {
    expect(userInputAnswersComplete(request, [{ questionId: 'audience', optionIds: [], text: 'Les libraires indépendants' }])).toBe(true)
    expect(userInputAnswersComplete(request, [{ questionId: 'audience', optionIds: [], text: '  ' }])).toBe(false)
    const both = [{ questionId: 'audience', optionIds: ['existing', 'new'] }]
    expect(userInputAnswersComplete(request, both)).toBe(false)
    expect(userInputAnswersComplete({ ...request, questions: [{ ...request.questions[0]!, multiSelect: true }] }, both)).toBe(true)
    expect(userInputAnswersComplete(request, [{ questionId: 'audience', optionIds: ['unknown'] }])).toBe(false)
  })

  it('does not attach a recommended choice to free text or an unanswered question', () => {
    const freeText = answersFromUserInputDrafts(request, {
      audience: { questionId: 'audience', optionIds: [], text: 'scotland-ai-executive-day-20260930' },
    })
    expect(freeText).toEqual([{ questionId: 'audience', optionIds: [], text: 'scotland-ai-executive-day-20260930' }])
    expect(userInputAnswersComplete(request, freeText)).toBe(true)
    expect(userInputAnswersComplete(request, answersFromUserInputDrafts(request, {}))).toBe(false)

    const clarification = answersFromUserInputDrafts(request, {
      audience: { questionId: 'audience', optionIds: ['new'], text: '  Avec un contact direct  ' },
    })
    expect(clarification).toEqual([{ questionId: 'audience', optionIds: ['new'], text: 'Avec un contact direct' }])
  })

  it('shows acknowledged answers collapsed, with no remaining form controls', () => {
    const html = render(<UserInputCard request={{ ...request, status: 'answered', answers: [{ questionId: 'audience', optionIds: ['existing'], text: 'Une invitation personnelle.' }] }} />)
    expect(html).toContain('<details')
    expect(html).not.toContain(' open=')
    expect(html).toContain('Lecteurs actuels')
    expect(html).toContain('Une invitation personnelle.')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('<input')
  })

  it('preserves a pending question in readonly exports without response controls', () => {
    const html = render(<UserInputCard request={request} readOnly />)
    expect(html).toContain('Quels lecteurs ?')
    expect(html).toContain('disabled')
    expect(html).not.toContain('type="submit"')
  })
})
