import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import fr from '../../../../../../../packages/shared/src/i18n/locales/fr.json'
import { PermissionRecoveryCard } from '../PermissionRecoveryCard'

const i18n = createInstance()
await i18n.init({ lng: 'fr', resources: { fr: { translation: fr } } })

describe('permission recovery presentation', () => {
  it('asks to resume for a fresh permission request, with one action and no approval payload', () => {
    const html = renderToStaticMarkup(<Provider store={createStore()}><I18nextProvider i18n={i18n}>
      <PermissionRecoveryCard showSessionName request={{ sessionId: 'child-private-id', sessionName: 'Relecture du rapport',
        requestId: 'old-permission-id', userMessageId: 'accepted-user-id' }} />
    </I18nextProvider></Provider>)
    expect(html).toContain('Autorisation à redemander')
    expect(html).toContain('nouvelle demande d’autorisation')
    expect(html).toContain('Relecture du rapport')
    expect(html).toContain('Reprendre la tâche')
    expect(html.match(/<button/g)).toHaveLength(1)
    expect(html).not.toContain('old-permission-id')
    expect(html).not.toContain('accepted-user-id')
    expect(html).not.toContain('child-private-id')
    expect(html).not.toContain('<textarea')
  })
})
