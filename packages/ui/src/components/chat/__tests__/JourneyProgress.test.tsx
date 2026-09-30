import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { JourneyProgress, JourneyOutcome } from '../JourneyProgress'

const i18n = createInstance()
await i18n.init({ lng: 'fr', resources: { fr: { translation: {
  'chat.journey.running': 'En cours',
  'chat.journey.waiting': 'En attente de votre réponse',
  'chat.journey.waitingDescription': 'Une réponse de votre part est nécessaire pour continuer.',
  'chat.journey.activity.steps': 'Étapes terminées : {{completed}}/{{total}}',
  'chat.journey.activity.unavailable': 'En attente de la prochaine activité de l’agent.',
  'chat.journey.agentsRunning': 'Agents en cours : {{count}}',
  'chat.journey.agentActivityUnavailable': 'Aucun détail récent disponible.',
  'chat.journey.parentPlan': 'Plan de la demande principale',
  'chat.journey.validationGaps.title': 'Validation à compléter',
  'chat.journey.validationGaps.description': 'Ces points n’ont pas pu être validés. Les résultats déjà obtenus sont conservés.',
  'common.retry': 'Réessayer',
} } } })
const render = (
  progress: React.ComponentProps<typeof JourneyProgress>['progress'],
  agents?: React.ComponentProps<typeof JourneyProgress>['agents'],
  presentation?: React.ComponentProps<typeof JourneyProgress>['presentation'],
) => renderToStaticMarkup(
  <I18nextProvider i18n={i18n}><JourneyProgress progress={progress} agents={agents} {...(presentation ? { presentation } : {})} /></I18nextProvider>,
)

describe('concrete journey progress', () => {
  it('makes the host validation reasons readable and retains a single honest retry action', () => {
    const html = renderToStaticMarkup(<I18nextProvider i18n={i18n}><JourneyOutcome outcome={{
      objectiveText: 'Préparer le rapport.', state: 'failed', remainingWork: [], hasFinalResponse: true,
      validationGaps: ['criterion lacks observed evidence: relevant-checks-passed'], retryUserMessageId: 'u1',
    }} onRetry={() => {}} /></I18nextProvider>)
    expect(html).toContain('Validation à compléter')
    expect(html).toContain('criterion lacks observed evidence: relevant-checks-passed')
    expect(html).toContain('data-outcome="failed"')
    expect(html.match(/<button/g)).toHaveLength(1)
    expect(html).toContain('Réessayer')
    expect(html).not.toContain('Vérifier à nouveau')
  })

  it('renders observed work and known counts without replacing it with a canned phase', () => {
    const html = render({ state: 'running', phase: 'working', steps: [], activity: {
      title: 'Vérification des totaux du rapport', detail: 'Comparer les factures de septembre',
      source: 'plan', completedSteps: 1, totalSteps: 3,
    } })
    expect(html).toContain('Vérification des totaux du rapport')
    expect(html).toContain('Comparer les factures de septembre')
    expect(html).toContain('Étapes terminées : 1/3')
    expect(html).not.toContain('chat.journey.phase')
    expect(html).toContain('aria-live="polite"')
  })

  it('shows an honest absence of detail without inventing a step or progress percentage', () => {
    const html = render({ state: 'running', phase: 'checking', steps: [] })
    expect(html).toContain('En attente de la prochaine activité de l’agent.')
    expect(html).not.toContain('journey-step-count')
    expect(html).not.toContain('vérifie')
    expect(html).not.toContain('%')
  })

  it('keeps the real request for user input distinct from running work', () => {
    const html = render({ state: 'waiting', phase: 'working', steps: [], activity: {
      title: 'Ancienne lecture', completedSteps: 0, totalSteps: 0,
    } })
    expect(html).toContain('En attente de votre réponse')
    expect(html).toContain('aria-busy="false"')
    expect(html).not.toContain('Ancienne lecture')
  })

  it('shows current child work with its name and keeps the parent plan separately identified', () => {
    const html = render({ state: 'running', phase: 'working',
      steps: [{ content: 'Préparer la synthèse globale', status: 'in_progress' }],
      activity: { title: 'Ancien commentaire principal', completedSteps: 0, totalSteps: 1 },
    }, { activeCount: 2, latest: { sessionName: 'Analyse des lecteurs', activity: {
      title: 'Je compare les résultats de septembre.', detail: 'Lecture des statistiques',
      completedSteps: 0, totalSteps: 0, source: 'commentary',
    } } })
    for (const text of ['Agents en cours : 2', 'Analyse des lecteurs', 'Je compare les résultats de septembre.',
      'Lecture des statistiques', 'Plan de la demande principale', 'Préparer la synthèse globale']) expect(html).toContain(text)
    expect(html).not.toContain('Ancien commentaire principal')
    expect(html).not.toContain('Étapes terminées : 0/1')
  })

  it('keeps a pending child question visible while another child performs observed work', () => {
    const html = render({ state: 'waiting', phase: 'working', steps: [] }, { activeCount: 1,
      latest: { sessionName: 'Vérification des factures', activity: { title: 'Comparer les montants de septembre',
        source: 'tool', completedSteps: 0, totalSteps: 0 } } })
    expect(html).toContain('En attente de votre réponse')
    expect(html).toContain('Une réponse de votre part est nécessaire pour continuer.')
    expect(html).toContain('Agents en cours : 1')
    expect(html).toContain('Vérification des factures')
    expect(html).toContain('Comparer les montants de septembre')
    expect(html).toContain('aria-busy="true"')
  })

  it('does not reuse the old parent activity when active child detail is unavailable', () => {
    const html = render({ state: 'running', phase: 'working', steps: [],
      activity: { title: 'Ancien commentaire principal', completedSteps: 0, totalSteps: 0 },
    }, { activeCount: 1, latest: { sessionName: 'Analyse des documents', activity: { completedSteps: 0, totalSteps: 0 } } })
    expect(html).toContain('Agents en cours : 1')
    expect(html).toContain('Analyse des documents')
    expect(html).toContain('Aucun détail récent disponible.')
    expect(html).not.toContain('Ancien commentaire principal')
  })

  it('keeps the default surface unchanged and makes the Codex summary a closed native disclosure', () => {
    const progress = { state: 'running' as const, phase: 'working' as const, steps: [], activity: {
      title: 'Vérification des totaux du rapport',
      detail: '{"command":"do not render raw tool input"}',
      source: 'tool' as const,
      completedSteps: 0,
      totalSteps: 0,
    } }
    const defaultHtml = render(progress)
    const codexHtml = render(progress, undefined, 'codex')

    expect(defaultHtml).not.toContain('<details')
    expect(defaultHtml).not.toContain('data-journey-presentation="codex"')
    expect(defaultHtml).toContain('class="px-3 py-4"')
    expect(codexHtml).toContain('data-journey-presentation="codex"')
    expect(codexHtml).toContain('<details')
    expect(codexHtml).toContain('<summary')
    expect(codexHtml).not.toContain('<details open')
    expect(codexHtml).toContain('Vérification des totaux du rapport')
    expect(codexHtml).not.toContain('do not render raw tool input')
  })

  it('retains waiting and delegated-agent status inside the Codex disclosure', () => {
    const html = render({ state: 'waiting', phase: 'working', steps: [] }, {
      activeCount: 1,
      latest: {
        sessionName: 'Vérification des factures',
        activity: { title: 'Comparer les totaux validés', completedSteps: 0, totalSteps: 0, source: 'commentary' },
      },
    }, 'codex')

    for (const text of ['En attente de votre réponse', 'Une réponse de votre part est nécessaire pour continuer.',
      'Agents en cours : 1', 'Vérification des factures', 'Comparer les totaux validés']) expect(html).toContain(text)
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('data-testid="journey-progress-disclosure"')
  })
})

it('renders every checklist state openly and updates the completed count', () => {
  const html = render({ state: 'running', phase: 'working', steps: [
    { content: 'Collecter les factures', status: 'completed' },
    { content: 'Vérifier les totaux', activeForm: 'Vérification des totaux', status: 'in_progress' },
    { content: 'Livrer le rapport', status: 'pending' },
  ] })
  expect(html).toContain('Étapes terminées : 1/3')
  for (const status of ['completed', 'in_progress', 'pending']) expect(html).toContain(`data-plan-status="${status}"`)
  expect(html).toContain('Vérification des totaux')
  expect(html).toContain('Livrer le rapport')
  expect(html).not.toContain('<details')
})
