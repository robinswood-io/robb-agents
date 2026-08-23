import React from 'react'
import ReactDOM from 'react-dom/client'
import { Provider as JotaiProvider, useAtomValue } from 'jotai'
import App from './App'
import { ThemeProvider } from '@/context/ThemeContext'
import { windowWorkspaceIdAtom } from '@/atoms/sessions'
import { Toaster } from '@/components/ui/sonner'
import { setupI18n } from '@craft-agent/shared/i18n'
import { initReactI18next } from 'react-i18next'
import { useTranslation } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { registerPwa } from './pwa-registration'
import './index.css'

// Initialize i18n before any React rendering
const i18n = setupI18n([LanguageDetector, initReactI18next])
const syncDocumentLanguage = () => {
  document.documentElement.lang = i18n.resolvedLanguage ?? i18n.language ?? 'fr'
}
syncDocumentLanguage()
i18n.on('languageChanged', syncDocumentLanguage)

// Register immediately so the lightweight shell can be warmed before the
// Electron renderer's large lazy chunks are requested. The PWA cache never
// stores API, WebSocket, conversation, file, or credential responses.
void registerPwa()

function CrashFallback() {
  const { t } = useTranslation()
  return (
    <main className="flex h-[100dvh] flex-col items-center justify-center gap-3 overflow-y-auto p-6 font-sans text-foreground/60">
      <p className="text-base font-medium">{t('auth.somethingWentWrong')}</p>
      <p className="text-center text-[13px]">{t('errors.pleaseReload')}</p>
      <button
        onClick={() => window.location.reload()}
        className="mt-2 min-h-11 cursor-pointer rounded-xl bg-background px-5 py-2 shadow-minimal text-[13px] text-foreground/80"
      >
        {t('common.reload')}
      </button>
    </main>
  )
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: unknown): void {
    console.error('[webui] Renderer crashed', error instanceof Error ? error.name : 'UnknownError')
  }

  render(): React.ReactNode {
    return this.state.failed ? <CrashFallback /> : this.props.children
  }
}

function Root() {
  const workspaceId = useAtomValue(windowWorkspaceIdAtom)

  return (
    <ThemeProvider activeWorkspaceId={workspaceId} defaultColorTheme="robinswood">
      <App />
      <Toaster />
    </ThemeProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <JotaiProvider>
        <Root />
      </JotaiProvider>
    </ErrorBoundary>
  </React.StrictMode>,
)
