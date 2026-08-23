import { beforeAll, describe, expect, it, mock } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'

mock.module('@craft-agent/ui', () => ({
  Spinner: ({ className }: { className?: string }) => <span className={className} />,
}))

let BackButton: typeof import('./primitives').BackButton
let ContinueButton: typeof import('./primitives').ContinueButton

const i18n = createInstance()

beforeAll(async () => {
  ;({ BackButton, ContinueButton } = await import('./primitives'))
  await i18n.use(initReactI18next).init({
    lng: 'fr',
    fallbackLng: 'en',
    resources: {
      fr: {
        translation: {
          common: {
            back: 'Retour',
            continue: 'Continuer',
            loading: 'Chargement...',
          },
        },
      },
    },
    interpolation: { escapeValue: false },
  })
})

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>{node}</I18nextProvider>,
  )
}

describe('onboarding navigation buttons', () => {
  it('localizes default labels', () => {
    expect(render(<BackButton />)).toContain('Retour')
    expect(render(<ContinueButton />)).toContain('Continuer')
    expect(render(<ContinueButton loading />)).toContain('Chargement...')
  })

  it('preserves explicit labels', () => {
    expect(render(<BackButton>Annuler</BackButton>)).toContain('Annuler')
    expect(render(<ContinueButton>Connexion</ContinueButton>)).toContain('Connexion')
    expect(render(<ContinueButton loading loadingText="Connexion..." />)).toContain('Connexion...')
  })
})
